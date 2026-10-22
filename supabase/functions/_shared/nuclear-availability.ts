/** Announced SE3 nuclear capacity. This is not a dispatch forecast. */
import JSZip from "npm:jszip@3.10.1";
import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";

const HOUR = 3_600_000;
const XML_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
const SE3 = "10Y1001A1001A46L";
type Xml = Record<string, unknown>;
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function object(value: unknown): Xml {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed nuclear XML element");
  return value as Xml;
}
function text(value: unknown): string {
  if (value && typeof value === "object" && "#text" in value) value = value["#text"];
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing nuclear XML field");
  return value.trim();
}
function optional(value: unknown): string | null { return value === undefined ? null : text(value); }
function number(value: unknown): number {
  const result = Number(text(value));
  if (!Number.isFinite(result)) throw new Error("Invalid nuclear XML number");
  return result;
}
function timestamp(value: unknown): number {
  const s = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(s)) throw new Error("Invalid nuclear XML timestamp");
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== s.slice(0, 16)) throw new Error("Invalid nuclear XML timestamp");
  return ms;
}
function preflightZip(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw new Error("Unsupported nuclear ZIP directory");
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (count >= 200) throw new Error("Nuclear ZIP may be truncated at the provider document limit");
  if (view.getUint16(end + 8, true) !== count || offset + size > end) throw new Error("Invalid nuclear ZIP directory");
  let cursor = offset, total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Invalid nuclear ZIP member");
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    if (flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || expanded > XML_LIMIT || view.getUint32(cursor + 42, true) === 0xffffffff) throw new Error("Unsupported or oversized nuclear ZIP member");
    if (cursor + 46 + nameLength + extraLength + commentLength > offset + size) throw new Error("Invalid nuclear ZIP filename");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name.endsWith(".xml") || name.startsWith("/") || name.split("/").includes("..") || names.has(name)) throw new Error("Unsupported nuclear ZIP filename");
    names.add(name); total += expanded;
    if (total > TOTAL_LIMIT) throw new Error("Nuclear ZIP exceeds total expanded size limit");
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== offset + size) throw new Error("Invalid nuclear ZIP central directory size");
  return count;
}
async function xmlBodies(bytes: Uint8Array): Promise<string[]> {
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === 0x04034b50) {
    const expectedCount = preflightZip(bytes);
    const zip = await JSZip.loadAsync(bytes);
    const members = Object.values(zip.files);
    if (members.length !== expectedCount) throw new Error("Nuclear ZIP member count mismatch");
    let total = 0;
    const bodies: string[] = [];
    for (const member of members) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        // JSZip 3.10.1 implements file.internalStream but omits it from its typings.
        const stream = (member as JSZip.JSZipObject & { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream("uint8array");
        stream.on("data", chunk => {
          size += chunk.length; total += chunk.length;
          if (size > XML_LIMIT || total > TOTAL_LIMIT) { stream.pause(); reject(new Error("Nuclear ZIP expanded size exceeds limit")); return; }
          chunks.push(chunk);
        }).on("error", reject).on("end", resolve).resume();
      });
      const body = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
      bodies.push(new TextDecoder("utf-8", { fatal: true }).decode(body));
    }
    return bodies;
  }
  if (bytes.length > XML_LIMIT) throw new Error("Nuclear XML exceeds size limit");
  return [new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
}
function parseXml(body: string): { root: string; document: Xml } {
  if (/<!DOCTYPE/i.test(body) || !body.trimStart().startsWith("<") || XMLValidator.validate(body) !== true) throw new Error("Malformed or unsupported nuclear XML");
  const parsed = object(new XMLParser({ removeNSPrefix: true, parseTagValue: false, trimValues: true, ignoreAttributes: false }).parse(body));
  const roots = Object.keys(parsed).filter(key => !key.startsWith("?"));
  if (roots.length !== 1) throw new Error("Expected one nuclear XML document");
  return { root: roots[0], document: object(parsed[roots[0]]) };
}
function noData(root: string, doc: Xml): boolean {
  if (root !== "Acknowledgement_MarketDocument") return false;
  const reasons = list(doc.Reason).map(value => object(value));
  if (reasons.length && reasons.every(reason => text(reason.code) === "999" && /no matching data found/i.test(text(reason.text)))) return true;
  throw new Error("Nuclear provider error acknowledgement");
}
export interface NuclearOutageNotice {
  id: string; revision: number; createdAt: string; status: string | null;
  documentType: "A77" | "A80"; productionId: string; generationId: string | null;
  name: string; psrType: string; nominalMw: number; businessType: string;
  startMs: number; endMs: number;
  periods: { startMs: number; endMs: number; availableMw: number }[];
}
export interface NuclearOutageDocument { documents: NuclearOutageNotice[] }
export interface NuclearProductionUnit {
  productionId: string; name: string;
  capacities: { startMs: number; endMs: number; mw: number }[];
}
export interface NuclearRoster { units: NuclearProductionUnit[] }

