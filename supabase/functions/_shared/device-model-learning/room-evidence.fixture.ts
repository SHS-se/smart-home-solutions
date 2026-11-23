import { assert, assertEquals } from "@std/assert";
import type { ThermalQuarterRow } from "../thermal-training.ts";
import type { HeatingProbeCapture } from "../heating-probe-wire.ts";

export function compactCapture(rows: ThermalQuarterRow[]): HeatingProbeCapture {
  const sources: HeatingProbeCapture["sources"] = [];
  const indices = new Map<string, number>();
  const flag = (value: boolean | null) => value === null ? 0 : value ? 2 : 1;
  return { sources, rows: rows.map(({ probe_evidence, ...row }) => ({ ...row,
    probe_values: probe_evidence?.map(probe => {
      const { source_key, area_key, cohort_key } = probe;
      const key = JSON.stringify([source_key, area_key, cohort_key]);
      let index = indices.get(key);
      if (index === undefined) {
        index = sources.length;
        indices.set(key, index);
        sources.push({ source_key, area_key, cohort_key });
      }
      return [index, probe.mean, flag(probe.unchanged) + flag(probe.joint_unchanged) * 4 +
        flag(probe.reported) * 16 + flag(probe.unavailable) * 64];
    }) ?? null,
  })) };
}

export interface EvidenceRange { from_at: string; to_at: string }
type Block = EvidenceRange & { sha256: string; row_count: number; capture: string };

/** Synthetic store of frozen extents and overlapping source revisions. SQL
 * tests exercise the actual locks and history signals; this store exercises
 * the canonical RPC boundary, including corrections between two calls. */
export function evidenceStore(rows: ThermalQuarterRow[], ranges: EvidenceRange[]) {
  let revision = 1, policyFingerprint = "a".repeat(64);
  const dirty = new Set(ranges.map(r => r.from_at)), blocks = new Map<string, Block>();
  const changes = ranges.map(range => ({ range, revision }));
  const reads: { name: string; args: Record<string, unknown> }[] = [];
  const overlaps = (a: EvidenceRange, b: EvidenceRange) => a.from_at < b.to_at && a.to_at > b.from_at;
  const sourceRevision = (range: EvidenceRange) => changes.reduce((v, c) => overlaps(c.range, range) ? Math.max(v, c.revision) : v, 0);
  let fail: string | null = null;
  return {
    blocks, reads, sourceRevision,
    get policyFingerprint() { return policyFingerprint; },
    setPolicyFingerprint(value: string) { policyFingerprint = value; },
    fail: (name: string | null) => { fail = name; },
    correct(range: EvidenceRange) {
      changes.push({ range, revision: ++revision });
      ranges.filter(r => overlaps(r, range)).forEach(r => dirty.add(r.from_at));
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
      reads.push({ name, args });
      if (fail === name) return { data: null, error: { message: "synthetic read failed" } };
      const range = { from_at: String(args.p_from_at), to_at: String(args.p_to_at) };
      let data: unknown;
      switch (name) {
        case "get_energy_room_evidence_work":
          data = { source_revision: sourceRevision(range), policy_fingerprint: policyFingerprint, next: ranges.find(r => overlaps(r, range) && dirty.has(r.from_at)) ?? null };
          break;
        case "load_energy_room_evidence_blocks":
          data = [...blocks.values()].filter(r => overlaps(r, range));
          break;
        case "get_energy_room_thermal_interval_capture": {
          assertEquals(args.p_room_key, "room");
          const subset = rows.filter(row => row.start_ts >= String(args.p_from) &&
            Date.parse(row.start_ts) + (row.duration_s ?? 900) * 1000 <= Date.parse(String(args.p_to)));
          data = compactCapture(subset);
          break;
        }
        case "get_energy_room_operation_facts": data = []; break;
        case "save_energy_room_evidence_block":
          assert(Number.isSafeInteger(args.p_fence));
          data = Number(args.p_source_revision) >= sourceRevision(range);
          if (data) {
            blocks.set(range.from_at, { ...range, sha256: String(args.p_sha256), capture: String(args.p_capture_base64),
              row_count: Number(args.p_row_count) });
            dirty.delete(range.from_at);
          }
          break;
        default: throw new Error(`Unexpected evidence RPC ${name}`);
      }
      return { data: structuredClone(data), error: null };
    },
  };
}
