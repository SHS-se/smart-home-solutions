/** Streaming experiment reads of the complete native IG183 XML, including all zones' PTDFs. */
import { SaxesParser } from "npm:saxes@6.0.0";
import { marketZipStream } from "./market-xml.ts";
import {
  NUCS_DOMAIN_LIMITS,
  type NucsConstraint,
  nucsDomainMember,
  type NucsPublication,
  parseNucsConstraint,
} from "./nucs-flow-based.ts";

type Fields = Record<string, unknown>;
interface Frame {
  name: string;
  fields: Fields;
  text: string;
}
export type NucsDomainRecord =
  | {
    kind: "constraint";
    publication_id: string;
    revision: string;
    series_id: string;
    period_start: string;
    period_end: string;
    resolution: string;
    curve: string;
    position: number;
    constraint: NucsConstraint;
  }
  | {
    kind: "series";
    publication_id: string;
    revision: string;
    series_id: string;
    reasons: unknown[];
  };
function single(v: unknown): Fields {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("Invalid NUCS domain element");
  }
  return v as Fields;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error("Missing NUCS domain field");
  }
  return v.trim();
}
function append(fields: Fields, key: string, value: unknown) {
  if (!(key in fields)) fields[key] = value;
  else if (Array.isArray(fields[key])) (fields[key] as unknown[]).push(value);
  else fields[key] = [fields[key], value];
}
/** Consume the iterator fully before committing experiment outputs, so malformed XML fails the run. */
export async function* streamNucsDomain(
  bytes: Uint8Array,
  publication: NucsPublication,
  window: { from: string; to: string },
): AsyncGenerator<NucsDomainRecord> {
  const from = Date.parse(window.from), to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error("Invalid NUCS domain read window");
  }
  const { member } = await nucsDomainMember(bytes);
  const frames: Frame[] = [];
  const pending: NucsDomainRecord[] = [];
  let matchedHeader = false;
  let constraintCount = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("doctype", () => {
    throw new Error("Unsupported NUCS XML doctype");
  });
  parser.on("opentag", (tag) => {
    if (
      !frames.length && tag.local !== "CriticalNetworkElement_MarketDocument"
    ) throw new Error("Unexpected NUCS domain root");
    if (tag.local === "TimeSeries") {
      const header = frames[0].fields;
      if (
        header.mRID !== publication.id ||
        header.revisionNumber !== publication.revision ||
        header.type !== "B11" ||
        header["process.processType"] !== publication.process
      ) throw new Error("NUCS archive publication mismatch");
      matchedHeader = true;
    }
    frames.push({ name: tag.local, fields: {}, text: "" });
  });
  parser.on("text", (value) => {
    if (frames.length) frames[frames.length - 1].text += value;
  });
  parser.on("cdata", (value) => {
    if (frames.length) frames[frames.length - 1].text += value;
  });
  parser.on("closetag", () => {
    const frame = frames.pop()!;
    const parent = frames[frames.length - 1];
    const value = Object.keys(frame.fields).length
      ? frame.fields
      : frame.text.trim();
    if (frame.name === "Constraint_Series") {
      const period = frames.findLast((f) => f.name === "Period");
      const point = frames.findLast((f) => f.name === "Point");
      const series = frames.findLast((f) => f.name === "TimeSeries");
      if (!period || !point || !series) {
        throw new Error("Unscoped NUCS constraint");
      }
      const interval = single(period.fields.timeInterval);
      const start = text(interval.start), end = text(interval.end);
      const resolution = text(period.fields.resolution),
        position = Number(text(point.fields.position));
      const step = /^PT(\d+)(M|H)$/.exec(resolution);
      if (
        !step || Number(step[1]) <= 0 || !Number.isInteger(position) ||
        position < 1 ||
        !Number.isFinite(Date.parse(start)) ||
        !Number.isFinite(Date.parse(end)) ||
        Date.parse(end) <= Date.parse(start) ||
        Date.parse(start) +
              (position - 1) * Number(step[1]) *
                (step[2] === "M" ? 60_000 : 3_600_000) >= Date.parse(end)
      ) throw new Error("Invalid NUCS constraint period");
      const curve = text(series.fields.curveType);
      if (!["A01", "A03"].includes(curve)) {
        throw new Error("Unsupported NUCS constraint curve");
      }
      const constraint = parseNucsConstraint(value);
      constraintCount++;
      if (Date.parse(start) < to && Date.parse(end) > from) {
        pending.push({
          kind: "constraint",
          publication_id: publication.id,
          revision: publication.revision,
          series_id: text(series.fields.mRID),
          period_start: start,
          period_end: end,
          resolution,
          curve,
          position,
          constraint,
        });
      }
      // Completed constraints are emitted and released, never appended to the XML tree.
      return;
    }
    if (frame.name === "TimeSeries") {
      const reasons = frame.fields.Reason;
      pending.push({
        kind: "series",
        publication_id: publication.id,
        revision: publication.revision,
        series_id: text(frame.fields.mRID),
        reasons: reasons === undefined
          ? []
          : Array.isArray(reasons)
          ? reasons
          : [reasons],
      });
      return;
    }
    if (parent) append(parent.fields, frame.name, value);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (
    const chunk of marketZipStream(member, NUCS_DOMAIN_LIMITS.memberBytes)
  ) {
    parser.write(decoder.decode(chunk, { stream: true }));
    while (pending.length) yield pending.shift()!;
  }
  parser.write(decoder.decode()).close();
  while (pending.length) yield pending.shift()!;
  if (!matchedHeader || !constraintCount) {
    throw new Error("Missing NUCS domain constraints");
  }
}