export async function parseNuclearOutages(bytes: Uint8Array): Promise<NuclearOutageDocument> {
  const documents: NuclearOutageNotice[] = [];
  for (const body of await xmlBodies(bytes)) {
    const { root, document: doc } = parseXml(body);
    if (noData(root, doc)) continue;
    if (root !== "Unavailability_MarketDocument") throw new Error("Unsupported nuclear outage document");
    const documentType = text(doc.type);
    if (documentType !== "A77" && documentType !== "A80") throw new Error("Expected nuclear production or generation outage");
    const revision = number(doc.revisionNumber);
    if (!Number.isInteger(revision) || revision < 1) throw new Error("Invalid nuclear outage revision");
    const createdAt = new Date(timestamp(doc.createdDateTime)).toISOString();
    if (!list(doc.TimeSeries).length) throw new Error("Nuclear outage has no representable unit; cancellation cannot be resolved");
    for (const raw of list(doc.TimeSeries)) {
      const series = object(raw);
      const psrType = text(series["production_RegisteredResource.pSRType.psrType"]);
      if (psrType !== "B14") continue;
      if (text(series["biddingZone_Domain.mRID"]) !== SE3 || text(series["quantity_Measure_Unit.name"]) !== "MAW") throw new Error("Nuclear outage is not SE3 MW");
      const generationId = optional(series["production_RegisteredResource.pSRType.powerSystemResources.mRID"]);
      const nominal = series["production_RegisteredResource.pSRType.powerSystemResources.nominalP"];
      if (nominal && typeof nominal === "object" && "@_unit" in nominal && nominal["@_unit"] !== "MAW") throw new Error("Nuclear nominal capacity is not MW");
      const nominalMw = number(nominal);
      const curve = text(series.curveType);
      if (!["A01", "A03"].includes(curve)) throw new Error("Unsupported nuclear outage curve");
      const periods: NuclearOutageNotice["periods"] = [];
      for (const rawPeriod of list(series.Available_Period)) {
        const period = object(rawPeriod), span = object(period.timeInterval);
        const start = timestamp(span.start), end = timestamp(span.end);
        const resolution = text(period.resolution), step = resolution === "PT1M" ? 60_000 : resolution === "PT15M" ? 900_000 : resolution === "PT60M" ? HOUR : null;
        if (step === null || end <= start) throw new Error("Unsupported nuclear outage interval");
        const points = list(period.Point).map(value => { const point = object(value); return { position: number(point.position), availableMw: number(point.quantity) }; }).sort((a, b) => a.position - b.position);
        for (let i = 0; i < points.length; i++) {
          const point = points[i], next = points[i + 1], startMs = start + (point.position - 1) * step;
          if (!Number.isInteger(point.position) || point.position < 1 || startMs >= end || point.position === next?.position) throw new Error("Invalid nuclear outage point");
          periods.push({ startMs, endMs: curve === "A03" ? next ? Math.min(end, start + (next.position - 1) * step) : end : Math.min(end, startMs + step), availableMw: point.availableMw });
        }
      }
      if (!periods.length) throw new Error("Nuclear outage has no available periods");
      const eventSpan = object(doc["unavailability_Time_Period.timeInterval"]);
      documents.push({ startMs: timestamp(eventSpan.start), endMs: timestamp(eventSpan.end), id: text(doc.mRID), revision, createdAt, status: doc.docStatus === undefined ? null : text(object(doc.docStatus).value),
        documentType, productionId: text(series["production_RegisteredResource.mRID"]), generationId,
        name: text(series["production_RegisteredResource.name"]), psrType, nominalMw, businessType: text(series.businessType), periods });
    }
  }
  return { documents };
}

