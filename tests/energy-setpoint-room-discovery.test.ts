import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const comfortTab = await Deno.readTextFile(
  "src/components/portal/energy/ComfortSchedulesTab.tsx",
);
const capture = await Deno.readTextFile(
  "supabase/functions/_shared/room-model-capture.ts",
);
const migration = await Deno.readTextFile(
  "supabase/migrations/20260815113000_include_on_off_room_heaters.sql",
);
const optimiser = await Deno.readTextFile(
  "supabase/functions/_shared/rules-room-services.ts",
);

Deno.test("every Ready room control is visible regardless of actuator style", () => {
  assert(!comfortTab.includes(".eq('category', 'heating')"));
  assertStringIncludes(
    comfortTab,
    ".in('control_type_override', ['setpoint', 'switch_schedule'])",
  );
  assertStringIncludes(capture, 'model.control_type !== "switch_schedule"');
  assert(!capture.includes(
    'model.control_type === "setpoint" && model.category === "heating"',
  ));
  assert(!migration.includes("device.category = 'heating'"));
  assertStringIncludes(
    migration,
    "device.control_type_override IN ('setpoint', 'switch_schedule')",
  );
  assertStringIncludes(
    optimiser,
    'm.control_type === "switch_schedule"',
  );
  assertStringIncludes(
    migration,
    "INSERT INTO public.energy_optimisation_comfort_schedules",
  );
});
