import { handleDeviceLearning } from "../supabase/functions/_shared/device-learning-worker.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// `get_energy_thermal_training_moments` returned `numeric` sums against a
// `double precision` result declaration, and PL/pgSQL's `RETURN QUERY` applies
// no implicit cast — so every call failed with 42804, "structure of query does
// not match function result type".
//
// It went unnoticed for weeks because nothing reached it: room heating is
// locked out June to August, and the lockout returns before the fit is ever
// requested. The first call after the season turned was the first call ever,
// and it took the whole plan down with it rather than one refit.
//
// The historical SQL type contract remains asserted against its migration.
// Current observation behavior is exercised with PGlite in
// room-training-observations-sql.test.ts; lifecycle publication/fencing is
// exercised in device-learning-lifecycle.test.ts.

const migration = await Deno.readTextFile(
  "supabase/migrations/20260830180000_fit_solar_gain_into_zone_models.sql",
);

const returnsTable = migration.slice(
  migration.indexOf("RETURNS TABLE ("),
  migration.indexOf("LANGUAGE plpgsql"),
);

Deno.test("every design column the sums are built from is cast to double precision", () => {
  // The sums inherit their type from these six. Casting here, once, is what
  // keeps twenty result columns honest.
  for (
    const column of [
      "paired.p_w::double precision AS p",
      "(paired.t_out - paired.t_in)::double precision AS d",
      "((paired.t_next - paired.t_in) / 0.25)::double precision AS y",
      "paired.t_in::double precision AS t_in",
      "paired.t_out::double precision AS t_out",
      "paired.irradiance::double precision AS i",
    ]
  ) {
    assertStringIncludes(migration, column);
  }
});

Deno.test("no sum is declared double precision while reading a numeric column", () => {
  // The trap is that every underlying column is numeric: metered energy, both
  // temperatures, and irradiance. Any design column reaching a sum uncast
  // reintroduces 42804 for the whole function, not just that column.
  const usable = migration.slice(
    migration.indexOf("  usable AS ("),
    migration.indexOf("  coverage AS ("),
  );
  // Only the selected expressions: the CTE header and the WHERE clause are
  // not design columns.
  const selected = usable
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      (line.startsWith("paired.") || line.startsWith("(paired.") ||
        line.startsWith("((paired.")) && line.includes(" AS ")
    )
    .filter((line) => !line.includes("room_key"));
  assert(selected.length > 0, "the usable CTE selected nothing");
  for (const line of selected) {
    assert(
      line.includes("::double precision"),
      `design column reaches a sum uncast: ${line.trim()}`,
    );
  }
});

Deno.test("the counts stay bigint and the rated power stays numeric", () => {
  // Not everything should be cast. `count(*)` is already bigint and
  // `active_power_w` is summed straight out of a numeric column, so both are
  // declared as what they are rather than forced to match their neighbours.
  assertStringIncludes(returnsTable, "n bigint");
  assertStringIncludes(returnsTable, "n_heated bigint");
  assertStringIncludes(returnsTable, "active_power_w numeric");
  assertStringIncludes(returnsTable, "uses_solar boolean");
});

Deno.test("the training quarters cast every numeric column they return", () => {
  // The fit now reads quarters rather than sums, through the same RETURN QUERY
  // trap: every temperature, irradiance and energy column underneath is numeric.
  const quarters = Deno.readTextFileSync(
    "supabase/migrations/20261020120000_house_temperature_room_boundary.sql",
  );
  const body = quarters.slice(
    quarters.indexOf("get_energy_thermal_training_quarters("),
    quarters.indexOf("REVOKE ALL ON FUNCTION public.get_energy_thermal_training_quarters"),
  );
  for (
    const column of [
      "room.active_power_w::double precision",
      "slot.room_temperature_c::double precision",
      "outdoor.temperature_c::double precision",
      "outdoor.solar_w_per_m2::double precision",
      "house.temperature_c::double precision",
      "(COALESCE(energy.energy_kwh, 0) * 4000.0)::double precision",
    ]
  ) assertStringIncludes(body, column);
  const learning = Deno.readTextFileSync(
    "supabase/functions/_shared/device-model-learning/room.ts",
  );
  // Three weeks of quarters is more than one PostgREST page.
  assertStringIncludes(learning, '"get_energy_thermal_training_quarters"');
  assertStringIncludes(learning, "readPagedRows<ThermalQuarterRow>");
});

Deno.test("a failed training read belongs to its durable learning attempt and never publishes a rejection", async () => {
  const calls: string[] = [];
  const claim = { id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
    owner_kind: "room", owner_key: "synthetic-room", generation: 2, fence: 3, input: { location: null } };
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "get_energy_thermal_training_quarters") return { eq: () => ({
        range: () => Promise.resolve({ data: null, error: { message: "synthetic training read failure" } }),
      }) };
      if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
      if (name === "claim_energy_device_learning") return Promise.resolve({ data: claim, error: null });
      if (name === "capture_energy_device_models") return Promise.resolve({ data: {
        rooms: [{ room_key: claim.owner_key, model_revision: 7, trained: true }], pool: null,
      }, error: null });
      if (name === "fail_energy_device_learning") {
        assertEquals(args.p_generation, claim.generation);
        assertEquals(args.p_fence, claim.fence);
        assertStringIncludes(String(args.p_error), "synthetic training read failure");
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error(`Unexpected learning RPC ${name}`);
    },
    from(table: string) { throw new Error(`Unexpected model write ${table}`); },
  };
  const response = await handleDeviceLearning(new Request("https://learning.test", {
    method: "POST", headers: { "x-energy-learning-token": "synthetic-token" }, body: JSON.stringify({ job_id: claim.id }),
  }), db);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "learning_failed" });
  assertEquals(calls, ["verify_energy_learning_token", "claim_energy_device_learning", "capture_energy_device_models",
    "get_energy_thermal_training_quarters", "fail_energy_device_learning"]);
  // SQL retry/retained-model semantics are independently executed by
  // tests/device-learning-lifecycle.test.ts. Ingest cannot import this worker
  // or its fitting code: tests/planner-component-boundaries.test.ts enforces it.
});
