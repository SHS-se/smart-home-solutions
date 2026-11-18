import type { ProbeEvidence } from "./device-learning/room/source-freshness.ts";
import type { ThermalQuarterRow } from "./thermal-training.ts";

type ProbeSource = Pick<ProbeEvidence, "source_key" | "area_key" | "cohort_key">;
type ProbeValue = [sourceIndex: number, mean: number | null, flags: number];
type Interval = Omit<ThermalQuarterRow, "probe_evidence">;

export interface HeatingProbeCapture {
  sources: ProbeSource[];
  rows: Array<Interval & { probe_values: ProbeValue[] | null }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const facts = [null, false, true] as const;

/** Decode one bounded native RPC response with one dictionary of source identities. */
export function decodeHeatingProbeCapture(input: unknown, roomKey: string): ThermalQuarterRow[] {
  if (!object(input) || !Array.isArray(input.sources) || !Array.isArray(input.rows)) {
    throw new Error("Malformed native room interval capture");
  }
  const identities = new Set<string>();
  const sources = input.sources.map((source: unknown): ProbeSource => {
    if (!object(source) || !nonempty(source.source_key) || !nonempty(source.area_key) ||
      !(source.cohort_key === null || nonempty(source.cohort_key))) {
      throw new Error("Malformed native room probe source");
    }
    // A physical probe can keep its source key after its room area or bridge
    // changes. Its dictionary identity includes all three fields.
    const identity = JSON.stringify([source.source_key, source.area_key, source.cohort_key]);
    if (identities.has(identity)) throw new Error("Duplicate native room probe source");
    identities.add(identity);
    return { source_key: source.source_key, area_key: source.area_key, cohort_key: source.cohort_key };
  });
  const seen = new Set<string>();
  return input.rows.map((raw: unknown) => {
    if (!object(raw) || !nonempty(raw.start_ts)) throw new Error("Malformed native room interval");
    if (raw.room_key !== roomKey) throw new Error("Native room capture crossed owner boundary");
    const { probe_values, ...row } = raw as unknown as Interval & { probe_values: unknown };
    if (probe_values === null) return { ...row, probe_evidence: null };
    if (!Array.isArray(probe_values)) throw new Error("Malformed native room probe values");
    seen.clear();
    const probe_evidence = probe_values.map((value: unknown): ProbeEvidence => {
      if (!Array.isArray(value) || value.length !== 3) throw new Error("Malformed native room probe value");
      const [index, mean, flags] = value as [unknown, unknown, unknown];
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= sources.length) {
        throw new Error("Invalid native room probe source index");
      }
      if (mean !== null && !(typeof mean === "number" && Number.isFinite(mean))) {
        throw new Error("Invalid native room probe mean");
      }
      // Each pair is null (0), false (1) or true (2). Both bits set is invalid.
      if (typeof flags !== "number" || !Number.isInteger(flags) || flags < 0 || flags > 0xaa ||
        (flags & (flags >> 1) & 0x55) !== 0) {
        throw new Error("Invalid native room probe flags");
      }
      const source = sources[index];
      if (seen.has(source.source_key)) throw new Error("Duplicate physical probe in native room interval");
      seen.add(source.source_key);
      return { source_key: source.source_key, area_key: source.area_key, cohort_key: source.cohort_key,
        mean, unchanged: facts[flags & 3], joint_unchanged: facts[(flags >> 2) & 3],
        reported: facts[(flags >> 4) & 3], unavailable: facts[(flags >> 6) & 3] };
    });
    return { ...row, probe_evidence };
  });
}
