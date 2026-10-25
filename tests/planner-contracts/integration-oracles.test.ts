import { assertThrows } from "@std/assert";
import { electricalOpening, roomExecution } from "./integration-oracles.ts";

Deno.test("integration electrical oracle rejects endpoint-only EV and averaged pool substitutes", () => {
  const slot = {
    pool_w: 3600,
    ev_target_current_a: 12,
    ev_w: 8280,
    grid_import_w: 12380,
  };
  electricalOpening(slot, 12, 12380);
  for (const current of [5, 16]) {
    assertThrows(() =>
      electricalOpening({ ...slot, ev_target_current_a: current }, 12, 12380)
    );
  }
  assertThrows(() => electricalOpening({ ...slot, pool_w: 1200 }, 12, 12380));
  assertThrows(() =>
    electricalOpening({ ...slot, grid_import_w: 14000 }, 12, 12380)
  );
});

Deno.test("integration room oracle rejects a graph with heat commands and flat temperature", () => {
  assertThrows(() =>
    roomExecution(Array(288).fill("on"), {
      planned_power_w: Array(288).fill(1000),
      planned_temperature_c: Array(288).fill(18),
    })
  );
  assertThrows(() =>
    roomExecution(Array(288).fill("on"), {
      planned_power_w: Array(288).fill(500),
      planned_temperature_c: Array(288).fill(18),
    })
  );
});
