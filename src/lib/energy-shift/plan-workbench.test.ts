import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import {
  buildWorkbenchChart,
  buildWorkbenchModel,
  compareWorkbench,
  executableKw,
  scheduleFromDraft,
  type WorkbenchDraft,
} from './plan-workbench.ts';
import {
  dispatchWorkbench,
  type DispatchWorkbench,
} from '../../../supabase/functions/_shared/energy-optimisation.ts';
import { snapshot as realSnapshot } from './optimisation-snapshot.fixture.ts';
import type { UtilityCurve } from '../../../supabase/functions/_shared/store-value.ts';

const START = Date.parse('2026-09-05T06:00:00.000Z');
const SLOTS = 8;

const evCurve: UtilityCurve = {
  unit: 'km',
  points: [
    { at: 80, sek_per_unit: 2.5 },
    { at: 200, sek_per_unit: 0.35 },
    { at: 480, sek_per_unit: 0 },
  ],
};

/** Two hours: the first dark and dear, the second sunny and cheap to export. */
function workbench(): DispatchWorkbench {
  return {
    slots: Array.from({ length: SLOTS }, (_slot, index) => ({
      pv_w: index < 4 ? 0 : 6_000,
      fixed_load_w: 500,
      import_price_sek_per_kwh: index < 4 ? 2.4 : 0.9,
      export_price_sek_per_kwh: 0.2,
      binding: true,
    })),
    stores: [{
      key: 'ev',
      curve: evCurve,
      initial_state: 100,
      max_power_w: 11_040,
      min_power_w: 4_140,
      power_step_w: 690,
      retention_per_slot: 1,
      usage_weight: new Array(SLOTS + 1).fill(0).map((_v, i) => (i === SLOTS ? 1 : 0)),
      units_per_kwh: () => 0.9 / 0.16,
      drift: (state: number) => state,
      max_state: 480,
    }],
    limits: {
      grid_import_limit_w: 13_200,
      grid_export_limit_w: 13_200,
      grid_import_shaping_w: 9_000,
      peak_shaping_sek_per_kwh_per_kw: 1.5,
    },
    slot_start_ms: Array.from({ length: SLOTS }, (_s, i) => START + i * 900_000),
    planned: {
      // The shape §8.12 keeps producing: one dear quarter at full power.
      power_w: { ev: [11_040, 0, 0, 0, 0, 0, 0, 0] },
      discharge_w: { ev: new Array(SLOTS).fill(0) },
    },
    stopped_because: 'no_profitable_candidate',
    iterations: 12,
  };
}

Deno.test('an hourly column averages the quarters it covers', () => {
  const model = buildWorkbenchModel(workbench(), 'hour');

  assertEquals(model.columns.length, 2);
  assertEquals(model.columns[0].slots, [0, 1, 2, 3]);
  // 11.04 kW for one quarter of the hour is 2.76 kW across it: same energy.
  assertAlmostEquals(model.planned['ev:charge'][0], 2.76, 1e-9);
  assertEquals(model.planned['ev:charge'][1], 0);
  assertAlmostEquals(model.columns[1].solarKw, 6, 1e-9);
});

Deno.test('a quarter column is the planner’s own resolution', () => {
  const model = buildWorkbenchModel(workbench(), 'quarter');

  assertEquals(model.columns.length, SLOTS);
  assertAlmostEquals(model.planned['ev:charge'][0], 11.04, 1e-9);
});

Deno.test('an edited column expands back across its quarters', () => {
  const bench = workbench();
  const model = buildWorkbenchModel(bench, 'hour');
  const draft: WorkbenchDraft = { 'ev:charge': [0, 4.14] };

  const schedule = scheduleFromDraft(bench, model, draft);

  assertEquals(schedule.power_w.ev, [0, 0, 0, 0, 4_140, 4_140, 4_140, 4_140]);
  assertEquals(schedule.discharge_w.ev, new Array(SLOTS).fill(0));
});

Deno.test('a column left untouched keeps what the planner chose', () => {
  const bench = workbench();
  const model = buildWorkbenchModel(bench, 'quarter');

  const schedule = scheduleFromDraft(bench, model, {});

  assertEquals(schedule.power_w.ev, bench.planned.power_w.ev);
});

Deno.test('moving the car’s charge into sun beats the planner’s dear burst', () => {
  // The whole point of the workbench, end to end: the same energy moved out of
  // the dark expensive hour and into the sunny one must score better, and the
  // comparison must say so in kronor. Quarter resolution because this charger
  // cannot execute a quarter of 11 kW spread across an hour — 2.76 kW is below
  // its 4.14 kW minimum, and the scorer says so rather than pricing a schedule
  // the car would refuse.
  const bench = workbench();
  const model = buildWorkbenchModel(bench, 'quarter');
  const spread = scheduleFromDraft(bench, model, {
    'ev:charge': [0, 0, 0, 0, 11.04, 0, 0, 0],
  });

  const comparison = compareWorkbench(bench, spread);

  assertEquals(comparison.manual.infeasibilities.length, 0);
  assert(
    comparison.totalDeltaSek < 0,
    `moving the same kWh into surplus must pay: ${comparison.totalDeltaSek}`,
  );
  assert(
    comparison.importDeltaKwh < 0,
    'and it must buy less from the grid',
  );
});

