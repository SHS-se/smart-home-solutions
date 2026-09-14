import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import {
  buildWorkbenchChart,
  buildWorkbenchExport,
  buildWorkbenchModel,
  curvesBeyondReach,
  exportFreeCeilingKw,
  gridWattsAt,
  storeValueSeries,
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
import type { DispatchSchedule } from '../../../supabase/functions/_shared/dispatch-plan.ts';

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

Deno.test('an hourly duty cycle does not buy extra energy to pad a run', () => {
  // Half a kilowatt averaged over an hour rounds down to zero quarters.
  const bench = workbench();
  const model = buildWorkbenchModel(bench, 'hour');

  const schedule = scheduleFromDraft(bench, model, { 'ev:charge': [0, 0.5] });

  assertEquals(schedule.power_w.ev, [0, 0, 0, 0, 0, 0, 0, 0]);
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

Deno.test('settlement leaves the real plan physically feasible', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  assertEquals(compareWorkbench(bench, bench.planned).planner.infeasibilities, []);
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
  // Simulate an imported plan with an excessive battery discharge. Its
  // existing defect must not be attributed to an unchanged household draft.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  bench.planned.discharge_w.battery[0] = 100_000;
  const untouched = compareWorkbench(bench, bench.planned);
  assert(untouched.planner.infeasibilities.length > 0, 'the injected defect is detected');
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

  const otherChargeW = bench.stores
    .filter(store => store.key !== battery.key)
    .reduce((sum, store) => sum + bench.planned.power_w[store.key][charging], 0);
  assertEquals(chart.rows[charging].loadW, bench.slots[charging].fixed_load_w + otherChargeW);
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

// ---------------------------------------------------------------------------
// The grid column, and handing the whole comparison to somebody else.
// ---------------------------------------------------------------------------

Deno.test('the grid figure is signed: bought positive, sold negative', () => {
  const bench = workbench();
  const model = buildWorkbenchModel(bench, 'quarter');
  // Slot 0 is dark with a house load, slot 4 is sunny with nothing running.
  const idle = scheduleFromDraft(bench, model, {
    'ev:charge': new Array(SLOTS).fill(0),
  });
  const score = compareWorkbench(bench, idle).manual;

  assert(gridWattsAt(score, 0) > 0, 'a dark quarter buys');
  assert(gridWattsAt(score, 4) < 0, 'a sunny quarter sells');
  // And it is one number, not two: the house never does both at once.
  assertEquals(gridWattsAt(score, 0), score.import_w[0]);
  assertEquals(gridWattsAt(score, 4), -score.export_w[4]);
});

Deno.test('a breach names the exact quarter it happens in', () => {
  // The slot is what the alert turns into a time and a link, so it has to be
  // the real quarter — and the sentence must not carry a slot number of its
  // own, because "slot 58" is the thing this replaced.
  const bench = workbench();
  // Built directly rather than through the editor: `scheduleFromDraft` snaps a
  // typed figure onto an executable one, which is exactly what this defeats.
  const belowFloor = {
    power_w: { ev: new Array(SLOTS).fill(0).map((_w, i) => (i === 3 ? 1_000 : 0)) },
    discharge_w: { ev: new Array(SLOTS).fill(0) },
  };

  const { infeasibilities } = compareWorkbench(bench, belowFloor).manual;

  // Two rules at once, and rightly: 1 kW is under the 4.14 kW floor *and* off
  // the 690 W increment. Both name the quarter they happened in.
  assertEquals(infeasibilities.length, 2);
  for (const entry of infeasibilities) {
    assertEquals(entry.slot, 3);
    assertEquals(entry.store_key, 'ev');
    assert(!entry.message.includes('slot'), 'no slot number in the sentence');
  }
  assert(
    infeasibilities.some(entry => entry.message.includes('below the 4140 W it can execute')),
  );
  assert(infeasibilities.some(entry => entry.message.includes('increment')));
});

Deno.test('an export carries both plans, their inputs and where they came from', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const pool = model.rows.find(row => row.storeKey === 'pool');
  assert(pool !== undefined);
  const manual = scheduleFromDraft(bench, model, {
    [pool.id]: model.planned[pool.id].map(() => 0),
  });
  const comparison = compareWorkbench(bench, manual);

  const exported = buildWorkbenchExport(bench, manual, comparison);
  // It has to survive the trip out as JSON, which is the whole point.
  const parsed = JSON.parse(JSON.stringify(exported)) as typeof exported;

  assertEquals(parsed.format, 'shs.plan-workbench.v2');
  assertEquals(parsed.snapshot_id, bench.snapshot_id);
  assertEquals(parsed.quarters.length, 288);
  assertEquals(parsed.stores.length, bench.stores.length);
  // The pool ran in the planner's plan and does not in this one.
  const ran = parsed.quarters.findIndex(quarter => quarter.planner.charge_w.pool > 0);
  assert(ran >= 0, 'the planner heats the pool somewhere');
  assertEquals(parsed.quarters[ran].manual.charge_w.pool, 0);
  assertEquals(
    parsed.scores.total_delta_sek,
    comparison.totalDeltaSek,
  );
  // The heavy per-quarter series are in `quarters`, not duplicated in `scores`.
  assert(!('import_w' in parsed.scores.manual), 'no duplicated series');
  assert(!('state' in parsed.scores.planner), 'no duplicated trajectories');
});

// ---------------------------------------------------------------------------
// Balancing a hand-typed figure, and asking what selling would be worth.
// ---------------------------------------------------------------------------

/** A quarter's net grid flow under a schedule, straight from the physics. */
const netAt = (bench: DispatchWorkbench, schedule: DispatchSchedule, slot: number) =>
  bench.slots[slot].pv_w
  + bench.stores.reduce((t, s) => t + (schedule.discharge_w[s.key]?.[slot] ?? 0), 0)
  - bench.slots[slot].fixed_load_w
  - bench.stores.reduce((t, s) => t + (schedule.power_w[s.key]?.[slot] ?? 0), 0);

Deno.test('a hand-rounded overshoot is trimmed onto the load it meant to cover', () => {
  // 0.7 kW typed against a 676 W load is not a decision to sell 24 W, and the
  // grid row should not read as one.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const battery = model.rows.find(row => row.direction === 'discharge');
  assert(battery !== undefined, 'this home has a pack');
  const covers = bench.slots[0].fixed_load_w - bench.slots[0].pv_w;
  assert(covers > 200, 'the first quarter has a load to cover');

  // Built on the planner's own row with one quarter changed: zeroing the rest
  // would leave the pack overfull later and the breach under test would be
  // buried in overflow the edit caused elsewhere.
  const schedule = scheduleFromDraft(bench, model, {
    [battery.id]: model.planned[battery.id].map(
      (kw, i) => (i === 0 ? (covers + 50) / 1_000 : kw),
    ),
  });

  assertAlmostEquals(schedule.discharge_w.battery[0], covers, 1e-6);
  assertAlmostEquals(netAt(bench, schedule, 0), 0, 1e-6);
  assertEquals(
    compareWorkbench(bench, schedule).introduced
      .filter(entry => entry.message.includes('discharges into export')),
    [],
  );
});

Deno.test('a sale the household actually asked for is left alone', () => {
  // Half a kilowatt beyond the load is five times the editor's resolution, so
  // it is a decision rather than hand-rounding — and in a quarter opened to
  // selling, the trim must not quietly undo it.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const battery = model.rows.find(row => row.direction === 'discharge');
  assert(battery !== undefined);
  const covers = bench.slots[0].fixed_load_w - bench.slots[0].pv_w;

  const schedule = scheduleFromDraft(
    bench,
    model,
    {
      [battery.id]: model.planned[battery.id].map(
        (kw, i) => (i === 0 ? (covers + 500) / 1_000 : kw),
      ),
    },
    model.columns.map((_column, i) => i === 0),
  );

  assertAlmostEquals(schedule.discharge_w.battery[0], covers + 500, 1e-6);
  assertAlmostEquals(netAt(bench, schedule, 0), 500, 1e-6);
});

Deno.test('the permit decides whether a sale can be asked for at all', () => {
  // Not whether it is reported afterwards. With the switch off the quarter is
  // held at the load and no breach can arise; with it on the same figure sells.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const battery = model.rows.find(row => row.direction === 'discharge');
  assert(battery !== undefined);
  const covers = bench.slots[0].fixed_load_w - bench.slots[0].pv_w;
  const selling = {
    [battery.id]: model.planned[battery.id].map(
      (kw, i) => (i === 0 ? (covers + 500) / 1_000 : kw),
    ),
  };

  const held = scheduleFromDraft(bench, model, selling);
  const sold = scheduleFromDraft(
    bench, model, selling, model.columns.map((_c, i) => i === 0),
  );

  assertAlmostEquals(held.discharge_w.battery[0], covers, 1e-6);
  assertAlmostEquals(netAt(bench, held, 0), 0, 1e-6);
  assertAlmostEquals(sold.discharge_w.battery[0], covers + 500, 1e-6);
  assertAlmostEquals(netAt(bench, sold, 0), 500, 1e-6);

  // Neither is a breach: one could not sell, the other was allowed to.
  for (const schedule of [held, sold]) {
    assertEquals(
      compareWorkbench(bench, schedule).introduced
        .filter(entry => entry.message.includes('discharges into export')),
      [],
    );
  }
});

Deno.test('a quarter that balances reports no flow at all', () => {
  // Float error over 288 quarters produced 1.1e-13 W, which read as a sale.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const score = compareWorkbench(bench, bench.planned).manual;

  for (let index = 0; index < bench.slots.length; index += 1) {
    const flow = Math.abs(gridWattsAt(score, index));
    assert(
      flow === 0 || flow > 1e-6,
      `slot ${index} reports ${flow} W, which is noise rather than power`,
    );
  }
});

Deno.test('what a store holds is priced per kWh delivered, not per its own unit', () => {
  // The car's curve is over kilometres. Read raw it is nonsense beside a price;
  // through its own efficiency it is the number the objective compares.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const score = compareWorkbench(bench, bench.planned).manual;

  const series = storeValueSeries(bench, score);

  assertEquals(series.length, bench.stores.length);
  for (const entry of series) {
    assertEquals(entry.sekPerKwh.length, bench.slots.length);
    assert(
      entry.sekPerKwh.every(value => Number.isFinite(value) && value >= 0),
      `${entry.key} must be priced everywhere`,
    );
  }
  const pool = series.find(entry => entry.key === 'pool');
  assert(pool !== undefined);
  // A pool below its band is worth more than the dearest quarter of the day;
  // that is exactly why the planner heats it.
  assert(Math.max(...pool.sekPerKwh) > 1, `pool tops out at ${Math.max(...pool.sekPerKwh)}`);
});

Deno.test('with the permit off the pack is capped at the load it can cover', () => {
  // The defect this replaced: the permit only suppressed the message, so a
  // household could type the pack past the house load, watch the grid row go
  // negative, and be told afterwards it was not allowed.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const battery = model.rows.find(row => row.direction === 'discharge');
  assert(battery !== undefined);
  const covers = bench.slots[0].fixed_load_w - bench.slots[0].pv_w;

  // Ask for five kilowatts into a quarter that can absorb well under one.
  const schedule = scheduleFromDraft(bench, model, {
    [battery.id]: model.planned[battery.id].map((kw, i) => (i === 0 ? 5 : kw)),
  });

  assertAlmostEquals(schedule.discharge_w.battery[0], covers, 1e-6);
  assertAlmostEquals(netAt(bench, schedule, 0), 0, 1e-6);
  assertEquals(
    compareWorkbench(bench, schedule).introduced
      .filter(entry => entry.message.includes('discharges into export')),
    [],
  );
});

Deno.test('with the permit on the same figure is left to sell', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'quarter');
  const battery = model.rows.find(row => row.direction === 'discharge');
  assert(battery !== undefined);
  const covers = bench.slots[0].fixed_load_w - bench.slots[0].pv_w;

  const schedule = scheduleFromDraft(
    bench,
    model,
    { [battery.id]: model.planned[battery.id].map((kw, i) => (i === 0 ? 5 : kw)) },
    model.columns.map((_column, i) => i === 0),
  );

  assertAlmostEquals(schedule.discharge_w.battery[0], 5_000, 1e-6);
  assertAlmostEquals(netAt(bench, schedule, 0), 5_000 - covers, 1e-6);
});

Deno.test('what the editor snaps to is what the schedule then leaves alone', () => {
  // Two code paths for one rule is how they drift. They are deliberately not
  // identical — the editor takes the *column minimum* so an hourly figure
  // cannot sell in any of its quarters, while the schedule caps each quarter at
  // its own room — so the claim that matters is that the conservative one is
  // survivable: type the editor's ceiling and nothing is trimmed afterwards.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const model = buildWorkbenchModel(bench, 'hour');
  const battery = model.rows.find(row => row.direction === 'discharge');
  assert(battery !== undefined);

  const baseline = scheduleFromDraft(bench, model, {});
  const ceilings = model.columns.map(
    column => exportFreeCeilingKw(bench, column, baseline, 'battery'),
  );
  const schedule = scheduleFromDraft(bench, model, { [battery.id]: ceilings });

  for (const [index, column] of model.columns.entries()) {
    for (const slot of column.slots) {
      assertAlmostEquals(
        schedule.discharge_w.battery[slot],
        ceilings[index] * 1_000,
        1e-6,
        `column ${index} slot ${slot} was trimmed below what the editor offered`,
      );
      // Sunshine may still push the quarter into export on its own; what the
      // permit governs is whether the *pack* is part of that.
      assert(
        netAt(bench, schedule, slot) <= 1e-6 ||
          schedule.discharge_w.battery[slot] <= 1e-6,
        `slot ${slot} sells from the pack anyway`,
      );
    }
  }
});

Deno.test('a figure above the ceiling never sells, whatever the resolution', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  for (const granularity of ['quarter', 'hour'] as const) {
    const model = buildWorkbenchModel(bench, granularity);
    const battery = model.rows.find(row => row.direction === 'discharge');
    assert(battery !== undefined);

    const schedule = scheduleFromDraft(bench, model, {
      [battery.id]: model.columns.map(() => 9),
    });

    for (let slot = 0; slot < bench.slots.length; slot += 1) {
      assert(
        netAt(bench, schedule, slot) <= 1e-6 ||
          schedule.discharge_w.battery[slot] <= 1e-6,
        `${granularity} slot ${slot} sells from the pack with the permit off`,
      );
    }
  }
});

