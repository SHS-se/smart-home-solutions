import { assertEquals } from "@std/assert";
import { prepareActualUpload } from "./actual-upload.ts";

const now = Date.parse("2026-10-15T12:20:00Z");
const context = { customer_id: "c", home_id: "h", device_token_id: "t" };
const row = (start = "2026-10-15T12:00:00Z") => ({ start, total_load_kwh: .2,
  quality: { aggregation: "sum_of_recorder_5minute_changes", duration_seconds: 900 } });

Deno.test("old or future history does not reject usable quarters or the planning exchange", () => {
  const result = prepareActualUpload([row("2026-10-01T12:00:00Z"), row(), row("2026-10-16T12:00:00Z")], new Map(), context, now);
  assertEquals(result.actualRows.length, 1);
  assertEquals(result.ignored, { outside_history_window: 1, incomplete_or_future_actual: 1 });
});
Deno.test("one or five malformed quarters remain row-level warnings", () => {
  for (const count of [1, 5]) {
    const result = prepareActualUpload([...Array.from({ length: count }, () => ({ ...row(), total_load_kwh: 1000 })), row()], new Map(), context, now);
    assertEquals(result.actualRows.length, 1);
    assertEquals(result.warnings[0].severity, count === 5 ? "error" : "warning");
    assertEquals(result.ignored.invalid_actual_energy, count);
  }
});
Deno.test("invalid device energy does not discard the measured household quarter", () => {
  const result = prepareActualUpload([{ ...row(), device_energy_kwh: { broken: -1, boiler: .1 } }], new Map([["boiler", { id: "b" }]]), context, now);
  assertEquals(result.actualRows.length, 1);
  assertEquals(result.deviceSlotRows.length, 1);
  assertEquals(result.ignored.invalid_device_energy, 1);
});
Deno.test("a device quarter without household meter readings is stored and advances the watermark", () => {
  const quality = { aggregation: "sum_of_recorder_5minute_changes", duration_seconds: 900 };
  const devices = new Map([["pool", { id: "p" }]]);
  const result = prepareActualUpload([row("2026-10-15T11:45:00Z"),
    { start: "2026-10-15T12:00:00Z", quality, device_energy_kwh: { pool: .9 } }], devices, context, now);
  assertEquals(result.actualRows.map(r => r.start_ts), ["2026-10-15T11:45:00.000Z"]);
  assertEquals(result.deviceSlotRows.map(r => [r.start_ts, r.energy_kwh]), [["2026-10-15T12:00:00.000Z", .9]]);
  assertEquals(result.accepted_until, "2026-10-15T12:00:00.000Z");
  assertEquals(result.ignored, {});
  // A quarter with neither is still empty, and unknown devices do not advance the watermark.
  const empty = prepareActualUpload([{ start: "2026-10-15T12:00:00Z", quality },
    { start: "2026-10-15T11:45:00Z", quality, device_energy_kwh: { unknown: .1 } }], devices, context, now);
  assertEquals(empty.accepted_until, null);
  assertEquals(empty.ignored, { empty_actual_slot: 1, invalid_device_energy: 1 });
});
