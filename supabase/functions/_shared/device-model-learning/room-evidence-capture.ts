import { qualifyProbeFreshness, type ProbeEvidence } from "../device-learning/room/source-freshness.ts";
import type { ThermalQuarterRow } from "../thermal-training.ts";

const MAX_BLOCK_MS = 10 * 86_400_000;
const MAX_ROWS = MAX_BLOCK_MS / 900_000;
const VERSION = 1;

const measurements = [
  "active_power_w", "room_temperature_c", "outdoor_temperature_c", "solar_w_per_m2", "house_temperature_c", "heat_w",
] as const;
const intervalFields = new Set(["room_key", "room_name", "start_ts", ...measurements, "cooling", "operation_fact",
  "duration_s", "source", "heat_attributed", "temperature_source_key", "probe_evidence"]);
const probeFields = new Set(["source_key", "area_key", "cohort_key", "mean", "unchanged", "joint_unchanged",
  "reported", "unavailable"]);
const envelopeFields = new Set(["version", "from", "to", "strings", "rows"]);

function record(value: unknown, fields: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) {
    throw new Error("Invalid room evidence record");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid room evidence string");
  return value;
}

function sourceKey(value: unknown): string {
  if (!string(value).length) throw new Error("Empty room evidence source key");
  return value as string;
}

function fact(value: unknown): boolean | null {
  if (value !== null && typeof value !== "boolean") throw new Error("Invalid room evidence flag");
  return value;
}

// JSON.stringify emits 0 for -0. A string tag is unambiguous inside a measurement.
function measurement(value: unknown, decoding: true): number | null;
function measurement(value: unknown, decoding: boolean): number | null | "-0";
function measurement(value: unknown, decoding: boolean) {
  if (value === null) return null;
  if (decoding && value === "-0") return -0;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid room evidence measurement");
  return !decoding && Object.is(value, -0) ? "-0" : value;
}

function bounds(fromAt: string, toAt: string) {
  const from = Date.parse(fromAt), to = Date.parse(toAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_BLOCK_MS) {
    throw new Error("Invalid room evidence block range");
  }
  return { from, to };
}

function packProbe(input: unknown, index: (key: string) => number) {
  const probe = record(input, probeFields);
  return [index(sourceKey(probe.source_key)), index(sourceKey(probe.area_key)),
    probe.cohort_key === null ? null : index(sourceKey(probe.cohort_key)), measurement(probe.mean, false),
    fact(probe.unchanged), fact(probe.joint_unchanged), fact(probe.reported), fact(probe.unavailable)];
}

function unpackProbe(value: unknown, strings: string[]): ProbeEvidence {
  if (!Array.isArray(value) || value.length !== 8) throw new Error("Invalid room evidence probe");
  const [source, area, cohort, mean, unchanged, jointUnchanged, reported, unavailable] = value;
  const key = (index: unknown) => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= strings.length) {
      throw new Error("Invalid room evidence source index");
    }
    return strings[index];
  };
  return { source_key: key(source), area_key: key(area), cohort_key: cohort === null ? null : key(cohort),
    mean: measurement(mean, true), unchanged: fact(unchanged), joint_unchanged: fact(jointUnchanged),
    reported: fact(reported), unavailable: fact(unavailable) };
}

/** Validate both directions and emit properties in a fixed order for repeatable content hashes. */
function interval(input: unknown, range: ReturnType<typeof bounds>, decoding: boolean, probe: (input: unknown) => unknown) {
  const row = record(input, intervalFields), start = string(row.start_ts), at = Date.parse(start);
  if (!(at >= range.from && at < range.to)) throw new Error("Room evidence interval outside block");
  const result: Record<string, unknown> = { room_key: sourceKey(row.room_key), room_name: string(row.room_name),
    start_ts: start, cooling: fact(row.cooling) };
  for (const field of measurements) result[field] = measurement(row[field], decoding);
  for (const field of ["operation_fact", "source"] as const) {
    if (row[field] !== undefined) result[field] = sourceKey(row[field]);
  }
  if (row.duration_s !== undefined) {
    if (row.duration_s !== 900 && row.duration_s !== 3600) throw new Error("Invalid room evidence interval duration");
    result.duration_s = row.duration_s;
  }
  if (row.heat_attributed !== undefined) {
    if (typeof row.heat_attributed !== "boolean") throw new Error("Invalid room evidence heat attribution");
    result.heat_attributed = row.heat_attributed;
  }
  if (row.temperature_source_key !== undefined) {
    result.temperature_source_key = row.temperature_source_key === null ? null : sourceKey(row.temperature_source_key);
  }
  if (row.probe_evidence === null) result.probe_evidence = null;
  else if (row.probe_evidence !== undefined) {
    if (!Array.isArray(row.probe_evidence)) throw new Error("Invalid room probe evidence");
    const seen = new Set<string>();
    result.probe_evidence = row.probe_evidence.map(value => {
      const mapped = probe(value);
      const { source_key } = (decoding ? mapped : value) as ProbeEvidence;
      if (seen.has(source_key)) throw new Error("Duplicate physical room evidence probe");
      seen.add(source_key);
      return mapped;
    });
  }
  return result;
}

