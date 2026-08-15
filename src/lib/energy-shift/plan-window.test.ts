import type { PlannedSlot } from './contracts.ts';
import {
  availablePlanWindows,
  isServiceScheduled,
  planWindowRange,
  scheduledDeviceKeys,
  SLOTS_PER_DAY,
  summarisePlanWindow,
} from './plan-window.ts';

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

// Local midnight, so the midnight probe is exercised in the runner's own zone
// rather than depending on where the test happens to run.
const midnight = new Date(2026, 7, 16, 0, 0, 0);

const slot = (index: number, overrides: Partial<PlannedSlot> = {}): PlannedSlot => ({
  start: new Date(midnight.getTime() + index * 15 * 60_000).toISOString(),
  binding: true,
  pv_raw_w: 0,
  pv_w: 0,
  base_w: 0,
  base_p10_w: 0,
  base_p90_w: 0,
  import_price_sek_per_kwh: 1,
  export_price_sek_per_kwh: 0.2,
  pool_w: 0,
  boiler_expected_w: 0,
  boiler_permitted: true,
  ev_w: 0,
  room_heating_w: {},
  device_loads_w: {},
  ev_target_current_a: 0,
  ev_min_current_a: 0,
  ev_max_current_a: 0,
  ev_soc: null,
  ev_connected: false,
  load_w: 0,
  battery_charge_w: 0,
  battery_discharge_w: 0,
  battery_export_w: 0,
  battery_soc: 0.5,
  grid_import_w: 0,
  grid_export_w: 0,
  curtailed_w: 0,
  unserved_w: 0,
  import_cost_sek: 0,
  export_revenue_sek: 0,
  ...overrides,
});

const horizon = (count: number, build: (index: number) => Partial<PlannedSlot> = () => ({})) =>
  Array.from({ length: count }, (_, index) => slot(index, build(index)));

Deno.test('each day window covers its own 24 hours, not a running total', () => {
  const slots = horizon(3 * SLOTS_PER_DAY);
  assertEquals(planWindowRange(slots.length, 1), { from: 0, to: 96 }, 'day 1');
  assertEquals(planWindowRange(slots.length, 2), { from: 96, to: 192 }, 'day 2');
  assertEquals(planWindowRange(slots.length, 3), { from: 192, to: 288 }, 'day 3');
  assertEquals(planWindowRange(slots.length, 'all'), { from: 0, to: 288 }, 'all');
});

Deno.test('a short horizon offers only the days it actually has', () => {
  assertEquals(availablePlanWindows(288), [1, 2, 3, 'all'], 'full horizon');
  assertEquals(availablePlanWindows(120), [1, 2, 'all'], 'a day and a quarter');
  assertEquals(availablePlanWindows(40), [1, 'all'], 'part of one day');
  // Clamped rather than inverted when a day is missing entirely.
  assertEquals(planWindowRange(40, 3), { from: 40, to: 40 }, 'absent day 3');
});

Deno.test('window totals count only the slots in view', () => {
  // 1 kW of load every quarter of day two only.
  const slots = horizon(3 * SLOTS_PER_DAY, index =>
    index >= SLOTS_PER_DAY && index < 2 * SLOTS_PER_DAY
      ? { load_w: 1_000, pv_w: 2_000 }
      : {});

  const dayOne = summarisePlanWindow(slots, planWindowRange(slots.length, 1));
  const dayTwo = summarisePlanWindow(slots, planWindowRange(slots.length, 2));
  const all = summarisePlanWindow(slots, planWindowRange(slots.length, 'all'));

  assertEquals(dayOne.loadKwh, 0, 'day one load');
  assertEquals(dayTwo.loadKwh, 24, 'day two load');
  assertEquals(dayTwo.pvKwh, 48, 'day two solar');
  assertEquals(all.loadKwh, 24, 'whole horizon load');
});

Deno.test('flexible energy is every deferrable sink including room heat', () => {
  const slots = horizon(SLOTS_PER_DAY, () => ({
    pool_w: 1_000,
    boiler_expected_w: 500,
    ev_w: 2_000,
    room_heating_w: { bathroom: 400, office: 100 },
  }));
  const summary = summarisePlanWindow(slots, planWindowRange(slots.length, 1));
  // 4 kW across 24 hours.
  assertEquals(summary.flexibleKwh, 96, 'flexible energy');
});

