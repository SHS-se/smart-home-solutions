import {
  assert,
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
// This function cannot be exercised without a database, so its type contract
// is asserted against the migration text instead. That is weaker than running
// it, and it is the only check available here.

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

Deno.test("the caller passes the sample threshold the fit will apply", () => {
  // One rule, in one place: SQL chooses the sample set with the same minimum
  // the TypeScript fit would have rejected it for missing.
  const ingest = Deno.readTextFileSync(
    "supabase/functions/energy-optimisation-ingest/index.ts",
  );
  assertStringIncludes(ingest, "p_min_samples: MIN_TRAINING_SAMPLES");
  assertStringIncludes(migration, "p_min_samples integer DEFAULT 480");
});

Deno.test("a failed refit is logged and stepped over, never thrown", () => {
  // A refit is maintenance. Throwing turned "this zone could not be
  // re-learned" into "this house gets no plan", which is how one type
  // mismatch stopped a battery, a boiler, a pool and a car for a day.
  const ingest = Deno.readTextFileSync(
    "supabase/functions/energy-optimisation-ingest/index.ts",
  );
  assertStringIncludes(ingest, '"[ENERGY-OPTIMISATION] zone refit skipped"');
  assert(
    !ingest.includes("if (error) throw error;"),
    "the training moments error must not be rethrown as a snapshot rejection",
  );
});