function checkSequence(rows: Record<string, unknown>[]) {
  let previous = -Infinity;
  for (const row of rows) {
    const at = Date.parse(row.start_ts as string);
    if (row.room_key !== rows[0].room_key || at <= previous) throw new Error("Invalid room evidence owner or interval order");
    previous = at;
  }
}

async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Store source- and operation-qualified observations before population-wide freshness inference.
 * A start belongs to exactly one block even when the native interval spans the seam. */
export async function encodeRoomEvidenceCapture(rows: readonly ThermalQuarterRow[], fromAt: string, toAt: string) {
  const range = bounds(fromAt, toAt);
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error("Invalid room evidence row count");
  const strings: string[] = [], indices = new Map<string, number>();
  const index = (key: string) => {
    const existing = indices.get(key);
    if (existing !== undefined) return existing;
    const next = strings.length;
    strings.push(key);
    indices.set(key, next);
    return next;
  };
  const sorted = [...rows].sort((a, b) => Date.parse(a.start_ts) - Date.parse(b.start_ts));
  const encoded = sorted.map(row => interval(row, range, false, value => packProbe(value, index)));
  checkSequence(encoded);
  const body = JSON.stringify({ version: VERSION, ...range, strings, rows: encoded });
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { base64: btoa(binary), sha256: await digest(bytes), row_count: rows.length };
}

export async function decodeRoomEvidenceCapture(base64: string, fromAt: string, toAt: string, sha256: string):
  Promise<ThermalQuarterRow[]> {
  const range = bounds(fromAt, toAt);
  if (typeof base64 !== "string" || !base64.length || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Invalid room evidence capture envelope");
  }
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (await digest(bytes) !== sha256) throw new Error("Room evidence capture digest mismatch");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const body = record(await new Response(stream).json(), envelopeFields);
  if (body.version !== VERSION || body.from !== range.from || body.to !== range.to ||
    !Array.isArray(body.strings) || !Array.isArray(body.rows) || body.rows.length > MAX_ROWS) {
    throw new Error("Invalid room evidence block envelope");
  }
  const strings = body.strings.map(sourceKey);
  if (new Set(strings).size !== strings.length) throw new Error("Duplicate room evidence source key");
  const rows = body.rows.map(raw => interval(raw, range, true, value => unpackProbe(value, strings)));
  checkSequence(rows);
  return rows as unknown as ThermalQuarterRow[];
}

export interface DecodedRoomEvidenceBlock {
  from_at: string;
  to_at: string;
  rows: readonly ThermalQuarterRow[];
}

/** A manifest must cover every requested instant, including explicitly empty blocks.
 * Only observed native intervals wholly within the requested population qualify. */
export function qualifyRoomEvidenceBlocks(blocks: readonly DecodedRoomEvidenceBlock[], roomKey: string,
  fromAt: string, toAt: string) {
  const floor = Date.parse(fromAt), ceiling = Date.parse(toAt);
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || floor > ceiling) throw new Error("Invalid room evidence horizon");
  const chronological = blocks.map(block => ({ ...bounds(block.from_at, block.to_at), rows: block.rows }))
    .sort((a, b) => a.from - b.from);
  const observed: ThermalQuarterRow[] = [];
  let coveredThrough = floor, previousEnd = -Infinity;
  for (const { from, to, rows } of chronological) {
    if (from < previousEnd) throw new Error("Overlapping room evidence blocks");
    previousEnd = to;
    if (to <= floor || from >= ceiling) continue;
    if (from > coveredThrough) throw new Error("Incomplete room evidence coverage");
    coveredThrough = to;
    let previous = -Infinity;
    for (const row of rows) {
      const start = Date.parse(row.start_ts);
      if (row.room_key !== roomKey || !(start >= from && start < to && start > previous)) {
        throw new Error("Invalid room evidence owner or interval order");
      }
      previous = start;
      if (start >= floor && start + (row.duration_s ?? 900) * 1000 <= ceiling) observed.push(row);
    }
  }
  if (coveredThrough < ceiling) throw new Error("Incomplete room evidence coverage");
  const { rows, report } = qualifyProbeFreshness(observed);
  return { quarters: rows.map(({ probe_evidence: _facts, ...row }) => row), sourceFreshness: report };
}
