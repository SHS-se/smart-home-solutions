// The chart must draw the numbers the planner actually reasoned with.
//
// This is the acceptance criterion for the whole shadow-price rewrite, stated
// as a test rather than as a claim. The planner decides everything in
// `shadow_import_sek_per_kwh` — `planDispatch` bids against it,
// `batteryValueCurve` is built from it, export replacement cost and thermal
// scoring read it — so a chart drawing anything else would be describing a
// different plan from the one Home Assistant executes.
//
// The failure this guards against is not hypothetical. The shadow prices lived
// only inside the planner until 2026-08-18; the chart stopped at the day-ahead
// boundary and left two thirds of every plan undrawn, which is what made a flat
// tail look like missing data rather than a broken objective.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { generateOptimisationPlan } from '../../../supabase/functions/_shared/energy-optimisation.ts';
import type { OptimisationSnapshot } from '../../../supabase/functions/_shared/energy-optimisation.ts';
import { buildEnergyTimeline } from './energy-timeline.ts';

const CAPTURED_AT = '2026-08-18T20:45:00.000Z';
const START = Date.parse(CAPTURED_AT);
const TZ = 'Europe/Stockholm';

const provenance = (quality: string) => ({
  provider: 'provenance-test',
  entity_ids: ['sensor.x'],
  issued_at: CAPTURED_AT,
  valid_until: new Date(START + 6 * 3_600_000).toISOString(),
  quality,
  sample_count: 100,
});

/** A price with a real daily shape, so a flat tail would be obvious. */
const priceAt = (hour: number) =>
  Math.max(
    0.8,
    1.9 + 0.9 * Math.exp(-((hour - 7.5) ** 2) / 6) +
      1.5 * Math.exp(-((hour - 19) ** 2) / 5),
  );

const hourAt = (ms: number) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const value = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return (value('hour') % 24) + value('minute') / 60;
};

/** Day-ahead published for 26 hours, then nothing — the permanent situation. */
const PRICED_UNTIL = START + 26 * 3_600_000;