Deno.test('a quarter of grid charging lands in the pack, and the export says so', () => {
  // The confusion this answers: 5 kW typed into the pack for one quarter moves
  // it by 1.19 kWh, not 5, and the flow panel draws "battery in" *below* the
  // axis — which reads as export until the arithmetic is checked. It is not.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  // Isolate the manual-edit arithmetic from the optimiser's choice to serve
  // every dark quarter from storage.
  bench.planned.power_w.battery.fill(0);
  bench.planned.discharge_w.battery.fill(0);
  const model = buildWorkbenchModel(bench, 'quarter');
  const charge = model.rows.find(row => row.storeKey === 'battery' && row.direction === 'charge');
  assert(charge !== undefined);
  // Dark, so the grid is the only source, and with the pack otherwise idle —
  // a quarter where it is already covering load would net that off and the
  // arithmetic under test would be buried in it.
  const dark = bench.slots.findIndex(
    (slot, i) => slot.pv_w === 0 && (bench.planned.discharge_w.battery[i] ?? 0) === 0,
  );
  assert(dark >= 0);

  const schedule = scheduleFromDraft(bench, model, {
    [charge.id]: model.planned[charge.id].map((kw, i) => (i === dark ? 5 : kw)),
  });
  const score = compareWorkbench(bench, schedule).manual;
  const battery = bench.stores.find(store => store.key === 'battery');
  assert(battery !== undefined);

  // Bought, not sold — and the row is the physical balance of the quarter,
  // which is the property being doubted when a large import looks like a sale.
  assert(gridWattsAt(score, dark) > 0, 'the quarter imports');
  assertAlmostEquals(gridWattsAt(score, dark), -netAt(bench, schedule, dark), 1e-6);
  // Charging the pack raises the import by exactly what the pack draws.
  const idle = scheduleFromDraft(bench, model, {
    [charge.id]: model.planned[charge.id].map((kw, i) => (i === dark ? 0 : kw)),
  });
  assertAlmostEquals(
    gridWattsAt(score, dark) - gridWattsAt(compareWorkbench(bench, idle).manual, dark),
    5_000,
    1e-6,
  );
  // And it lands, at the charge efficiency the store declares.
  const moved = score.state.battery[dark + 1] - score.state.battery[dark];
  assertAlmostEquals(moved, 5 * 0.25 * battery.units_per_kwh(0, dark), 1e-6);
  assert(moved > 0, 'the pack fills');
});

