// One realistic snapshot, shared by every test that needs the planner to run.
//
// Three sunny days at real Swedish August prices with a pool below its band —
// enough shape that a plan has decisions to make. It lives here rather than in
// one test file because two suites now need it: the curve preview, which asks
// what a different curve would do, and the plan workbench, which asks what a
// different *schedule* would be worth.





import type { OptimisationSnapshot } from '../../../supabase/functions/_shared/energy-optimisation.ts';

export const CAPTURED_AT = '2026-08-17T20:45:00.000Z';
export const START = Date.parse(CAPTURED_AT);

export const provenance = (
  quality: 'measured' | 'calibrated' | 'provider_raw' | 'synthetic',
) => ({
  provider: 'preview-test',
  entity_ids: ['sensor.x'],
  issued_at: CAPTURED_AT,
  valid_until: new Date(START + 6 * 3_600_000).toISOString(),
  quality,
  sample_count: 100,
});

/** Three sunny days at real Swedish August prices, and a pool below its band. */
export const snapshot = (): OptimisationSnapshot => {
  const slots = Array.from({ length: 288 }, (_value, index) => {
    const ms = START + index * 900_000;
    const hour = ((index / 4) + 22.75) % 24;
    const pv = hour >= 6 && hour <= 19
      ? Math.round(5_200 * Math.sin(((hour - 6) / 13) * Math.PI))
      : 0;
    const priced = index < 100;
    const importPrice = hour >= 18 ? 2.7 : hour < 5 ? 1.0 : 2.2;
    return {
      start: new Date(ms).toISOString(),
      pv_forecast_w: pv,
      base_load_forecast_w: 800,
      import_price_sek_per_kwh: priced ? importPrice : null,
      export_price_sek_per_kwh: priced ? (importPrice - 0.835) / 1.25 + 0.033 : null,
    };
  });
  return {
    schema_version: 6,
    mode: 'live',
    capabilities: { pv: true, battery: true, pool: true, boiler: false, ev: false },
    snapshot_id: '00000000-0000-4000-8000-000000000001',
    captured_at: CAPTURED_AT,
    timezone: 'Europe/Stockholm',
    slot_minutes: 15,
    slots,
    sources: {
      pv: { ...provenance('calibrated'), location: { latitude: 59.3, longitude: 18.1 } },
      base_load: provenance('measured'),
      import_price: { ...provenance('provider_raw'), entity_ids: ['sensor.buy'], location: { market_area: 'SE3' } },
      export_price: { ...provenance('provider_raw'), entity_ids: ['sensor.sell'], location: { market_area: 'SE3' } },
      battery: provenance('measured'),
      outdoor_temperature: provenance('provider_raw'),
    },
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [60, 60, 60, 60],
    },
    battery: {
      capacity_kwh: 18.08,
      soc: 0.652,
      min_soc: 0.05,
      max_soc: 1,
      charge_max_w: 8_800,
      discharge_max_w: 9_600,
      charge_efficiency: 0.95,
      discharge_efficiency: 0.95,
    },
    ev_battery: null,
    pool: { water_temperature_c: 27, volume_m3: 55 },
    outdoor_temperature_c: slots.map(() => 20),
    grid: { import_limit_w: 13_200, export_limit_w: 13_200 },
    policy: {
      battery_end_of_solar_target_soc: 0.8,
      battery_target_is_hard: false,
      terminal_soc_min: 0.05,
      terminal_energy_value_sek_per_kwh: 1,
      battery_export_enabled: false,
      battery_export_reserve_soc: 0.8,
      battery_export_min_price_sek_per_kwh: 2.5,
    },
    device_models: [],
    services: [],
    service_requirement_sample_days: {},
  };
};

/** The same household with explicit pool ownership and executable battery commands. */
export const snapshotV8 = (): OptimisationSnapshot => {
  const input = snapshot();
  input.schema_version = 8;
  input.device_models = [{
    key: 'pool-heater', name: 'Pool heater', statistic_id: 'sensor.pool_energy',
    category: 'pool_heating', planning_service: 'pool', suggested_load_type: 'fixed_full_load',
    load_type: 'fixed_full_load', planning_role: 'controllable',
    control_type: 'switch_schedule', active_power_w: 3500, profile_sample_count: 100,
    forecast_w_by_slot: input.slots.map(() => 0),
  }];
  input.services = [{
    id: 'pool:horizon', device: 'pool', earliest_start: input.slots[0].start,
    deadline: new Date(Date.parse(input.slots.at(-1)!.start) + 900000).toISOString(),
    required_kwh: 0, control: { type: 'fixed_power', power_w: 3500 }, priority: 2,
  }];
  return input;
};
