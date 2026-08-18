import { assert, assertEquals } from 'jsr:@std/assert@1';
import { comparePreference, solveWith } from './curve-preview.ts';
import { curveFromPreference } from '../../../supabase/functions/_shared/value-preferences.ts';
import { DEFAULT_VALUE_CURVES } from '../../../supabase/functions/_shared/value-curves.ts';
import { WATER_KWH_PER_M3_K } from '../../../supabase/functions/_shared/store-models.ts';
import type { OptimisationSnapshotV5 } from '../../../supabase/functions/_shared/energy-optimisation.ts';

const CAPTURED_AT = '2026-08-17T20:45:00.000Z';
const START = Date.parse(CAPTURED_AT);

const provenance = (quality: string) => ({
  provider: 'preview-test',
  entity_ids: ['sensor.x'],
  issued_at: CAPTURED_AT,
  valid_until: new Date(START + 6 * 3_600_000).toISOString(),
  quality,
  sample_count: 100,
});

/** Three sunny days at real Swedish August prices, and a pool below its band. */
const snapshot = (): OptimisationSnapshotV5 => {
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
      base_load_p10_w: 600,
      base_load_p90_w: 1_400,
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

const poolScale = {
  units_per_kwh: 4.6 / (55 * WATER_KWH_PER_M3_K),
  reference_sek_per_kwh: 2.2,
};

const poolCurve = (comfortable: number) =>
  curveFromPreference(
    { urgent_below: 25, comfortable, indifferent_above: comfortable + 2 },
    'celsius',
    poolScale,
  );

Deno.test('a preview runs the planner rather than a second model of it', () => {
  const outcome = solveWith(snapshot(), { pool: DEFAULT_VALUE_CURVES.pool });
  assert(typeof outcome !== 'string', `solve failed: ${outcome}`);
  assert(outcome.stores.length > 0, 'the preview must report the stores');
  const pool = outcome.stores.find(store => store.key === 'pool');
  assert(pool !== undefined, 'a home with a pool must report one');
  assertEquals(pool.unit, 'celsius');
});

Deno.test('wanting the pool warmer buys more heating, and the delta says so', () => {
  // The whole point of the preview: the household moves one number and reads a
  // consequence in hours, kWh and kronor rather than in SEK per degree.
  const comparison = comparePreference(
    snapshot(),
    { pool: poolCurve(28) },
    { pool: poolCurve(30) },
  );
  assert(typeof comparison !== 'string', `preview failed: ${comparison}`);
  const pool = comparison.stores.find(store => store.key === 'pool')!;
  assert(
    pool.runHoursAfter > pool.runHoursBefore,
    `a warmer target must run the heater longer: ${pool.runHoursBefore} -> ${pool.runHoursAfter}`,
  );
  assert(
    pool.kwhAfter > pool.kwhBefore,
    `and take more energy: ${pool.kwhBefore} -> ${pool.kwhAfter}`,
  );
  assert(
    pool.endStateAfter !== null && pool.endStateBefore !== null &&
      pool.endStateAfter > pool.endStateBefore,
    'and leave the pool warmer at the end of the horizon',
  );
});

Deno.test('the energy has to come from somewhere, and the preview shows where', () => {
  // Heating more either imports more or exports less. A preview that showed
  // the service change without its cost would be the half-objective §8.1 warns
  // about, dressed as a feature.
  const comparison = comparePreference(
    snapshot(),
    { pool: poolCurve(28) },
    { pool: poolCurve(30) },
  );
  assert(typeof comparison !== 'string');
  assert(
    comparison.importDeltaKwh > 0 || comparison.exportDeltaKwh < 0,
    'more heating must show up as more import or less export',
  );
});

Deno.test('an unchanged curve previews as no change at all', () => {
  const curves = { pool: poolCurve(28) };
  const comparison = comparePreference(snapshot(), curves, curves);
  assert(typeof comparison !== 'string');
  assertEquals(comparison.costDeltaSek, 0);
  assertEquals(comparison.importDeltaKwh, 0);
  for (const store of comparison.stores) {
    assertEquals(store.runHoursAfter, store.runHoursBefore);
  }
});

Deno.test('a snapshot the planner refuses explains itself instead of throwing', () => {
  const broken = { ...snapshot(), slots: [] };
  const outcome = solveWith(broken, {});
  assertEquals(typeof outcome, 'string');
});