Deno.test('a typed power is snapped onto what the charger can execute', () => {
  const [row] = buildWorkbenchModel(workbench(), 'hour').rows;

  assertEquals(executableKw(row, 0), 0);
  assertEquals(executableKw(row, 1), 4.14);
  assertAlmostEquals(executableKw(row, 5), 4.83, 1e-9);
  assertAlmostEquals(executableKw(row, 99), 11.04, 1e-9);
});

Deno.test('an hourly average below the floor becomes a duty cycle at the floor', () => {
  // 2.76 kW across an hour is below this charger's 4.14 kW minimum, so a flat
  // expansion would command a current the car refuses and score the whole hour
  // infeasible. Editing by the hour means "about this much energy", so it runs
  // at the floor for as many quarters as that energy buys — which is both
  // executable and the same trade the planner makes.
  const bench = workbench();
  const model = buildWorkbenchModel(bench, 'hour');
  const schedule = scheduleFromDraft(bench, model, { 'ev:charge': [0, 2.76] });

  assertEquals(schedule.power_w.ev, [0, 0, 0, 0, 4_140, 4_140, 4_140, 0]);
  assertEquals(compareWorkbench(bench, schedule).manual.infeasibilities, []);
});

Deno.test('an hourly duty cycle is held for the minimum run', () => {
  // A trickle far under the floor would otherwise be a single quarter, which a
  // compressor that declares a longer minimum cannot do.
  const bench = workbench();
  bench.stores[0] = { ...bench.stores[0], min_run_slots: 3 };
  const model = buildWorkbenchModel(bench, 'hour');

  const schedule = scheduleFromDraft(bench, model, { 'ev:charge': [0, 0.5] });

  assertEquals(schedule.power_w.ev, [0, 0, 0, 0, 4_140, 4_140, 4_140, 0]);
});

// ---------------------------------------------------------------------------
// Against a real snapshot, not a fixture built to suit the scorer.
// ---------------------------------------------------------------------------

Deno.test('the workbench hands back the auction’s own inputs', () => {
  const bench = dispatchWorkbench(realSnapshot());

  assert(bench !== null, 'a home with a battery and a pool must build stores');
  assertEquals(bench.slots.length, 288);
  assertEquals(bench.slot_start_ms.length, 288);
  assert(
    bench.stores.some(store => store.key === 'pool'),
    `expected the pool among ${bench.stores.map(s => s.key).join(', ')}`,
  );
  assertEquals(buildWorkbenchModel(bench, 'hour').columns.length, 72);
});

Deno.test('scoring the planner’s own plan reproduces the planner’s own answer', () => {
  // The identity every comparison rests on: hand the scorer the schedule the
  // planner issued and it must price it exactly as the planner priced it, or
  // no difference the workbench reports means anything.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const comparison = compareWorkbench(bench, bench.planned);

  assertEquals(comparison.totalDeltaSek, 0);
  assertEquals(comparison.importDeltaKwh, 0);
});

Deno.test('the only rule the planner’s own plan breaks is the export leak', () => {
  // Found by the workbench on its first contact with a real snapshot, and left
  // failing-if-it-spreads rather than asserted away.
  //
  // The battery is bid to cover a deficit — `discharge_destination: "load"` —
  // and a later release removes the load it was covering without releasing the
  // discharge. What is left discharges into export in a slot where the house
  // is already exporting, which this pack is not permitted to do: 2.46 kW at
  // slot 227 of the shared fixture, sold at an export price against a stored
  // value booked at the import price it thought it was avoiding. It is the
  // §8.18 auction/settlement drift with the signs that matter to a bill.
  //
  // The assertion is deliberately about the *class*: a new kind of breach in
  // the planner's own output must fail here rather than hide behind this one.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const { infeasibilities } = compareWorkbench(bench, bench.planned).planner;

  assert(infeasibilities.length > 0, 'the leak is not fixed yet');
  assertEquals(
    infeasibilities.filter(entry => !entry.includes('discharges into export')),
    [],
  );
});

Deno.test('doing nothing is scored, and the planner beats it', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const nothing = { power_w: {}, discharge_w: {} };

  const comparison = compareWorkbench(bench, nothing);

  assertEquals(comparison.manual.infeasibilities, []);
  assert(
    comparison.totalDeltaSek > 0,
    `an idle house must score worse than the plan: ${comparison.totalDeltaSek}`,
  );
});

