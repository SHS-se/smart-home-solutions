import { assertEquals, assertThrows } from "@std/assert";
import { reportedPoolHardware, samePoolHardware } from "./pool-hardware.ts";

const hardware = () => ({
  start_c: 33.5,
  stop_c: 34,
  control: "external_enable" as const,
  source_entity_ids: { start: "number.pool_start", stop: "number.pool_stop" },
});

Deno.test("the heater settings a snapshot reports are read as sent", () => {
  assertEquals(reportedPoolHardware({ water_temperature_c: 30, hardware: { ...hardware(), extra: 1 } }), hardware());
});

Deno.test("a snapshot that reports no heater settings leaves the stored copy standing", () => {
  for (const pool of [undefined, null, {}, { water_temperature_c: 30 }, { hardware: null }]) {
    assertEquals(reportedPoolHardware(pool), null);
  }
});

Deno.test("reported heater settings that cannot be read are refused, not replaced", () => {
  for (const broken of [
    { ...hardware(), start_c: "33.5" },
    { ...hardware(), stop_c: Number.NaN },
    { ...hardware(), control: "setpoint" },
    { ...hardware(), source_entity_ids: { start: "number.pool_start" } },
    { ...hardware(), source_entity_ids: null },
    "34",
  ]) assertThrows(() => reportedPoolHardware({ hardware: broken }), Error, "unreadable");
});

Deno.test("the stored copy is rewritten only when the equipment was changed", () => {
  // Postgres returns jsonb keys in its own order, so the comparison is by field.
  const stored = { stop_c: 34, control: "external_enable", start_c: 33.5,
    source_entity_ids: { stop: "number.pool_stop", start: "number.pool_start" } };
  assertEquals(samePoolHardware(stored, hardware()), true);
  assertEquals(samePoolHardware({ ...stored, start_c: 28 }, hardware()), false);
  assertEquals(samePoolHardware({ ...stored, source_entity_ids: { ...stored.source_entity_ids, stop: "number.other" } }, hardware()), false);
  assertEquals(samePoolHardware(null, hardware()), false);
});
