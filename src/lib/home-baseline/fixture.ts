// Test data only; production loads the selected home's captured physical models.
import gridFixture from '../../../supabase/functions/_shared/grid-price-parity.fixture.json' with { type: 'json' };
import type { GridTariffCatalogue } from '../../../supabase/functions/_shared/energy-grid-pricing.ts';
import type { ComparisonCapture, BaselineCapture } from './browser';
import { REPLAY_ENGINE, REPLAY_PROTOCOL } from './scheduler-replay';
import { seriesService } from './model-comparison';
import { snapshot } from '../energy-shift/optimisation-snapshot.fixture.ts';
import { HOUSEHOLD } from '../planner-bench/household.ts';
import type { OptimisationSnapshot } from '../../../supabase/functions/_shared/planner/planning-contracts.ts';
import type { HistoricalRows } from './model.ts';

export function baselineFixture(range?: { start: string; end: string }): HistoricalRows & { snapshot: OptimisationSnapshot } {
  const captured = { ...snapshot(), criteria: {}, roi_solar_profile: null, roi_pool_seed: null };
  const meter = { statistic_id: 'test', suggested_load_type: 'fixed_full_load' as const, load_type: 'fixed_full_load' as const, planning_role: 'controllable' as const, control_type: 'setpoint' as const, profile_sample_count: 1000, forecast_w_by_slot: Array(288).fill(0) };
  const end = range?.end ?? '2026-10-26T00:00:00.000Z', start = range ? Date.parse(range.start) : Date.parse(end) - 72 * 3_600_000;
  captured.capabilities.ev = true;
  captured.ev_battery = { name: 'Home car', connected: true, capacity_kwh: 75.6, soc: .79, departure_target_soc: .8,
    charge_efficiency: .92, kwh_per_km: .16, available_from: null, departure: null, priority: 1, source_entity_ids: { connected: 'test', soc: 'test', target_soc: 'test', energy_remaining: null, charge_current: null } };
  captured.grid = { import_limit_w: 17_200, export_limit_w: 13_200 };
  captured.device_physics = structuredClone({ battery: HOUSEHOLD.battery, car: HOUSEHOLD.car, pool: HOUSEHOLD.pool });
  captured.comfort = { pool: { target_c: 30.5 }, ev: { target_km: 300 } };
  captured.value_settings = { battery_degradation_sek_per_kwh: .05, vehicle_fallback_sek_per_km: null };
  captured.pool_model = { loss_kw_per_k: .13, rated_cop: 4, cop_per_air_c: null,
    hardware: { start_c: 30, stop_c: 30.5, control: 'external_enable', source_entity_ids: {} }, heater_response: { kind: 'steady' } };
  captured.device_models = [
    { ...meter, key: 'pool_heater', name: 'Home pool heater', category: 'pool_heating', planning_service: 'pool', pool_role: 'heater', active_power_w: 2500 },
    { ...meter, key: 'pool_pump', name: 'Home pool pump', category: 'property_energy', planning_service: 'pool', pool_role: 'circulation', active_power_w: 764 },
    { ...meter, key: 'car', name: 'Home car', category: 'ev_charging', active_power_w: 11040 },
  ];
  const times = Array.from({ length: (Date.parse(end) - start) / 900_000 + 1 }, (_, i) => new Date(start + (i - 1) * 900_000).toISOString());
  return { tariff: testTariff(), snapshot: captured, priceArea: 'SE3', start: new Date(start).toISOString(), end, evInitial: { start_ts: times[0], ev_soc: .79 },
    actual: times.map(start_ts => ({ start_ts, total_load_kwh: .265, solar_production_kwh: 0, battery_soc: .5, ev_soc: .79, grid_import_kwh: .265, grid_export_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0 })),
    prices: times.slice(1).map(start_ts => ({ start_ts, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: .2, grid_import_price_sek_per_kwh: .5, source: 'archive', supplier_revision: '', spot_price_sek_per_kwh: .4 })),
    actualPrices: times.slice(1).map(start_ts => ({ start_ts, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: .2, source: 'archive' })),
    devices: [{ id: 'heater-id', device_key: 'pool_heater', category: 'pool_heating' }, { id: 'pump-id', device_key: 'pool_pump', category: 'property_energy' }, { id: 'car-id', device_key: 'car', category: 'ev_charging' }],
    deviceSlots: times.slice(1).map(start_ts => ({ start_ts, device_energy_kwh: { 'heater-id': 0, 'pump-id': .015, 'car-id': 0 } })),
    pool: [{ start_ts: times[0], water_temperature_c: 31 }],
    outdoor: [],
  };
}

export function testTariff(): GridTariffCatalogue { return structuredClone({ timezone: gridFixture.timezone, configuration: gridFixture.base_configuration, profiles: [{ ...gridFixture.profile, versions: [{ ...gridFixture.profile.versions[0], valid_from: '2025-01-01' }] }] }) as GridTariffCatalogue; }
/** Source/session tests substitute computation; financial/replay tests use the actual native engine. */
export function captureStub(capture: BaselineCapture): ComparisonCapture {
 const bill = { supplierFixedSek: 0, gridFixedSek: 0, gridPeakSek: 0, peakKw: 0, totalSek: capture.result.ledger.costSek };
 const service = seriesService(capture.input, capture.result.series);
 return { ...capture, scheduler: { ...capture.result, engine: REPLAY_ENGINE, protocol: REPLAY_PROTOCOL, solves: 1 }, modeled: { baselineBill: bill, schedulerBill: bill, baselineService: service, schedulerService: service } };
}
