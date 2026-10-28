import { dispatchedEvSnapshot } from './generate-ha-plan-fixture.ts';
import type { EmpiricalDeviceModelInput, OptimisationSnapshot, ServiceInput } from '../supabase/functions/_shared/planner/planning-contracts.ts';

/** Independent mathematical CPU workload: no replay or household-fit inputs.
 * Four device roles and six service windows retain the worker's full pipeline. */
export function syntheticCpuWorkload() {
  const start = Date.parse('2026-02-01T12:00:00.000Z'), n = 288;
  const at = (i: number) => new Date(start + i * 900_000).toISOString();
  const prices = Array.from({ length: n }, (_, i) => 1.2 + .6 * Math.cos((i % 96 - 12) * Math.PI / 48));
  const snapshot: OptimisationSnapshot = { ...dispatchedEvSnapshot(), schema_version: 11,
    snapshot_id: '33333333-3333-4333-8333-333333333333', captured_at: at(0), timezone: 'UTC',
    capabilities: { pv: true, battery: true, pool: true, boiler: true, ev: true },
    comfort: { pool: { target_c: 30.5 }, ev: { target_km: 280 } },
    grid: { import_limit_w: 16000, export_limit_w: 8000 },
    battery: { capacity_kwh: 12, soc: .45, min_soc: .1, max_soc: .95,
      charge_max_w: 5000, discharge_max_w: 6000, charge_efficiency: .99, discharge_efficiency: .98,
      conversion: { revision: 'synthetic-cpu-affine-v1', grid_charge: { gain: .95, overhead_w: 80 },
        surplus_charge: { gain: .97, overhead_w: 0 }, discharge: { gain: .96, overhead_w: 90 }, idle_loss_w: 70 } },
    pool: { water_temperature_c: 29.5, volume_m3: 35, heating_running: false },
    ev_battery: { ...dispatchedEvSnapshot().ev_battery!, name: 'Synthetic CPU car', capacity_kwh: 60,
      soc: .3, charge_limit_soc: .8, charge_efficiency: .93, kwh_per_km: .18,
      connected: true, available_from: null,
      source_entity_ids: { connected: 'binary_sensor.synthetic_cpu_cable', soc: 'sensor.synthetic_cpu_soc',
        target_soc: 'number.synthetic_cpu_limit', energy_remaining: null, charge_current: null } },
    slots: Array.from({ length: n }, (_, i) => ({ start: at(i),
      base_load_forecast_w: 900 + 300 * (1 + Math.sin(i * Math.PI / 24)),
      pv_forecast_w: 4500 * Math.max(0, Math.sin((i % 96 - 8) * Math.PI / 48)),
      import_price_sek_per_kwh: prices[i], export_price_sek_per_kwh: prices[i] * .5 })),
    outdoor_temperature_c: Array.from({ length: n }, (_, i) => 7 + 3 * Math.sin(i * Math.PI / 48)),
    thermal_zones: [], house_temperature_c: Array(n).fill(21),
    policy: { battery_target_is_hard: false, battery_end_of_solar_target_soc: .8,
      terminal_soc_min: .2, terminal_energy_value_sek_per_kwh: 1, battery_export_enabled: true,
      battery_export_reserve_soc: .8, battery_export_min_price_sek_per_kwh: 2 },
    value_settings: { battery_degradation_sek_per_kwh: .04, vehicle_fallback_sek_per_km: null },
    operating_scope: { modes: { $battery: 'controlling', $pool: 'controlling', $ev: 'controlling',
      synthetic_cpu_water: 'control_verification' },
      device_owners: { synthetic_cpu_ev: '$ev', synthetic_cpu_heater: '$pool',
        synthetic_cpu_pump: '$pool', synthetic_cpu_water: 'synthetic_cpu_water' }, external_demands: {} },
    battery_execution_feedback: { generation: 1, source_receipt: 0, previous_contract_id: null,
      scope_revision: 'synthetic-cpu-scope', objectives: [] },
  };
  const water = Array.from({ length: n }, (_, i) => i % 24 < 8 ? 450 : 120);
  const model = (key: string, category: EmpiricalDeviceModelInput['category'], control_type: EmpiricalDeviceModelInput['control_type'],
    watts: number, forecasts = Array(n).fill(0)): EmpiricalDeviceModelInput => ({ key, name: key,
    statistic_id: `sensor.${key}`, category, control_type, active_power_w: watts,
    planning_role: 'controllable', suggested_load_type: 'fixed_full_load', load_type: 'fixed_full_load',
    profile_sample_count: 1000, forecast_w_by_slot: forecasts });
  snapshot.device_models = [model('synthetic_cpu_ev', 'ev_charging', 'variable_power', 11040),
    { ...model('synthetic_cpu_water', 'hot_water', 'permit_inhibit', 1800, water),
      suggested_load_type: 'duty_cycle', load_type: 'duty_cycle' },
    { ...model('synthetic_cpu_heater', 'pool_heating', 'switch_schedule', 2200), planning_service: 'pool', pool_role: 'heater' },
    { ...model('synthetic_cpu_pump', 'pool_heating', 'switch_schedule', 400), planning_service: 'pool', pool_role: 'circulation' }];
  snapshot.operating_scope!.external_demands.synthetic_cpu_water = { forecast_w_by_slot: water,
    recent_observation: { start: at(-1), end: at(0), average_w: water[0], source: 'completed_meter_quarter' } };
  const hardware = { start_c: 30, stop_c: 34, control: 'external_enable' as const,
    source_entity_ids: { start: 'number.synthetic_cpu_start', stop: 'number.synthetic_cpu_stop' } };
  snapshot.pool!.hardware = hardware;
  const state = { at: at(0), pending_heat_kwh: .75, source_depletion_kwh: 3 };
  snapshot.pool_model = { hardware, loss_kw_per_k: .12, rated_cop: null, cop_per_air_c: null,
    pending_heat_kwh: state.pending_heat_kwh, source_depletion_kwh: state.source_depletion_kwh,
    heater_response: { kind: 'bergvarme', startup: Array.from({ length: 16 }, (_, i) => ({
      elapsed_seconds: i * 60, electric_fraction: (1 - Math.exp(-i / 3)) / (1 - Math.exp(-5)),
      heat_fraction: (1 - Math.exp(-i / 4)) / (1 - Math.exp(-15 / 4)) })) },
    thermal_dynamics: { version: 2, response_time_constant_h: .6, heat_c_per_kwh: .09,
      source: { recovery_rate_per_h: .2, heat_loss_c_per_kwh_per_kwh: .0004 },
      idle_c_per_h: -.04, reference_c: 30, sample_count: 1000, rmse_c: .02,
      instantaneous_rmse_c: .03, constant_gain_rmse_c: .04,
      recovery_evidence: { restarts: 12, shortest_off_h: .5, longest_off_h: 6,
        steady_heat_fraction_at_observed_peak: null, profile: [], minimum_at_search_boundary: false },
      initial_state: state, state } };
  const chargeControl = { type: 'discrete_current' as const, min_current_a: 5, max_current_a: 16,
    current_step_a: 1, phase_count: 3, voltage_v: 230 };
  snapshot.services = [{ id: 'synthetic-pool', device: 'pool', earliest_start: at(0), deadline: at(n),
    required_kwh: 0, control: { type: 'fixed_power', power_w: 2600 }, priority: 2 },
    { id: 'synthetic-ev', device: 'ev', earliest_start: at(0), deadline: at(n),
      required_kwh: 0, control: chargeControl, priority: 3 }];
  for (const [i, end] of [48, 144, 240, 288].entries()) {
    const first = i === 0 ? 0 : [48, 144, 240][i - 1];
    snapshot.services.push({ id: `synthetic-water-${i}`, device: 'boiler', earliest_start: at(first), deadline: at(end),
      required_kwh: water.slice(first, end).reduce((a, b) => a + b, 0) / 4000,
      control: { type: 'duty_cycle', rated_power_w: 1800, expected_power_w_by_slot: water }, priority: 1 } as ServiceInput);
  }
  snapshot.sources = Object.fromEntries(Object.entries(snapshot.sources).map(([key, value]) => [key,
    value ? { ...value, provider: 'synthetic-cpu', entity_ids: [`sensor.synthetic_cpu_${key}`],
      issued_at: at(0), valid_until: at(n), quality: 'synthetic' } : value])) as OptimisationSnapshot['sources'];
  snapshot.sources.battery = { ...snapshot.sources.base_load, provider: 'synthetic-cpu',
    entity_ids: ['sensor.synthetic_cpu_battery'], quality: 'synthetic' };
  snapshot.pv_calibration = { correction_factor_by_lead_day: [1, 1, 1, 1], sample_count_by_lead_day: [100, 100, 100, 100] };
  return { description: 'Independently invented synthetic 288-quarter affine-battery/source-recovery household, mathematical demand/solar/prices and six service windows; no household replay or fitted measured parameters.',
    generated_by: 'scripts/planner-handler-synthetic.fixture.ts', snapshot, now: at(0),
    resolved_price_outlook: { shaped: true, observed_days: 12, effective_days: 12, level_sek_per_kwh: 1.2,
      shadow_import_sek_per_kwh: prices } };
}

if (import.meta.main) await Deno.writeTextFile(new URL('../tests/planner-handler-cpu.fixture.json', import.meta.url),
  JSON.stringify(syntheticCpuWorkload(), null, 2) + '\n');
