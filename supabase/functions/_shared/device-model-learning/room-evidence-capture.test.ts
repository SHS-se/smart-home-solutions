import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import type { ProbeEvidence } from "../device-learning/room/source-freshness.ts";
import type { ThermalQuarterRow } from "../thermal-training.ts";
import { decodeRoomEvidenceCapture, encodeRoomEvidenceCapture, qualifyRoomEvidenceBlocks } from "./room-evidence-capture.ts";

// All observations and physical source identities below are synthetic.
const START = Date.UTC(2025, 0, 1);
const at = (quarter: number) => new Date(START + quarter * 900_000).toISOString();
const probe = (extra: Partial<ProbeEvidence> = {}): ProbeEvidence => ({
  source_key: "probe-a", area_key: "area-a", cohort_key: null, mean: 20,
  unchanged: true, joint_unchanged: false, reported: false, unavailable: null, ...extra,
});
const row = (quarter: number, extra: Partial<ThermalQuarterRow> = {}): ThermalQuarterRow => ({
  room_key: "synthetic", room_name: "Synthetic room", active_power_w: null, start_ts: at(quarter),
  cooling: null, heat_w: 0, room_temperature_c: 20, house_temperature_c: null, solar_w_per_m2: null,
  outdoor_temperature_c: -0, ...extra,
});

async function block(rows: ThermalQuarterRow[], from: number, to: number) {
  const from_at = at(from), to_at = at(to);
  const { base64, sha256, row_count } = await encodeRoomEvidenceCapture(rows, from_at, to_at);
  assertEquals(row_count, rows.length);
  return { from_at, to_at, rows: await decodeRoomEvidenceCapture(base64, from_at, to_at, sha256) };
}

Deno.test("source evidence roundtrips fractional native starts, source lineage and every unknown state", async () => {
  const raw = [
    row(0, { temperature_source_key: null, probe_evidence: null }),
    row(1, { duration_s: 900, probe_evidence: [], room_temperature_c: null }),
    row(2),
    row(3.25, { source: "recorder_hour_mean", duration_s: 3600, heat_attributed: false, cooling: true,
      operation_fact: "11111111-2222-4333-8444-555555555555", temperature_source_key: "probe-a",
      heat_w: null, house_temperature_c: 19.825, probe_evidence: [probe({ mean: -0 }),
        probe({ source_key: "probe-b", area_key: "area-b", cohort_key: "group-2", reported: true, unavailable: false })] }),
    row(7.25, { heat_w: 0.03125, heat_attributed: true, cooling: false, probe_evidence: [
      probe({ area_key: "area-c", cohort_key: "group-3", mean: null, unavailable: true, reported: null }),
    ] }),
  ];
  const result = await block(raw, 0, 8);
  assertEquals(result.rows, raw);
  assert(Object.is(result.rows[0].outdoor_temperature_c, -0));
  assert(Object.is(result.rows[3].probe_evidence![0].mean, -0));
  const capture = await encodeRoomEvidenceCapture(raw, at(0), at(8));
  const shuffled = [...raw].reverse().map(value => Object.fromEntries(Object.entries(value).reverse()) as unknown as ThermalQuarterRow);
  assertEquals(await encodeRoomEvidenceCapture(shuffled, at(0), at(8)), capture);
  const changed = [...raw.slice(0, -1), { ...raw.at(-1)!, heat_w: null }];
  assertNotEquals((await encodeRoomEvidenceCapture(changed, at(0), at(8))).sha256, capture.sha256);
  await assertRejects(() => decodeRoomEvidenceCapture(capture.base64, at(0), at(8), "0".repeat(64)), Error, "digest mismatch");
  await assertRejects(() => decodeRoomEvidenceCapture(capture.base64, at(0), at(9), capture.sha256), Error, "block envelope");
});

