import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const comfortTab = await Deno.readTextFile(
  "src/components/portal/energy/ComfortSchedulesTab.tsx",
);
const ingest = await Deno.readTextFile(
  "supabase/functions/energy-optimisation-ingest/index.ts",
);
const migration = await Deno.readTextFile(
  "supabase/migrations/20260815100000_make_setpoint_role_category_independent.sql",
);

Deno.test("every Ready setpoint room is visible regardless of inferred category", () => {
  assert(!comfortTab.includes(".eq('category', 'heating')"));
  assertStringIncludes(ingest, 'model.control_type === "setpoint"');
  assert(!ingest.includes(
    'model.control_type === "setpoint" && model.category === "heating"',
  ));
  assert(!migration.includes("device.category = 'heating'"));
  assertStringIncludes(
    migration,
    "INSERT INTO public.energy_optimisation_comfort_schedules",
  );
});
