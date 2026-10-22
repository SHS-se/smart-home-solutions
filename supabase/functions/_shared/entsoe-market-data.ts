import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";

export type EntsoeDataset =
  | "price" | "load_actual" | "load_day_ahead" | "load_week_ahead"
  | "wind_actual" | "solar_actual" | "nuclear_actual" | "wind_day_ahead"
  | "generation_outages" | "generation_actual";

export interface EntsoeQuery { dataset: EntsoeDataset; from: string; to: string }

const SE3 = "10Y1001A1001A46L";
const DATASETS: Record<EntsoeDataset, Record<string, string>> = {
  price: { documentType: "A44", in_Domain: SE3, out_Domain: SE3 },
  load_actual: { documentType: "A65", processType: "A16", outBiddingZone_Domain: SE3 },
  load_day_ahead: { documentType: "A65", processType: "A01", outBiddingZone_Domain: SE3 },
  load_week_ahead: { documentType: "A65", processType: "A31", outBiddingZone_Domain: SE3 },
  // Keep both offshore (B18) and onshore (B19) available, with each series' PSR label.
  generation_actual: { documentType: "A75", processType: "A16", in_Domain: SE3 },
  wind_actual: { documentType: "A75", processType: "A16", in_Domain: SE3 },
  solar_actual: { documentType: "A75", processType: "A16", in_Domain: SE3, psrType: "B16" },
  nuclear_actual: { documentType: "A75", processType: "A16", in_Domain: SE3, psrType: "B14" },
  wind_day_ahead: { documentType: "A69", processType: "A01", in_Domain: SE3 },
  generation_outages: { documentType: "A80", biddingZone_Domain: SE3 },
};

// Transmission outages (A78) require an explicit in/out border. The SE3-only
// research query does not represent them as a fictitious zone aggregate.

function dateMs(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value)) {
    throw new Error("Expected an ISO UTC timestamp");
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 16) !== value.slice(0, 16)) throw new Error("Invalid timestamp");
  return result;
}

/** Closed SE3 vocabulary: callers cannot supply a token, endpoint or arbitrary API parameters. */
export function entsoeParameters(query: unknown): URLSearchParams {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("Expected a query object");
  const raw = query as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "dataset,from,to" || typeof raw.dataset !== "string" || !Object.hasOwn(DATASETS, raw.dataset)) {
    throw new Error("Expected dataset, from and to only");
  }
  const from = dateMs(raw.from), to = dateMs(raw.to);
  if (to <= from || from % 60_000 !== 0 || to % 60_000 !== 0) throw new Error("Expected an increasing interval at minute boundaries");
  const compact = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "");
  return new URLSearchParams({ ...DATASETS[raw.dataset as EntsoeDataset], periodStart: compact(from), periodEnd: compact(to) });
}

export interface EntsoeInterval {
  startMs: number; endMs: number; value: number; unit: string; psrType: string | null;
  /** Native provider resolution and series labels; daily min/max is not a mean. */
  resolution: string; businessType: string | null; seriesId: string | null;
  flow: "production" | "consumption" | null;
}
export type EntsoeResponse =
  | { status: "data"; createdAt: string | null; documentId: string | null;
    revisionNumber: string | null; processType: string | null; intervals: EntsoeInterval[] }
  | { status: "no_data"; reason: string };

export class EntsoeProviderError extends Error {}

type Element = Record<string, unknown>;
function element(value: unknown): Element {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed ENTSO-E element");
  return value as Element;
}
function list(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Missing ENTSO-E field");
  return value.trim();
}
function numeric(value: unknown): number {
  const parsed = Number(text(value));
  if (!Number.isFinite(parsed)) throw new Error("Invalid ENTSO-E numeric value");
  return parsed;
}
function optionalText(value: unknown): string | null { return value === undefined ? null : text(value); }

/** P1D at SE3 midnight follows the source calendar through daylight-saving changes. */
function dailyBoundary(start: number, position: number): number {
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(format.formatToParts(start).map(part => [part.type, part.value]));
  if (parts.hour !== "00" || parts.minute !== "00") throw new Error("Unsupported ENTSO-E daily period: expected SE3 midnight");
  if (position === 1) return start;
  const targetDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + position - 1));
  const targetDay = targetDate.toISOString().slice(0, 10);
  // The provider's UTC interval establishes the SE3 day; choose the UTC instant
  // that is midnight on its target calendar day instead of assuming 24 hours.
  for (const offsetHours of [1, 2]) {
    const candidate = targetDate.getTime() - offsetHours * 3_600_000;
    const candidateParts = Object.fromEntries(format.formatToParts(candidate).map(part => [part.type, part.value]));
    if (`${candidateParts.year}-${candidateParts.month}-${candidateParts.day}` === targetDay && candidateParts.hour === "00" && candidateParts.minute === "00") return candidate;
  }
  throw new Error("Unsupported ENTSO-E daily calendar boundary");
}