const snapshot = (): OptimisationSnapshot => {
  const slots = Array.from({ length: 288 }, (_value, index) => {
    const ms = START + index * 900_000;
    const hour = hourAt(ms);
    const priced = ms < PRICED_UNTIL;
    const importPrice = priceAt(hour);
    return {
      start: new Date(ms).toISOString(),
      pv_forecast_w: hour > 5.5 && hour < 20
        ? Math.round(5_200 * Math.sin(((hour - 5.5) / 14.5) * Math.PI))
        : 0,
      base_load_forecast_w: 800,
      import_price_sek_per_kwh: priced ? importPrice : null,
      export_price_sek_per_kwh: priced
        ? Math.max(0.05, (importPrice - 0.835) / 1.25 + 0.033)
        : null,
    };
  });
  return {
    schema_version: 6,
    mode: 'live',
    capabilities: { pv: true, battery: true, pool: false, boiler: false, ev: false },
    snapshot_id: '00000000-0000-4000-8000-000000000001',
    captured_at: CAPTURED_AT,
    timezone: TZ,
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
      capacity_kwh: 18.08, soc: 0.5, min_soc: 0.05, max_soc: 1,
      charge_max_w: 8_800, discharge_max_w: 9_600,
      charge_efficiency: 0.95, discharge_efficiency: 0.95,
    },
    ev_battery: null,
    pool: null,
    outdoor_temperature_c: slots.map(() => 18),
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

/** Three days of archive with the same daily shape. */
const archive = Array.from({ length: 3 * 96 }, (_value, index) => {
  const ms = START - (3 * 96 - index) * 900_000;
  return {
    start_ts: new Date(ms).toISOString(),
    import_price_sek_per_kwh: priceAt(hourAt(ms)),
  };
});

const planned = () => {
  const plan = generateOptimisationPlan(snapshot(), new Date(START + 60_000), archive);
  const timeline = buildEnergyTimeline({
    actuals: [],
    deviceActuals: [],
    prices: [],
    planSlots: plan.plans.priority.slots,
    deviceKeyById: new Map(),
    nowMs: START,
  });
  return { plan, timeline };
};

Deno.test('every price the chart draws is the price the planner used', () => {
  const { plan, timeline } = planned();
  const bySlot = new Map(
    plan.plans.priority.slots.map(slot => [Date.parse(slot.start), slot]),
  );
  let checked = 0;
  for (const row of timeline) {
    if (row.measured) continue;
    const slot = bySlot.get(row.startMs);
    assert(slot !== undefined, `no plan slot for ${row.start}`);
    // Solid where published, dashed where modelled — but always one of the two,
    // and always the planner's own number.
    const drawn = row.importPriceSekPerKwh ?? row.shadowImportSekPerKwh;
    assert(drawn !== null, `nothing would be drawn at ${row.start}`);
    assert(
      Math.abs(drawn - slot.shadow_import_sek_per_kwh) < 1e-4,
      `chart would draw ${drawn} where the planner used ${slot.shadow_import_sek_per_kwh} at ${row.start}`,
    );
    checked += 1;
  }
  assert(checked > 200, `expected a full horizon to check, got ${checked}`);
});

Deno.test('the export side matches too', () => {
  const { plan, timeline } = planned();
  const bySlot = new Map(
    plan.plans.priority.slots.map(slot => [Date.parse(slot.start), slot]),
  );
  for (const row of timeline) {
    if (row.measured) continue;
    const slot = bySlot.get(row.startMs)!;
    const drawn = row.exportPriceSekPerKwh ?? row.shadowExportSekPerKwh;
    assert(drawn !== null, `nothing would be drawn at ${row.start}`);
    assert(
      Math.abs(drawn - slot.shadow_export_sek_per_kwh) < 1e-4,
      `chart would draw ${drawn} where the planner used ${slot.shadow_export_sek_per_kwh}`,
    );
  }
});

Deno.test('a published quarter draws the published price, not an estimate', () => {
  // The two must agree there as well: `buildPriceOutlook` returns the published
  // price unchanged for a priced slot, so solid and shadow are the same number.
  const { plan } = planned();
  const published = plan.plans.priority.slots.filter(
    slot => slot.import_price_sek_per_kwh !== null,
  );
  assert(published.length > 90, 'the fixture must have a day-ahead window');
  for (const slot of published) {
    assert(
      Math.abs(slot.import_price_sek_per_kwh! - slot.shadow_import_sek_per_kwh) < 1e-4,
      `published ${slot.import_price_sek_per_kwh} but planned on ${slot.shadow_import_sek_per_kwh}`,
    );
  }
});

Deno.test('the modelled tail the chart draws is not flat', () => {
  // Belt and braces on the rewrite: if the tail ever goes flat again, this
  // fails here as well as in the price-shape tests, because it is the drawn
  // series that a reader would have to notice otherwise.
  const { timeline } = planned();
  const modelled = timeline
    .filter(row => !row.measured && row.shadowImportSekPerKwh !== null)
    .map(row => row.shadowImportSekPerKwh as number);
  assert(modelled.length > 96, `expected a modelled tail, got ${modelled.length}`);
  const spread = Math.max(...modelled) / Math.min(...modelled);
  assert(spread > 1.3, `the drawn tail was flat, spread ${spread.toFixed(3)}`);
});

Deno.test('the plan says how well founded its prices are', () => {
  const { plan } = planned();
  assertEquals(plan.price_outlook.shaped, true);
  assert(plan.price_outlook.observed_days >= 3, 'three days of archive were given');
  assert(plan.price_outlook.effective_days > 0, 'and they carry weight');
  assert(
    plan.price_outlook.level_sek_per_kwh !== null,
    'the published window sets the level',
  );
});
