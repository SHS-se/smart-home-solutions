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