// ---------------------------------------------------------------------------
// The half of the answer the utility curves cannot reach.
// ---------------------------------------------------------------------------

Deno.test('the bill is bought minus sold, and nothing the curves touch', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const score = compareWorkbench(bench, bench.planned).planner;

  assertAlmostEquals(score.billable_sek, score.import_sek - score.export_sek, 1e-9);
  // Explicitly not the objective: wear, starts, the peak shadow price and the
  // service delivered are all real terms, and none of them is invoiced.
  assert(score.wear_sek > 0, 'the fixture wears the pack');
  assert(
    Math.abs(score.total_sek - score.billable_sek) > 1,
    'the two must not be the same number by accident',
  );
});

Deno.test('the quoted part of the bill is the published quarters only', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const score = compareWorkbench(bench, bench.planned).planner;

  let expected = 0;
  for (let index = 0; index < bench.slots.length; index += 1) {
    if (!bench.slots[index].published_price) continue;
    const slot = bench.slots[index];
    expected += score.import_w[index] / 1_000 * 0.25 * slot.import_price_sek_per_kwh
      - score.export_w[index] / 1_000 * 0.25 * slot.export_price_sek_per_kwh;
  }

  assertAlmostEquals(score.billable_quoted_sek, expected, 1e-9);
  assert(
    bench.slots.some(slot => !slot.published_price),
    'the horizon runs past the quoted window, or this test proves nothing',
  );
});

