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
  "supabase/migrations/20260815113000_include_on_off_room_heaters.sql",
);
const optimiser = await Deno.readTextFile(
  "supabase/functions/_shared/planner/energy-optimisation.ts",
);

Deno.test("every Ready room control is visible regardless of actuator style", () => {
  assert(!comfortTab.includes(".eq('category', 'heating')"));
  assertStringIncludes(
    comfortTab,
    ".in('control_type_override', ['setpoint', 'switch_schedule'])",
  );
  assertStringIncludes(ingest, 'model.control_type !== "switch_schedule"');
  assert(!ingest.includes(
    'model.control_type === "setpoint" && model.category === "heating"',
  ));
  assert(!migration.includes("device.category = 'heating'"));
  assertStringIncludes(
    migration,
    "device.control_type_override IN ('setpoint', 'switch_schedule')",
  );
  assertStringIncludes(
    optimiser,
    '!["setpoint", "switch_schedule"].includes(',
  );
  assertStringIncludes(
    migration,
    "INSERT INTO public.energy_optimisation_comfort_schedules",
  );
});