Deno.test("chronological reconstruction qualifies freezes across storage seams in the same population as a full read", async () => {
  const raw = Array.from({ length: 840 }, (_, i) => {
    const frozen = i >= 100 && i < 260;
    return row(i, { duration_s: 900, heat_w: i / 4, temperature_source_key: "probe-a",
      probe_evidence: [probe({ unchanged: frozen, joint_unchanged: frozen })] });
  });
  const all = await block(raw, 0, 840);
  const split = [await block(raw.slice(100, 260), 100, 260), await block(raw.slice(260), 260, 840),
    await block(raw.slice(0, 100), 0, 100)];
  const qualify = (blocks: typeof split) => qualifyRoomEvidenceBlocks(blocks, "synthetic", at(0), at(840));
  const result = qualify(split);
  assertEquals(result, qualify([all]));
  assertEquals(result.sourceFreshness.room.inferred, 160);
  assertEquals(result.quarters[100].room_temperature_c, null);
  assertEquals(result.quarters[100].heat_w, 25);
  assert(!("probe_evidence" in result.quarters[100]));
  assertEquals(split[0].rows[0].room_temperature_c, 20);
  assertEquals(qualifyRoomEvidenceBlocks([split[0]], "synthetic", at(100), at(260)).sourceFreshness.room.inferred, 0);
});

Deno.test("whole replacement heals late newest, middle hole and missing meter and retracts previously observed data", async () => {
  const first = await block([row(0), row(2, { heat_w: null })], 0, 3);
  const last = await block([row(3)], 3, 5);
  const manifest = [first, last];
  const read = () => qualifyRoomEvidenceBlocks(manifest, "synthetic", at(0), at(5)).quarters;
  assertEquals(read().map(r => [r.start_ts, r.heat_w]), [[at(0), 0], [at(2), null], [at(3), 0]]);
  const corrected = [row(0), row(1), row(2, { heat_w: 120 }), row(4)];
  manifest[1] = await block([row(4)], 3, 5);
  manifest[0] = await block(corrected.slice(0, 3), 0, 3);
  assertEquals(read(), qualifyRoomEvidenceBlocks([await block(corrected, 0, 5)], "synthetic", at(0), at(5)).quarters);
  manifest[0] = await block([], 0, 3);
  assertEquals(read().map(r => r.start_ts), [at(4)]);
});

Deno.test("block coverage is continuous while native observations can have gaps and span internal seams", async () => {
  assertEquals(qualifyRoomEvidenceBlocks([], "synthetic", at(1), at(1)).quarters, []);
  const early = await block([row(0), row(1.25, { duration_s: 3600 })], 0, 4);
  const late = await block([row(6, { duration_s: 900 }), row(7.25, { duration_s: 3600 })], 4, 12);
  const read = (blocks: typeof early[]) => qualifyRoomEvidenceBlocks(blocks, "synthetic", at(1), at(10));
  assertEquals(read([late, early]).quarters.map(r => r.start_ts), [at(1.25), at(6)]);
  assertThrows(() => read([early]), Error, "Incomplete");
  assertThrows(() => read([late]), Error, "Incomplete");
  assertThrows(() => read([early, early, late]), Error, "Overlapping");
  assertThrows(() => read([early, { ...late, rows: [row(6, { room_key: "other" })] }]), Error, "owner");
});

Deno.test("invalid archive inputs fail without silently converting measurements or unknown fields", async () => {
  const encode = (rows: ThermalQuarterRow[]) => encodeRoomEvidenceCapture(rows, at(0), at(2));
  for (const bad of [
    { heat_w: Infinity }, { heat_w: "0" }, { cooling: "unknown" }, { probe_evidence: [probe(), probe()] },
    { probe_evidence: [probe({ unavailable: "false" as unknown as boolean })] }, { duration_s: 1800 },
    { extra_future_field: true }, { room_temperature_c: undefined },
  ]) await assertRejects(() => encode([row(0, bad as Partial<ThermalQuarterRow>)]));
  await assertRejects(() => encode([row(0), row(0)]), Error, "interval order");
  await assertRejects(() => encode([row(0), row(1, { room_key: "other" })]), Error, "owner");
  await assertRejects(() => encode([row(2)]), Error, "outside block");
  await assertRejects(() => encodeRoomEvidenceCapture([], at(0), at(961)), Error, "block range");
  await assertRejects(() => encode(Array.from({ length: 961 }, () => row(0))), Error, "row count");

  // A matching digest authenticates bytes, not the schema inside them.
  const invalid = ["bad-index", 0, null, 18, true, true, null, null];
  const json = JSON.stringify({ version: 1, from: START, to: Date.parse(at(2)), strings: ["probe"],
    rows: [{ ...row(0), probe_evidence: [invalid] }] });
  const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  await assertRejects(() => decodeRoomEvidenceCapture(btoa(String.fromCharCode(...bytes)), at(0), at(2), sha), Error, "source index");
});
