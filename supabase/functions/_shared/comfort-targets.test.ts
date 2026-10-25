import { assertEquals } from "@std/assert";
import { comfortTargets } from "./comfort-targets.ts";

const car = { capacity_kwh: 80, kwh_per_km: 0.2 };

Deno.test("a home that never set its targets is planned for the defaults", () => {
  assertEquals(comfortTargets(null), { pool: { target_c: 30 }, ev: { target_km: 300 } });
  assertEquals(comfortTargets(undefined, car), { pool: { target_c: 30 }, ev: { target_km: 320 } });
});

Deno.test("stored targets are used as given, whether the database returns numbers or numeric text", () => {
  assertEquals(comfortTargets({ pool_target_c: 28.5, ev_target_soc: "50" }, car), { pool: { target_c: 28.5 }, ev: { target_km: 200 } });
});

Deno.test("the car's charge level becomes the range its own battery holds", () => {
  assertEquals(comfortTargets({ pool_target_c: 30, ev_target_soc: 100 }, { capacity_kwh: 60, kwh_per_km: 0.15 }).ev, { target_km: 400 });
  assertEquals(comfortTargets({ pool_target_c: 30, ev_target_soc: 100 }, null).ev, { target_km: 300 });
});

Deno.test("an impossible stored value falls back to the default for that store only", () => {
  assertEquals(comfortTargets({ pool_target_c: 90, ev_target_soc: 25 }, car), { pool: { target_c: 30 }, ev: { target_km: 100 } });
  assertEquals(comfortTargets({ pool_target_c: null, ev_target_soc: "x" }, car), { pool: { target_c: 30 }, ev: { target_km: 320 } });
});
