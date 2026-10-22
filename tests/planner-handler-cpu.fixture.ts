import fixture from "./planner-handler-cpu.fixture.json" with { type: "json" };
import type { OptimisationPlan, OptimisationSnapshot } from "../supabase/functions/_shared/planner/planning-contracts.ts";
import { prepareRulesPlanningInput } from "../supabase/functions/_shared/rules-planner.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";

/** Full household and service-window complexity; no customer or entity identifiers. */
export function cpuPlanningInput() {
  return prepareRulesPlanningInput(cpuPlanningSource(), null, resolveRulePolicy());
}

/** Admission also owns room scheduling, which the original worker-only gate missed. */
export function cpuPlanningSource(withRooms = false) {
  const snapshot = structuredClone(fixture.snapshot) as OptimisationSnapshot;
  if (withRooms) {
    const n = snapshot.slots.length;
    snapshot.thermal_zones = [];
    snapshot.house_temperature_c = Array(n).fill(21);
    for (let room = 0; room < 9; room++) {
      const key = `cpu_room_${room}`;
      const target = snapshot.slots.map((_, i) => i % 96 >= 24 && i % 96 < 88 ? 22 : 18);
      snapshot.device_models.push({ key, name: key, statistic_id: `sensor.${key}`, category: "heating",
        suggested_load_type: "duty_cycle", load_type: "duty_cycle", planning_role: "controllable", control_type: "setpoint",
        thermostat: { entity_id: `climate.${key}`, minimum_c: 5, maximum_c: 35, step_c: .5,
          current_temperature_c: 20, target_temperature_c: 20, hvac_action: "idle" },
        active_power_w: 800, profile_sample_count: 1000, forecast_w_by_slot: Array(n).fill(200) });
      snapshot.operating_scope!.device_owners[key] = key;
      snapshot.operating_scope!.modes[key] = "controlling";
      snapshot.thermal_zones.push({ key, name: key, device_keys: [key],
        model: room < 7 ? { gain_c_per_wh: .001, cooling_constant_per_h: 0, background_gain_c_per_h: -.5,
          house_coupling_per_h: .1, heat_lag_h: 2, thermal_capacity_wh_per_c: 1000, heat_loss_w_per_c: 20,
          time_constant_h: 50, heating_rate_c_per_h: .8, r2: .95, sample_count: 1000, residual_std_c: .1 } : null,
        start_temperature_c: 20, rated_power_w: 800, comfort_min_c: target, target_c: target,
        comfort_max_c: Array(n).fill(22.5), maximum_power_w_by_slot: Array(n).fill(800), unplanned_power_w: Array(n).fill(200) });
    }
  }
  return { snapshot, now: fixture.now, resolved_price_outlook: fixture.resolved_price_outlook as OptimisationPlan["price_outlook"] };
}

/** A single room's action/latch product must fit too, not just many simple rooms. */
export function cpuMixedRoomPlanningSource() {
  const source = cpuPlanningSource(true);
  const snapshot = source.snapshot;
  const members = snapshot.device_models.filter(device => device.key.startsWith("cpu_room_")).slice(0, 4);
  for (const member of members.slice(2)) {
    member.control_type = "switch_schedule";
    delete member.thermostat;
  }
  const zone = snapshot.thermal_zones![0];
  snapshot.thermal_zones = [{ ...zone, device_keys: members.map(device => device.key),
    rated_power_w: 3200, maximum_power_w_by_slot: snapshot.slots.map(() => 3200) }];
  return source;
}

/** Varying house forcing exercises physical memo invalidation every quarter. */
export function cpuVaryingRoomPlanningSource() {
  const source = cpuPlanningSource(true);
  source.snapshot.house_temperature_c = source.snapshot.slots.map((_, i) => 21 + .3 * Math.sin(i / 16));
  return source;
}