Deno.test('doing nothing is cheapest on the bill and worst on the objective', () => {
  // The trap the caption warns about, and the reason the bill is shown beside
  // the score rather than instead of it: a plan that serves nobody always wins
  // on money.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const comparison = compareWorkbench(bench, { power_w: {}, discharge_w: {} });

  assert(
    comparison.billableDeltaSek < 0,
    `doing nothing must cost less: ${comparison.billableDeltaSek}`,
  );
  assert(
    comparison.totalDeltaSek > 0,
    `and still score worse: ${comparison.totalDeltaSek}`,
  );
});

Deno.test('a curve reaching past the hardware cap is reported as a ratio', () => {
  // Stated as a fraction of what the store can hold, never as a level: a
  // vehicle's curve is over range, its cap is enforced as SOC, and the
  // kilometres in one SOC move a long way between January and July. The ratio
  // is the same in both.
  const bench = workbench();
  const [car] = bench.stores;
  bench.stores = [{
    ...car,
    max_state: 390.4,
    curve: {
      unit: 'km',
      points: [
        { at: 100, sek_per_unit: 1.225247 },
        { at: 400, sek_per_unit: 0.408416 },
        { at: 500, sek_per_unit: 0 },
      ],
    },
  }];

  const [found] = curvesBeyondReach(bench);

  assertEquals(found.key, 'ev');
  assertEquals(found.topAt, 500);
  assertEquals(found.reachable, 390.4);
  assertAlmostEquals(found.ratio, 1.2807, 1e-4);
  // Read back through the 80% charge limit that produced 390.4 km, the curve
  // is asking for 102% SOC — which no season makes reachable.
  assertAlmostEquals(found.ratio * 0.8, 1.0246, 1e-4);
});

