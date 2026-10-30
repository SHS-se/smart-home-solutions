/** Independently specified synthetic equipment and observations. No household data.
 * These inputs and their physical oracles are never generated from planner output.
 */
import type { OptimisationSnapshot } from "../../supabase/functions/_shared/planner/planning-contracts.ts";

export function syntheticHome(quarters = 24): OptimisationSnapshot {
  const first = Date.UTC(2026, 0, 12);
  const starts = Array.from({ length: quarters }, (_, i) => new Date(first + i * 900_000).toISOString());
  const source = { provider: "synthetic", entity_ids: [], issued_at: starts[0],
    valid_until: new Date(first + quarters * 900_000).toISOString(), quality: "measured" as const };
  return {
    schema_version: 8, mode: "live", snapshot_id: "00000000-0000-4000-8000-000000000001", captured_at: starts[0],
    timezone: "UTC", slot_minutes: 15, capabilities: { battery: false, pv: false, pool: false, boiler: false, ev: true },
    slots: starts.map(start => ({ start, base_load_forecast_w: 500, pv_forecast_w: 0, import_price_sek_per_kwh: .2, export_price_sek_per_kwh: .1 })),
    sources: { pv: source, base_load: source, import_price: source, export_price: source, battery: null },
    pv_calibration: { correction_factor_by_lead_day: [1, 1, 1, 1], sample_count_by_lead_day: [0, 0, 0, 0] },
    battery: null, pool: null,
    ev_battery: { name: "Synthetic EV", connected: true, capacity_kwh: 75, soc: .05, charge_limit_soc: .8,
      charge_efficiency: .92, kwh_per_km: .16, available_from: starts[0], priority: 3,
      source_entity_ids: { connected: "binary_sensor.synthetic_cable", soc: "sensor.synthetic_soc", target_soc: "number.synthetic_limit" } },
    comfort: { ev: { floor_soc: .3 } },
    value_settings: { battery_degradation_sek_per_kwh: .05, vehicle_fallback_sek_per_km: null },
    grid: { import_limit_w: 15000, export_limit_w: 15000 },
    policy: { battery_end_of_solar_target_soc: 0, battery_target_is_hard: false, terminal_soc_min: 0,
      terminal_energy_value_sek_per_kwh: 0, battery_export_enabled: false, battery_export_reserve_soc: 0, battery_export_min_price_sek_per_kwh: 0 },
    device_models: [], services: [{ id: "synthetic_ev_horizon", device: "ev", earliest_start: starts[0], deadline: source.valid_until,
      required_kwh: 0, priority: 3, control: { type: "discrete_current", min_current_a: 5, max_current_a: 16, current_step_a: 1, phase_count: 3, voltage_v: 230 } }],
    service_requirement_sample_days: {},
  };
}

export function withPool(s = syntheticHome()): OptimisationSnapshot {
  s.capabilities.pool = true;
  s.pool = { volume_m3: 40, water_temperature_c: 26, heating_running: true };
  s.comfort = { ...s.comfort, pool: { target_c: 30 } };
  s.outdoor_temperature_c = s.slots.map(() => 10);
  s.pool_model = { loss_kw_per_k: 0, rated_cop: 4, cop_per_air_c: null,
    heater_response: { kind: "steady" }, hardware: { start_c: 28, stop_c: 34, control: "external_enable",
      source_entity_ids: { start: "number.synthetic_start", stop: "number.synthetic_stop" } } };
  s.device_models.push({ key: "synthetic_pool", name: "Synthetic pool heater", statistic_id: "sensor.synthetic_pool",
    category: "pool_heating", planning_service: "pool", pool_role: "heater", planning_role: "controllable",
    suggested_load_type: "fixed_full_load", load_type: "fixed_full_load", control_type: "switch_schedule",
    active_power_w: 3600, profile_sample_count: 100, forecast_w_by_slot: s.slots.map(() => 1000) });
  return s;
}

export function withHotWater(s = syntheticHome()): OptimisationSnapshot {
  s.capabilities.boiler = true;
  s.services.push({ id: "synthetic_water", device: "boiler", priority: 1, required_kwh: 1,
    earliest_start: s.slots[0].start, deadline: new Date(Date.parse(s.slots.at(-1)!.start) + 900000).toISOString(),
    control: { type: "duty_cycle", rated_power_w: 2000, expected_power_w_by_slot: s.slots.map(() => 500) } });
  s.device_models.push({ key: "synthetic_water", name: "Synthetic water", statistic_id: "sensor.synthetic_water", category: "hot_water",
    load_type: "duty_cycle", suggested_load_type: "duty_cycle", planning_role: "controllable", control_type: "permit_inhibit",
    active_power_w: 2000, profile_sample_count: 100, forecast_w_by_slot: s.slots.map(() => 500) });
  return s;
}

/** Independent 1-second integration of dT/dh = P/1000 + .03*(outside-T).
 * No production transition, fitting, score or schedule is used to generate history.
 */
export function roomObservations() {
  let temperature = 19;
  return Array.from({ length: 14 * 96 }, (_, i) => {
    const outside = 5 + 3 * Math.sin(i / 36), heat = i % 37 < 13 ? 1000 : 0;
    const row = { start_ms: i * 900_000, room_c: temperature, outdoor_c: outside, house_c: null,
      solar_w_per_m2: null, heat_w: heat, cooling: false };
    for (let second = 0; second < 900; second++) temperature += (.001 * heat + .03 * (outside - temperature)) / 3600;
    return row;
  });
}

export function roomHome(model: NonNullable<NonNullable<OptimisationSnapshot["thermal_zones"]>[number]["model"]>) {
  const s = syntheticHome(48);
  s.capabilities.ev = false; s.ev_battery = null; s.services = []; s.comfort = null;
  s.outdoor_temperature_c = s.slots.map(() => 10);
  s.slots = s.slots.map(slot => ({ ...slot, import_price_sek_per_kwh: 1 }));
  s.device_models = [{ key: "synthetic_relay", name: "Synthetic relay", statistic_id: "sensor.synthetic_relay", category: "heating",
    suggested_load_type: "fixed_full_load", load_type: "fixed_full_load", control_type: "switch_schedule", planning_role: "controllable",
    active_power_w: 1000, profile_sample_count: 100, forecast_w_by_slot: s.slots.map(() => 300) }];
  s.thermal_zones = [{ key: "synthetic_room", name: "Synthetic room", device_keys: ["synthetic_relay"], model,
    start_temperature_c: 18, rated_power_w: 1000, comfort_min_c: s.slots.map(() => 20), target_c: s.slots.map(() => 20),
    comfort_max_c: s.slots.map(() => 20.5), maximum_power_w_by_slot: s.slots.map(() => 1000), unplanned_power_w: s.slots.map(() => 300) }];
  return s;
}
