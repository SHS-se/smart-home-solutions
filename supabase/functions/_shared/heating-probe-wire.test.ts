import { assertEquals, assertThrows } from "@std/assert";
import { decodeHeatingProbeCapture, type HeatingProbeCapture } from "./heating-probe-wire.ts";

const first = { source_key: "synthetic-probe", area_key: "synthetic-old-area", cohort_key: "synthetic-bridge" };
const moved = { source_key: first.source_key, area_key: "synthetic-new-area", cohort_key: null };
type CompactRow = HeatingProbeCapture["rows"][number];

function interval(start: number, probe_values: CompactRow["probe_values"]): CompactRow {
  return { room_key: "synthetic-room", room_name: "Synthetic room", active_power_w: 700,
    start_ts: new Date(start).toISOString(), room_temperature_c: 20, cooling: false, duration_s: 3600 as const,
    source: "recorder_hour_mean", heat_attributed: false, temperature_source_key: first.source_key,
    outdoor_temperature_c: -4, solar_w_per_m2: null, house_temperature_c: 21, heat_w: 450, probe_values };
}

const decode = (value: unknown) => decodeHeatingProbeCapture(value, "synthetic-room");

Deno.test("the compact read preserves nullable probe facts, room means and measured heat", () => {
  const rows = [
    interval(0, [[0, 20, 0b01_00_01_10]]),
    { ...interval(3_600_000, [[1, null, 0b10_01_00_00]]), room_temperature_c: null },
    { ...interval(7_200_000, null), heat_w: 0 },
    { ...interval(10_800_000, []), heat_w: null },
  ];
  const packet = { sources: [first, moved], rows };
  const original = structuredClone(packet);
  const result = decode(packet);
  assertEquals(result, [
    { ...withoutValues(rows[0]), probe_evidence: [{ ...first, mean: 20,
      unchanged: true, joint_unchanged: false, reported: null, unavailable: false }] },
    { ...withoutValues(rows[1]), probe_evidence: [{ ...moved, mean: null,
      unchanged: null, joint_unchanged: null, reported: false, unavailable: true }] },
    { ...withoutValues(rows[2]), probe_evidence: null },
    { ...withoutValues(rows[3]), probe_evidence: [] },
  ]);
  assertEquals(packet, original);
  assertEquals(decode({ sources: [], rows: [] }), []);
});

function withoutValues({ probe_values: _, ...row }: ReturnType<typeof interval>) {
  return row;
}

Deno.test("malformed compact auxiliary encodings fail the learning read", () => {
  for (const values of [
    [[-1, 20, 0]], [[2, 20, 0]], [[0.5, 20, 0]], [[null, 20, 0]],
    [[0, null, -1]], [[0, 20, 171]], [[0, 20, 0b11]], [[0, 20, 0b11_00]], [[0, 20, 0b11_00_00]],
    [[0, 20, 0.5]], [[0, 20, "5"]], [[0, "20", 5]], [[0, Infinity, 5]], [[0, 20]],
  ]) assertThrows(() => decode({ sources: [first], rows: [{ ...interval(0, []), probe_values: values }] }), Error);
  assertThrows(() => decode({ sources: [first, moved], rows: [interval(0, [[0, 20, 0], [1, 20, 0]])] }),
    Error, "Duplicate physical probe");
  assertThrows(() => decode({ sources: [first, { ...first }], rows: [] }), Error, "Duplicate native room probe source");
  assertThrows(() => decode({ sources: [{ ...first, cohort_key: undefined }], rows: [] }),
    Error, "Malformed native room probe source");
  assertThrows(() => decode({ sources: [first], rows: [withoutValues(interval(0, null))] }),
    Error, "Malformed native room probe values");
});

Deno.test("the compact read rejects a malformed response or a row from another room", () => {
  assertThrows(() => decode([]), Error, "Malformed native room interval capture");
  assertThrows(() => decode({ sources: [], rows: [null] }), Error, "Malformed native room interval");
  assertThrows(() => decode({ sources: [], rows: [{ ...interval(0, null), room_key: "another-synthetic-room" }] }),
    Error, "crossed owner boundary");
});
