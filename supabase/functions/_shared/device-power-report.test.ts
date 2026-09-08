import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { devicePowerReport } from "./device-power-report.ts";

Deno.test("unsupported inventory power becomes unknown, never a clamped scheduling value", () => {
  for (const value of [100_001, -1, NaN, Infinity, "1000", undefined]) {
    assertEquals(devicePowerReport(value), { power: null, rejected: true });
  }
});

Deno.test("supported and unknown inventory power are preserved", () => {
  for (const value of [null, 0, 1200, 100_000]) {
    assertEquals(devicePowerReport(value), { power: value, rejected: false });
  }
});