export async function parseNuclearRoster(bytes: Uint8Array): Promise<NuclearRoster> {
  const units = new Map<string, NuclearProductionUnit>();
  for (const body of await xmlBodies(bytes)) {
    const { root, document: doc } = parseXml(body);
    if (noData(root, doc)) continue;
    if (root !== "GL_MarketDocument" || text(doc.type) !== "A71" || text(doc["process.processType"]) !== "A33") throw new Error("Expected installed nuclear units A71/A33");
    for (const raw of list(doc.TimeSeries)) {
      const series = object(raw);
      if (text(object(series.MktPSRType).psrType) !== "B14") continue;
      if (text(series["inBiddingZone_Domain.mRID"]) !== SE3 || text(series["quantity_Measure_Unit.name"]) !== "MAW" || text(series.objectAggregation) !== "A06") throw new Error("Nuclear roster is not SE3 production-unit MW");
      const productionId = text(series["registeredResource.mRID"]), name = text(series["registeredResource.name"]);
      const unit = units.get(productionId) ?? { productionId, name, capacities: [] };
      if (unit.name !== name) throw new Error("Conflicting nuclear production-unit names");
      for (const rawPeriod of list(series.Period)) {
        const period = object(rawPeriod), span = object(period.timeInterval), points = list(period.Point);
        if (text(period.resolution) !== "P1Y" || points.length !== 1 || number(object(points[0]).position) !== 1) throw new Error("Unsupported nuclear installed capacity period");
        const startMs = timestamp(span.start), endMs = timestamp(span.end), mw = number(object(points[0]).quantity);
        if (endMs <= startMs) throw new Error("Invalid nuclear installed capacity interval");
        const calendar = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
        for (const boundary of [startMs, endMs]) {
          const parts = Object.fromEntries(calendar.formatToParts(boundary).map(part => [part.type, part.value]));
          if (parts.month !== "01" || parts.day !== "01" || parts.hour !== "00" || parts.minute !== "00" || parts.second !== "00") throw new Error("Nuclear annual capacity must use Stockholm January boundaries");
        }
        const capacity = { startMs, endMs, mw };
        if (!unit.capacities.some(value => JSON.stringify(value) === JSON.stringify(capacity))) unit.capacities.push(capacity);
      }
      if (!unit.capacities.length) throw new Error("Missing nuclear installed capacity");
      units.set(productionId, unit);
    }
  }
  return { units: [...units.values()].sort((a, b) => a.productionId.localeCompare(b.productionId)) };
}

export type NuclearAvailability =
  | { status: "data"; anchorMw: number; targetMw: number; details: { operatingUnits: number; productionNotices: number; generationNotices: number; assumption: string } }
  | { status: "unavailable"; reason: string };