Deno.test('a curve the store can reach is not reported', () => {
  const bench = workbench();
  const [car] = bench.stores;
  bench.stores = [{
    ...car,
    max_state: 500,
    curve: {
      unit: 'km',
      points: [{ at: 100, sek_per_unit: 1 }, { at: 480, sek_per_unit: 0 }],
    },
  }];

  assertEquals(curvesBeyondReach(bench), []);
});

Deno.test('a store with no ceiling has nothing to reach past', () => {
  const bench = workbench();
  const [car] = bench.stores;
  bench.stores = [{ ...car, max_state: undefined }];

  assertEquals(curvesBeyondReach(bench), []);
});

Deno.test('the worth row reads the curve the household is looking at', () => {
  // Editing a threshold and coming here showed the curve the snapshot was
  // captured with: 4.87 SEK/kWh against a curve editor saying 2.05 for the
  // same 239 km. The workbench takes the snapshot's curves only where settings
  // hold none, so the two views cannot disagree about what a store is worth.
  const base = realSnapshot();
  const edited = {
    ...base,
    value_curves: {
      ...base.value_curves,
      pool: {
        unit: 'celsius',
        points: [
          { at: 20, sek_per_unit: 40 },
          { at: 24, sek_per_unit: 0 },
        ],
      },
    },
  } as typeof base;

  const before = dispatchWorkbench(base);
  const after = dispatchWorkbench(edited);
  assert(before !== null && after !== null);

  const worthOf = (bench: DispatchWorkbench) =>
    storeValueSeries(bench, compareWorkbench(bench, bench.planned).manual)
      .find(series => series.key === 'pool')!.sekPerKwh[0];

  // The fixture's pool sits at 27.1 °C: worth something on the shipped curve,
  // worth nothing on one that stops caring at 24.
  assert(worthOf(before) > 0, 'the shipped curve still values the pool');
  assertEquals(worthOf(after), 0);
});

