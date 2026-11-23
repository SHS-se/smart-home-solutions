import { PGlite } from "@electric-sql/pglite";
import { assertEquals } from "@std/assert";

Deno.test("accepted service references preserve hardware and cutoff through repeated missing-state plans", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE SCHEMA private");
    await db.exec(await Deno.readTextFile("supabase/migrations/20261122235500_retain_unavailable_service_instructions.sql"));
    const charger = { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 };
    const slots = [true, false, null].map((permitted, i) => ({
      start: `2026-11-22T0${i}:00:00Z`, pool_permitted: permitted,
      pool_command_w: permitted === null ? null : permitted ? 3600 : 0,
      ev_target_current_a: permitted ? 8 : 0, ev_min_current_a: 0, ev_max_current_a: 16,
      device_loads_w: {}, device_commands: permitted === null ? {} : {
        synthetic_ev: { type: "variable_power", value: permitted ? 8 : 0, unit: "A" },
      },
    }));
    const reference = async (plan: unknown) => (await db.query<{ value: Record<string, unknown> }>(
      "SELECT private.energy_command_reference($1::jsonb,$2::jsonb) value",
      [JSON.stringify(plan), JSON.stringify({ operating_scope: { revision: 1, modes: { $ev: "controlling" } } })],
    )).rows[0].value;
    const first = await reference({ plan_id: "synthetic-healthy", pool: { planning_basis: "thermal", stop_temperature_c: 30 },
      services: [{ device: "ev", control: { type: "discrete_current", ...charger } }], plans: { priority: { slots } } });
    assertEquals(first.ev_charger, charger);
    assertEquals(first.pool_stop_temperature_c, 30);
    const repeated = await reference({ plan_id: "synthetic-outage", pool: null, services: [],
      retained_ev_charger: first.ev_charger, retained_pool_stop_temperature_c: first.pool_stop_temperature_c,
      plans: { priority: { slots } } });
    assertEquals(repeated.ev_charger, charger);
    assertEquals(repeated.pool_stop_temperature_c, 30);
    assertEquals(repeated.slots, first.slots, "OFF and unavailable remain distinct instructions");
    const missing = await reference({ plans: { priority: { slots: [] } } });
    assertEquals(missing.ev_charger, null);
    assertEquals(missing.pool_stop_temperature_c, null);
    assertEquals(missing.slots, []);
  } finally {
    await db.close();
  }
});