Deno.test('a breach the planner already had is not blamed on the household', () => {
  // The editor opens on the planner's own schedule, so its export leak is in
  // every draft from the first keystroke. Charging the household with it would
  // mark every plan they build unrunnable for something they did not do.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const untouched = compareWorkbench(bench, bench.planned);
  assert(untouched.planner.infeasibilities.length > 0, 'the leak is still there');
  assertEquals(untouched.introduced, []);
});

// ---------------------------------------------------------------------------
// The chart the edit is judged by eye on.
// ---------------------------------------------------------------------------

const chartOf = (bench: DispatchWorkbench, schedule = bench.planned) =>
  buildWorkbenchChart(
    bench,
    schedule,
    compareWorkbench(bench, schedule).manual,
    ms => new Date(ms).toISOString(),
    key => key,
  );

Deno.test('the chart covers every quarter the plan does', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const chart = chartOf(bench);

  assertEquals(chart.rows.length, 288);
  assertEquals(chart.baseValues.length, 288);
  assert(chart.hasBattery, 'this home has a pack');
  assert(chart.rows.every(row => row.measured === false), 'all of it is plan');
  assert(
    chart.rows.every(row => row.homeSoc === null || (row.homeSoc >= 0 && row.homeSoc <= 100)),
    'a state of charge is a percentage',
  );
});

Deno.test('charging the pack is a flow, not consumption', () => {
  // Drawn in the flow panel as "battery in" already; counting it as house
  // demand too would draw the same kilowatt twice and inflate the base band.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const battery = bench.stores.find(store => store.discharge !== undefined);
  assert(battery !== undefined);

  const chart = chartOf(bench);
  const charging = bench.planned.power_w[battery.key]
    .findIndex(watts => watts > 100);
  assert(charging >= 0, 'the fixture charges the pack somewhere');

  assertEquals(chart.rows[charging].loadW, bench.slots[charging].fixed_load_w);
  assert(
    (chart.rows[charging].batteryChargeW ?? 0) > 100,
    'and it still shows in the flow panel',
  );
  assert(
    chart.series.every(entry => entry.key !== battery.key),
    'the pack never earns a consumption band',
  );
});

Deno.test('editing the schedule redraws the chart', () => {
  // The whole reason the panels are here: a number says a plan is better, the
  // shape says whether it looks right, and the shape has to follow the edit.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const pool = model.rows.find(row => row.storeKey === 'pool');
  assert(pool !== undefined, 'the fixture home has a pool');

  // Switch off a quarter the planner had running, leaving the rest of its
  // schedule alone — an edit whose effect is unambiguous.
  const running = model.planned[pool.id].findIndex(kw => kw > 0);
  assert(running >= 0, 'the fixture heats the pool somewhere');
  const before = chartOf(bench);
  const edited = scheduleFromDraft(bench, model, {
    [pool.id]: model.planned[pool.id].map((kw, index) => (index === running ? 0 : kw)),
  });
  const after = chartOf(bench, edited);

  assertEquals(after.rows.length, before.rows.length);
  assert(
    after.rows[running].loadW !== before.rows[running].loadW,
    'the quarter that was edited must move',
  );
  assert(
    after.rows.at(-1)!.cumulativeCostSek !== before.rows.at(-1)!.cumulativeCostSek,
    'and the running cost with it',
  );
});

Deno.test('a windowed chart draws only that day, costed from its own edge', () => {
  // The day tabs narrow the chart and the table together. A window that still
  // carried the horizon's running total would open every day but the first on
  // a cost line that started halfway up the axis.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const score = compareWorkbench(bench, bench.planned).manual;
  const label = (ms: number) => new Date(ms).toISOString();

  const whole = buildWorkbenchChart(bench, bench.planned, score, label, key => key);
  const second = buildWorkbenchChart(bench, bench.planned, score, label, key => key, {
    from: 96,
    to: 192,
  });

  assertEquals(second.rows.length, 96);
  assertEquals(second.baseValues.length, 96);
  assertEquals(second.rows[0].startMs, whole.rows[96].startMs);
  // Same quarter, same physics — only the running total is re-based.
  assertEquals(second.rows[0].loadW, whole.rows[96].loadW);
  assertEquals(second.rows[0].homeSoc, whole.rows[96].homeSoc);
  assert(
    Math.abs(second.rows[0].cumulativeCostSek) <
      Math.abs(whole.rows[96].cumulativeCostSek),
    'the day starts its own tally',
  );
});

Deno.test('a window past the horizon is clamped rather than padded', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const score = compareWorkbench(bench, bench.planned).manual;

  const chart = buildWorkbenchChart(
    bench,
    bench.planned,
    score,
    ms => String(ms),
    key => key,
    { from: 240, to: 400 },
  );

  assertEquals(chart.rows.length, 48);
});
