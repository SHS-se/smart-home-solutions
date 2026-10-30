import { assertEquals } from "@std/assert";
import { comfortTargets } from "./comfort-targets.ts";

Deno.test("a home that never set its targets is planned for the defaults", () => {
  assertEquals(comfortTargets(null), { pool: { target_c: 30 }, ev: { floor_soc: 0.3 } });
  assertEquals(comfortTargets(undefined), { pool: { target_c: 30 }, ev: { floor_soc: 0.3 } });
});

Deno.test("stored targets are used as given, whether the database returns numbers or numeric text", () => {
  assertEquals(comfortTargets({ pool_target_c: 28.5, ev_floor_soc: "50" }), { pool: { target_c: 28.5 }, ev: { floor_soc: 0.5 } });
});

Deno.test("an impossible stored value falls back to the default for that store only", () => {
  assertEquals(comfortTargets({ pool_target_c: 90, ev_floor_soc: 25 }), { pool: { target_c: 30 }, ev: { floor_soc: 0.25 } });
  assertEquals(comfortTargets({ pool_target_c: null, ev_floor_soc: "x" }), { pool: { target_c: 30 }, ev: { floor_soc: 0.3 } });
});