/** Parse XML only. ZIP outage payloads must be retained and explicitly reported as unsupported. */
export function parseEntsoeResponse(xml: string): EntsoeResponse {
  if (!xml.trimStart().startsWith("<") || XMLValidator.validate(xml) !== true || /<!DOCTYPE/i.test(xml)) throw new Error("Malformed or unsupported ENTSO-E XML");
  const parsed = element(new XMLParser({ removeNSPrefix: true, parseTagValue: false, trimValues: true, ignoreAttributes: true }).parse(xml));
  const roots = Object.keys(parsed).filter(key => !key.startsWith("?"));
  if (roots.length !== 1) throw new Error("Expected one ENTSO-E document");
  const document = element(parsed[roots[0]]);
  if (roots[0] === "Acknowledgement_MarketDocument") {
    const reasons = list(document.Reason).map(value => {
      const reason = element(value);
      return { code: text(reason.code), reason: text(reason.text) };
    });
    if (reasons.length && reasons.every(reason => reason.code === "999" && /no matching data found/i.test(reason.reason))) {
      return { status: "no_data", reason: reasons.map(reason => reason.reason).join("; ") };
    }
    throw new EntsoeProviderError(`ENTSO-E acknowledgement: ${reasons.map(reason => `${reason.code}: ${reason.reason}`).join("; ")}`);
  }
  const series = list(document.TimeSeries);
  if (!series.length) throw new Error("ENTSO-E document has no supported time series");
  const intervals: EntsoeInterval[] = [];
  for (const rawSeries of series) {
    const s = element(rawSeries);
    const curve = text(s.curveType);
    if (curve !== "A01" && curve !== "A03") throw new Error(`Unsupported ENTSO-E curve ${curve}`);
    const unit = text(s["quantity_Measure_Unit.name"] ?? s["price_Measure_Unit.name"]);
    const psr = s.MktPSRType === undefined ? null : text(element(s.MktPSRType).psrType);
    const businessType = optionalText(s.businessType), seriesId = optionalText(s.mRID);
    const inZone = optionalText(s["inBiddingZone_Domain.mRID"]);
    const outZone = optionalText(s["outBiddingZone_Domain.mRID"]);
    if (inZone !== null && outZone !== null) throw new Error("Ambiguous ENTSO-E generation flow");
    const domainFlow = inZone !== null ? "production" : outZone !== null ? "consumption" : null;
    const businessFlow = businessType === "A01" ? "production" : businessType === "A04" ? "consumption" : null;
    if (domainFlow !== null && businessFlow !== null && domainFlow !== businessFlow) throw new Error("Inconsistent ENTSO-E generation flow");
    const flow = domainFlow ?? businessFlow;
    const periods = list(s.Period);
    if (!periods.length) throw new Error("ENTSO-E series has no supported periods");
    for (const rawPeriod of periods) {
      const period = element(rawPeriod), span = element(period.timeInterval);
      const start = dateMs(span.start), end = dateMs(span.end);
      const resolution = text(period.resolution);
      const daily = resolution === "P1D";
      const step = resolution === "PT15M" ? 900_000 : resolution === "PT60M" ? 3_600_000 : daily ? 86_400_000 : null;
      if (step === null) throw new Error(`Unsupported ENTSO-E resolution ${resolution}`);
      if (end <= start || (!daily && (end - start) % step !== 0)) throw new Error("Invalid ENTSO-E period duration");
      const boundary = (position: number) => daily ? dailyBoundary(start, position) : start + (position - 1) * step;
      const points = list(period.Point).map(rawPoint => {
        const point = element(rawPoint), position = numeric(point.position);
        if (!Number.isInteger(position) || position < 1 || boundary(position) >= end) throw new Error("Invalid ENTSO-E point position");
        return { position, value: numeric(point.quantity ?? point["price.amount"]) };
      }).sort((a, b) => a.position - b.position);
      for (let i = 0; i < points.length; i++) {
        const point = points[i], next = points[i + 1];
        if (next?.position === point.position) throw new Error("Duplicate ENTSO-E point position");
        const startMs = boundary(point.position);
        // A01 missing positions are gaps. A03 omits unchanged block positions.
        const endMs = curve === "A03" ? next ? boundary(next.position) : end : Math.min(boundary(point.position + 1), end);
        intervals.push({ startMs, endMs, value: point.value, unit, psrType: psr, resolution, businessType, seriesId, flow });
      }
    }
  }
  return { status: "data", createdAt: optionalText(document.createdDateTime),
    documentId: optionalText(document.mRID), revisionNumber: optionalText(document.revisionNumber),
    processType: optionalText(document["process.processType"]), intervals };
}
