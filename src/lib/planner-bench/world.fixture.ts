// Test helper: synthetic bench cases and plans for the referee, audit and
// score tests. Every quarter is given by a function of its index, so a test
// states only what makes its world different.

import { CASE_FORMAT, CASE_VERSION, QUARTERS, type BenchCase, type CaseStartState, type Targets } from './case';
import type { Decisions } from './referee';

/** Synthetic preferences for tests only; the runner reads the home's settings. */
export const TARGETS: Targets = { pool_c: 30, ev_km: 300 };

export const quarters = <T>(make: (i: number) => T): T[] => Array.from({ length: QUARTERS }, (_, i) => make(i));
/** Whether quarter i lies in [from, to). */
export const within = (i: number, from: number, to: number) => i >= from && i < to;

export interface WorldSpec {
  solar?: (i: number) => number;
  load?: (i: number) => number;
  buy?: (i: number) => number;
  sell?: (i: number) => number;
  air?: (i: number) => number;
  /** Leading quarters with a published price. */
  published?: number;
  start?: Partial<Omit<CaseStartState, 'ev'>> & { ev?: Partial<CaseStartState['ev']> };
  comfort?: BenchCase['comfort'];
}

export function world(spec: WorldSpec = {}): BenchCase {
  const buy = quarters(spec.buy ?? (() => 1)), sell = quarters(spec.sell ?? (() => 0.5));
  const published = spec.published ?? 96;
  return {
    format: CASE_FORMAT, version: CASE_VERSION,
    origin: { kind: 'manual', detail: 'synthetic', created_at: '2026-09-28T00:00:00Z' },
    start: '2026-09-24T00:00:00.000Z', timezone: 'Europe/Stockholm', location: { latitude: 59.4, longitude: 18 },
    known_prices: {
      import_sek_per_kwh: buy.map((v, i) => i < published ? v : null),
      export_sek_per_kwh: sell.map((v, i) => i < published ? v : null),
    },
    solar_forecast_w: quarters(spec.solar ?? (() => 0)),
    base_load_forecast_w: quarters(spec.load ?? (() => 500)),
    other_devices_w: {},
    start_state: {
      battery_soc: spec.start?.battery_soc ?? 0.5,
      pool_water_c: spec.start?.pool_water_c ?? 30,
      pool_heater: spec.start?.pool_heater ?? { kind: 'off_unobserved' },
      ev: { soc: spec.start?.ev?.soc ?? 0.7, target_soc: spec.start?.ev?.target_soc ?? 0.8 },
    },
    comfort: { ...TARGETS, ...spec.comfort },
    recorded: {
      prices: { import_sek_per_kwh: buy, export_sek_per_kwh: sell },
      outdoor_temperature_c: quarters(spec.air ?? (() => 30)),
      solar_irradiance_w_per_m2: quarters(() => null),
      history: { prices: { start: '2026-09-23T00:00:00Z', import_sek_per_kwh: [], export_sek_per_kwh: [] }, grid_import_kwh: { start: '2026-08-31T22:00:00Z', kwh: [] } },
      recorded_at: '2026-09-28T00:00:00Z',
    },
  };
}

/**
 * A case of the size and texture of a real one: three days of sun (bright,
 * dull, fair), an evening peak in load and price, quarter-to-quarter noise, a
 * cool autumn pool. Deterministic.
 */
export function realisticWorld(published = 100): BenchCase {
  let seed = 7;
  const noise = quarters(() => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const evening = (i: number) => within(i % 96, 68, 84);
  const daily = (i: number) => Math.sin((i % 96) / 96 * 2 * Math.PI - 2);
  return world({
    solar: i => Math.max(0, 6000 * Math.sin(((i % 96) - 28) / 44 * Math.PI)) * (i < 96 ? 1 : i < 192 ? 0.25 : 0.8) * (0.7 + 0.3 * noise[i]),
    load: i => 400 + 900 * noise[(i * 7) % QUARTERS] + (evening(i) ? 1800 : 0),
    buy: i => 0.9 + 0.8 * daily(i) + (evening(i) ? 1.2 : 0) + 0.3 * noise[(i * 3) % QUARTERS],
    sell: i => 0.3 + 0.4 * daily(i) + 0.2 * noise[(i * 5) % QUARTERS],
    air: i => 14 + 5 * Math.sin(((i % 96) - 36) / 96 * 2 * Math.PI),
    start: { battery_soc: 0.4, pool_water_c: 29.5, ev: { soc: 0.45 } }, published,
  });
}

/** A plan by the clock, blind to price and sun: pool at night, car in the evening, a daily battery cycle. */
export const clockPlan = (): Decisions => plan({
  pool: i => within(i % 96, 0, 30) ? 3764 : 0,
  ev: i => within(i, 76, 92) ? 6210 : 0,
  charge: i => within(i % 96, 8, 20) ? 3000 : 0,
  discharge: i => within(i % 96, 70, 82) ? 2500 : 0,
});

export function plan(spec: { pool?: (i: number) => number; ev?: (i: number) => number; charge?: (i: number) => number; discharge?: (i: number) => number } = {}): Decisions {
  return {
    pool_w: quarters(spec.pool ?? (() => 0)), ev_w: quarters(spec.ev ?? (() => 0)),
    battery_charge_w: quarters(spec.charge ?? (() => 0)), battery_discharge_w: quarters(spec.discharge ?? (() => 0)),
  };
}
