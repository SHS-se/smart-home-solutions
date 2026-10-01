import { assertEquals } from "@std/assert";
import { comfortTargets } from "./comfort-targets.ts";

Deno.test("a home that never set its targets is planned for the defaults", () => {
  assertEquals(comfortTargets(null), { pool: { target_c: 30 }, ev: { target_km: 300 } });
  assertEquals(comfortTargets(undefined), { pool: { target_c: 30 }, ev: { target_km: 300 } });
});

Deno.test("stored targets are used as given, whether the database returns numbers or numeric text", () => {
  assertEquals(comfortTargets({ pool_target_c: 28.5, ev_target_km: "350" }), { pool: { target_c: 28.5 }, ev: { target_km: 350 } });
});

Deno.test("an impossible stored value falls back to the default for that store only", () => {
  assertEquals(comfortTargets({ pool_target_c: 90, ev_target_km: 250 }), { pool: { target_c: 30 }, ev: { target_km: 250 } });
  assertEquals(comfortTargets({ pool_target_c: null, ev_target_km: "x" }), { pool: { target_c: 30 }, ev: { target_km: 300 } });
});