Deno.test('unpriced slots move energy but never cost', () => {
  const slots = horizon(SLOTS_PER_DAY, index => ({
    grid_import_w: 1_000,
    binding: index < 48,
    import_cost_sek: index < 48 ? 0.25 : null,
    export_revenue_sek: index < 48 ? 0 : null,
  }));
  const summary = summarisePlanWindow(slots, planWindowRange(slots.length, 1));
  assertEquals(summary.gridImportKwh, 24, 'all imported energy');
  assertEquals(summary.pricedImportKwh, 12, 'priced half');
  assertEquals(summary.netCostSek, 12, 'cost from binding slots only');
});

Deno.test('battery SOC is reported at the midnight the day opens on', () => {
  const slots = horizon(2 * SLOTS_PER_DAY, index => ({
    battery_soc: index === 0 ? 0.42 : index === SLOTS_PER_DAY ? 0.77 : 0.5,
  }));
  const dayOne = summarisePlanWindow(slots, planWindowRange(slots.length, 1));
  const dayTwo = summarisePlanWindow(slots, planWindowRange(slots.length, 2));
  assertEquals(dayOne.batterySocAtMidnight, 0.42, 'day one midnight');
  assertEquals(dayTwo.batterySocAtMidnight, 0.77, 'day two midnight');
  assert(dayOne.midnightStart !== null, 'day one names its midnight');
});

Deno.test('a window with no midnight in it reports none rather than guessing', () => {
  const slots = horizon(4).map(entry => ({
    ...entry,
    start: new Date(new Date(entry.start).getTime() + 3 * 3_600_000).toISOString(),
  }));
  const summary = summarisePlanWindow(slots, planWindowRange(slots.length, 1));
  assertEquals(summary.batterySocAtMidnight, null, 'no midnight');
  assertEquals(summary.midnightStart, null, 'no midnight start');
});

Deno.test('only devices the plan actually runs reach the legend', () => {
  const slots = horizon(3 * SLOTS_PER_DAY, index => ({
    device_loads_w: {
      'sensor.pool_heater': index < SLOTS_PER_DAY ? 3_000 : 0,
      'sensor.towel_rack': 0,
      // Recorder dust must not count as scheduled.
      'sensor.office_heater': 0.2,
    },
  }));
  assertEquals(
    [...scheduledDeviceKeys(slots, planWindowRange(slots.length, 1))],
    ['sensor.pool_heater'],
    'day one',
  );
  assertEquals(
    [...scheduledDeviceKeys(slots, planWindowRange(slots.length, 2))],
    [],
    'day two runs nothing',
  );
});

Deno.test('an aggregate service series is hidden when it never runs', () => {
  const slots = horizon(SLOTS_PER_DAY, index => ({ pool_w: index === 5 ? 3_000 : 0 }));
  const range = planWindowRange(slots.length, 1);
  assert(isServiceScheduled(slots, range, entry => entry.pool_w), 'pool runs');
  assert(!isServiceScheduled(slots, range, entry => entry.ev_w), 'EV never runs');
});

// The demo plan is the only full-shaped 72-hour plan available offline, so it
// doubles as a fixture: if a slot field the summary reads ever disappears from
// the real contract, this fails rather than silently summing undefined.
Deno.test('day windows of a real-shaped plan partition the whole horizon', async () => {
  const { createWebsiteDemoPlan } = await import('./demo.ts');
  const plan = createWebsiteDemoPlan(Date.parse('2026-08-15T22:00:00Z'));
  const slots = plan.plans.priority.slots;
  assert(slots.length >= 3 * SLOTS_PER_DAY, 'demo plan covers three days');

  const all = summarisePlanWindow(slots, planWindowRange(slots.length, 'all'));
  const days = ([1, 2, 3] as const).map(day =>
    summarisePlanWindow(slots, planWindowRange(slots.length, day)));

  const summed = days.reduce((total, day) => total + day.loadKwh, 0);
  const tail = summarisePlanWindow(
    slots,
    { from: 3 * SLOTS_PER_DAY, to: slots.length },
  );
  assert(
    Math.abs(summed + tail.loadKwh - all.loadKwh) < 1e-6,
    `day windows must partition the horizon: ${summed} + ${tail.loadKwh} vs ${all.loadKwh}`,
  );
  assert(all.pvKwh > 0, 'the demo plan forecasts some solar');
  for (const day of days) {
    assert(day.slotCount === SLOTS_PER_DAY, 'each day is a full 24 hours');
    assert(Number.isFinite(day.flexibleKwh), 'flexible energy is a number');
    assert(Number.isFinite(day.netCostSek), 'net cost is a number');
  }
});