Deno.test('a windowed score accounts for that window only', () => {
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const whole = compareWorkbench(bench, bench.planned).planner;
  const days = [0, 96, 192, 288].slice(0, -1).map((from, at) => compareWorkbench(
    bench,
    bench.planned,
    { from, to: [96, 192, 288][at] },
  ).planner);

  // Money is a sum over quarters, so the days must add back up to the horizon.
  assertAlmostEquals(
    days.reduce((total, day) => total + day.billable_sek, 0),
    whole.billable_sek,
    1e-9,
  );
  assertAlmostEquals(
    days.reduce((total, day) => total + day.grid_import_kwh, 0),
    whole.grid_import_kwh,
    1e-9,
  );
  assert(days.every(day => day.billable_sek !== whole.billable_sek));
});

Deno.test('terminal value belongs only to the window holding the horizon end', () => {
  // It prices what the house is left holding, which is not something Tuesday
  // can be credited with while Wednesday is still to come.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const first = compareWorkbench(bench, bench.planned, { from: 0, to: 96 }).planner;
  const last = compareWorkbench(bench, bench.planned, { from: 192, to: 288 }).planner;
  const battery = (score: typeof first) =>
    score.stores.find(store => store.key === 'battery')!;

  // The pack carries terminal weight and no usage weight, so its service value
  // is entirely terminal: zero in an early window, non-zero in the last.
  assertEquals(battery(first).service_value_sek, 0);
  assert(battery(last).service_value_sek !== 0);
});

Deno.test('a window is projected from the start, not from its own edge', () => {
  // Tuesday's cost depends on where Monday left the house.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const windowed = compareWorkbench(bench, bench.planned, { from: 192, to: 288 }).planner;
  const whole = compareWorkbench(bench, bench.planned).planner;

  // Same trajectory, whatever is being accounted for.
  assertEquals(windowed.state.battery[192], whole.state.battery[192]);
  assertEquals(windowed.state.battery[288], whole.state.battery[288]);
  assert(
    windowed.state.battery[192] !== bench.stores.find(s => s.key === 'battery')!.initial_state,
    'the third day does not start where the first did',
  );
});


