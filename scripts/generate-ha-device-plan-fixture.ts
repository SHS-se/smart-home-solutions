import { dispatchedEvSnapshot } from "./generate-ha-plan-fixture.ts";
import {
  generateOptimisationPlan,
  type OptimisationSnapshot,
} from "../supabase/functions/_shared/energy-optimisation.ts";
export function commandSnapshot(): OptimisationSnapshot {
  const snapshot: OptimisationSnapshot = {
    ...dispatchedEvSnapshot(),
    schema_version: 7,
  };
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.capabilities.ev = false;
  snapshot.ev_battery = null;
  snapshot.services = [];
  const n = snapshot.slots.length;
  const series = (v: number) => Array(n).fill(v);
  snapshot.device_models = [
    { key: "relay", control_type: "switch_schedule" as const },
    { key: "thermostat", control_type: "setpoint" as const },
  ].map((m) => ({
    ...m,
    name: m.key,
    statistic_id: `sensor.${m.key}`,
    category: "heating",
    suggested_load_type: "duty_cycle",
    load_type: "duty_cycle",
    planning_role: "controllable",
    active_power_w: 1000,
    profile_sample_count: 1000,
    forecast_w_by_slot: series(750),
  }));
  snapshot.outdoor_temperature_c = series(15);
  snapshot.thermal_zones = [{
    key: "room",
    name: "Room",
    device_keys: ["relay", "thermostat"],
    model: {
      gain_c_per_wh: .001,
      cooling_constant_per_h: .05,
      background_gain_c_per_h: 0,
      thermal_capacity_wh_per_c: 1000,
      heat_loss_w_per_c: 50,
      time_constant_h: 20,
      heating_rate_c_per_h: 2,
      r2: .95,
      sample_count: 1000,
      residual_std_c: .1,
    },
    start_temperature_c: 20,
    rated_power_w: 2000,
    comfort_min_c: series(19),
    target_c: series(21),
    comfort_max_c: series(24),
    maximum_power_w_by_slot: series(2000),
    unplanned_power_w: series(1500),
  }];
  return snapshot;
}

export function devicePlanFixture() {
  const snapshot = commandSnapshot();
  return {
    validation_time: snapshot.slots[0].start,
    plan: {
      ...generateOptimisationPlan(snapshot, new Date(snapshot.captured_at)),
      plan_id: "eedefc70-b625-42f0-be09-b1e79c0c88d9",
    },
  };
}
if (import.meta.main) {
  await Deno.writeTextFile(
    new URL(
      "../contracts/ha-api/fixtures/schema-7-device-plan.json",
      import.meta.url,
    ),
    JSON.stringify(devicePlanFixture(), null, 2) + "\n",
  );
}