const OPERATING_REACTORS = ["forsmark1", "forsmark2", "forsmark3", "ringhals3", "ringhals4", "oskarshamn3"];
function reactorName(name: string): string { return name.toLowerCase().replace(/block/g, "").replace(/\s/g, ""); }
function unique(values: number[]): number | null { const distinct = [...new Set(values)]; return distinct.length === 1 ? distinct[0] : null; }
function latestNotices(document: NuclearOutageDocument, expectedType: "A77" | "A80"): NuclearOutageNotice[] {
  const latest = new Map<string, NuclearOutageNotice[]>();
  for (const notice of document.documents) {
    if (notice.documentType !== expectedType) throw new Error("Unexpected nuclear notice dataset");
    const prior = latest.get(notice.id);
    if (!prior || notice.revision > prior[0].revision) latest.set(notice.id, [notice]);
    else if (notice.revision === prior[0].revision) prior.push(notice);
  }
  const result: NuclearOutageNotice[] = [];
  for (const group of latest.values()) {
    const units = new Map<string, NuclearOutageNotice>();
    for (const notice of group) {
      const key = `${notice.productionId}/${notice.generationId ?? ""}`;
      const prior = units.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(notice)) throw new Error("Conflicting nuclear notice revision");
      units.set(key, notice);
    }
    for (const notice of units.values()) {
      if (["A09", "A13"].includes(notice.status ?? "")) continue;
      if (notice.status !== null && !["A01", "A02", "A05"].includes(notice.status)) throw new Error("Unsupported nuclear notice status");
      result.push(notice);
    }
  }
  return result;
}
function noticeValue(notice: NuclearOutageNotice, at: number): number | null {
  if (at < notice.startMs || at >= notice.endMs) return null;
  const values = notice.periods.filter(period => period.startMs <= at && period.endMs > at).map(period => period.availableMw);
  const value = unique(values);
  if (value === null) throw new Error(values.length ? "Conflicting nuclear available periods" : "Gap in nuclear available periods");
  return value;
}
/** Mean announced capacity over two exact hours, resolving parent/child constraints once. */
export function computeNuclearAvailability(input: {
  roster: NuclearRoster | null;
  productionOutages: NuclearOutageDocument | null;
  generationOutages: NuclearOutageDocument | null;
}, anchorStart: number, targetStart: number): NuclearAvailability {
  if (input.roster === null || input.productionOutages === null || input.generationOutages === null) return { status: "unavailable", reason: "missing_nuclear_sources" };
  if (![anchorStart, targetStart].every(Number.isFinite)) return { status: "unavailable", reason: "invalid_nuclear_hour" };
  try {
    const names = input.roster.units.map(unit => reactorName(unit.name)).sort();
    if (JSON.stringify(names) !== JSON.stringify([...OPERATING_REACTORS].sort()) || new Set(input.roster.units.map(unit => unit.productionId)).size !== 6) throw new Error("Incomplete operating nuclear roster");
    const production = latestNotices(input.productionOutages, "A77"), generation = latestNotices(input.generationOutages, "A80");
    const rosterIds = new Set(input.roster.units.map(unit => unit.productionId));
    for (const notice of [...production, ...generation]) if (!rosterIds.has(notice.productionId)) throw new Error("Unknown nuclear notice production unit");
    const mean = (start: number) => {
      const end = start + HOUR;
      const cuts = new Set([start, end]);
      for (const unit of input.roster!.units) for (const period of unit.capacities) for (const at of [period.startMs, period.endMs]) if (at > start && at < end) cuts.add(at);
      for (const notice of [...production, ...generation]) for (const at of [notice.startMs, notice.endMs, ...notice.periods.flatMap(period => [period.startMs, period.endMs])]) if (at > start && at < end) cuts.add(at);
      const boundaries = [...cuts].sort((a, b) => a - b);
      let energy = 0;
      for (let i = 0; i < boundaries.length - 1; i++) {
        const at = boundaries[i]; let total = 0;
        for (const unit of input.roster!.units) {
          const nominal = unique(unit.capacities.filter(period => period.startMs <= at && period.endMs > at).map(period => period.mw));
          if (nominal === null) throw new Error("Missing or conflicting nuclear installed capacity");
          const parentValues = production.filter(notice => notice.productionId === unit.productionId).map(notice => noticeValue(notice, at)).filter((value): value is number => value !== null);
          const parent = parentValues.length ? unique(parentValues) : null;
          if (parentValues.length && parent === null) throw new Error("Conflicting production-unit nuclear notices");
          const children = new Map<string, { nominal: number; values: number[] }>();
          for (const notice of generation.filter(notice => notice.productionId === unit.productionId)) {
            const value = noticeValue(notice, at);
            if (value === null) continue;
            if (notice.generationId === null) throw new Error("Missing nuclear generation-unit identity");
            const child = children.get(notice.generationId) ?? { nominal: notice.nominalMw, values: [] };
            if (child.nominal !== notice.nominalMw) throw new Error("Conflicting generation-unit nuclear capacities");
            child.values.push(value); children.set(notice.generationId, child);
          }
          let loss = 0;
          for (const child of children.values()) {
            const available = unique(child.values);
            if (available === null) throw new Error("Conflicting generation-unit nuclear notices");
            loss += child.nominal - available;
          }
          // The two feeds constrain the same parent capacity; their losses are not additive.
          const childCapacity = nominal - loss;
          total += parent !== null ? children.size ? Math.min(parent, childCapacity) : parent : childCapacity;
        }
        energy += total * (boundaries[i + 1] - at) / HOUR;
      }
      return energy;
    };
    return { status: "data", anchorMw: mean(anchorStart), targetMw: mean(targetStart), details: {
      operatingUnits: input.roster.units.length, productionNotices: production.length, generationNotices: generation.length,
      assumption: "Announced capacity: installed production capacity outside reported outages; availability does not guarantee dispatch or restart.",
    } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "invalid_nuclear_evidence" };
  }
}