Deno.test('a v2 export carries what the objective was computed from', () => {
  // v1 showed what was decided and not what it was decided against, so an audit
  // could compare the two schedules it was handed but never check either.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const comparison = compareWorkbench(bench, bench.planned);

  const exported = JSON.parse(JSON.stringify(
    buildWorkbenchExport(bench, bench.planned, comparison),
  )) as ReturnType<typeof buildWorkbenchExport>;

  assertEquals(exported.format, 'shs.plan-workbench.v2');
  const battery = exported.stores.find(store => store.key === 'battery')!;
  assert(battery.curve.length > 0, 'the curve the objective priced it against');
  assertEquals(battery.usage_weight.length, bench.stores[0].usage_weight.length);
  assertEquals(battery.units_per_kwh_by_slot.length, 288);
  assertEquals(battery.drift_by_slot.length, 288);
  assert(battery.state_per_kwh_out_by_slot !== null, 'the pack can discharge');
  assert(battery.terminal_weight > 0, 'the pack is valued at the horizon edge');

  // The publication flag v1 omitted, which is what separates a forecast saving
  // from money.
  assert(
    exported.quarters.some(quarter => quarter.published_price),
    'some of the horizon is quoted',
  );
  assert(
    exported.quarters.some(quarter => !quarter.published_price),
    'and some of it is the shaped tail',
  );
});

Deno.test('a v2 export says why, not only what', () => {
  // A declined discharge looks identical in the schedule whether it was never
  // bid, bid and outranked, or bid, won and released by settlement.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);
  const exported = buildWorkbenchExport(
    bench,
    bench.planned,
    compareWorkbench(bench, bench.planned),
  );

  assertEquals(exported.quarters.length, 288);
  assert(
    exported.quarters.some(quarter => quarter.planner_allocations.length > 0),
    'the planner accepted moves somewhere, and they must be recorded',
  );
  assert(
    exported.quarters.some(quarter => quarter.planner_battery !== null),
    'the pack is compared in every quarter it exists',
  );
  // Every recorded move names the store, direction and what it was worth.
  for (const quarter of exported.quarters) {
    for (const part of quarter.planner_allocations) {
      assert(typeof part.store_key === 'string');
      assert(part.direction === 'charge' || part.direction === 'discharge');
      assert(Number.isFinite(part.net_value_sek));
    }
  }
});

Deno.test('an export covers the whole horizon whatever day is on screen', () => {
  // The scores on screen follow the day tabs; a file does not. An audit
  // reproduces complete-horizon figures, and an export whose meaning depended
  // on an invisible tab selection would be silently incomparable with the last.
  const bench = dispatchWorkbench(realSnapshot());
  assert(bench !== null);

  const whole = buildWorkbenchExport(
    bench,
    bench.planned,
    compareWorkbench(bench, bench.planned),
  );
  const windowed = buildWorkbenchExport(
    bench,
    bench.planned,
    compareWorkbench(bench, bench.planned, { from: 96, to: 192 }),
  );

  assertEquals(whole.quarters.length, 288);
  assertEquals(windowed.quarters.length, 288);
  // The quarters are always the full horizon; only a windowed *comparison*
  // would narrow the scores, which is why the component must not pass one.
  assert(
    whole.scores.planner.billable_sek !== windowed.scores.planner.billable_sek,
    'a windowed comparison really does change the file, so the caller matters',
  );
});

Deno.test('a partial first quarter has consistent workbench energy and cost', () => {
  const bench = workbench();
  bench.slots[0].duration_hours = .125;
  bench.stores[0].slot_hours = bench.slots.map(s => s.duration_hours ?? .25);
  const model = buildWorkbenchModel(bench, 'hour');
  assertAlmostEquals(model.planned['ev:charge'][0] * .875, 11.04 * .125);
  const score = compareWorkbench(bench, bench.planned).manual;
  const chart = buildWorkbenchChart(bench, bench.planned, score, String, key => key);
  assertAlmostEquals(chart.rows[0].cumulativeCostSek, 11.54 * .125 * 2.4);
  assertAlmostEquals(chart.rows.at(-1)!.cumulativeCostSek, score.billable_sek);
});
