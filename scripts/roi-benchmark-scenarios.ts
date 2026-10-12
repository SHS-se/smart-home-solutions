import { baselineFixture } from '../src/lib/home-baseline/fixture.ts';
import { prepareHomeBaseline } from '../src/lib/home-baseline/model.ts';
import { localMoment } from '../supabase/functions/_shared/energy-grid-pricing.ts';

export type RoiScenario = 'flat' | 'solar-prices' | 'solar-prices-trips';

/** Deterministic synthetic households, including changing weather/prices and observed trips. */
export function roiBenchmarkInput(scenario: RoiScenario) {
  const rows = baselineFixture({ start: '2026-07-31T22:00:00Z', end: '2026-08-31T22:00:00Z' });
  if (scenario === 'flat') return prepareHomeBaseline(rows);
  for (const row of rows.actual) {
    const at = new Date(row.start_ts), local = localMoment(at, rows.snapshot.timezone);
    const hour = local.hour + at.getUTCMinutes() / 60;
    const weather = [.9, .4, 1, .7, .2, .8, 1][local.day % 7];
    row.solar_production_kwh = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI)) * 7 * weather / 4;
    if (scenario === 'solar-prices-trips') {
      row.ev_soc = hour < 8 || hour >= 18 ? .8 : hour < 8.25 ? .76 : .72;
    }
  }
  for (const row of rows.prices) {
    const local = localMoment(new Date(row.start_ts), rows.snapshot.timezone);
    const spot = local.day % 7 === 0 && local.hour >= 10 && local.hour < 15 ? -.2
      : local.hour < 6 ? .15 : local.hour >= 17 && local.hour < 21 ? 1.7 : .55;
    row.spot_price_sek_per_kwh = spot;
    row.import_price_sek_per_kwh = (spot + .101) * 1.25 + row.grid_import_price_sek_per_kwh;
    row.export_price_sek_per_kwh = spot;
  }
  return prepareHomeBaseline(rows);
}
