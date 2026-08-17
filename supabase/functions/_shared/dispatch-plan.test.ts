import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type DispatchLimits,
  type DispatchSlot,
  type DispatchStore,
  planDispatch,
} from "./dispatch-plan.ts";
import type { UtilityCurve } from "./store-value.ts";

const LIMITS: DispatchLimits = {
  grid_import_limit_w: 13_200,
  grid_export_limit_w: 13_200,
};

const SLOTS_PER_DAY = 96;

/** A day: dark until 06:00, a solar bell to 18:00, dark after. */
function solarDay(peakW: number): number[] {
  return Array.from({ length: SLOTS_PER_DAY }, (_slot, index) => {
    const hour = index / 4;
    if (hour < 6 || hour > 18) return 0;
    return Math.round(peakW * Math.sin(((hour - 6) / 12) * Math.PI));
  });
}

function buildSlots(
  pvByDay: number[][],
  { importPrice = 1.2, exportPrice = 0.35 } = {},
): DispatchSlot[] {
  return pvByDay.flat().map((pv_w) => ({
    pv_w,
    fixed_load_w: 600,
    import_price_sek_per_kwh: importPrice,
    export_price_sek_per_kwh: exportPrice,
  }));
}

/** Weight spread evenly across a window, summing to 1. */
function weightWindow(count: number, from: number, to: number): number[] {
  const weight = new Array(count).fill(0);
  const span = Math.max(1, to - from);
  for (let index = from; index < to && index < count; index += 1) {
    weight[index] = 1 / span;
  }
  return weight;
}

const evCurve: UtilityCurve = {
  unit: "km",
  points: [
    { at: 80, sek_per_unit: 2.5 },
    { at: 200, sek_per_unit: 0.35 },
    { at: 320, sek_per_unit: 0.08 },
    { at: 480, sek_per_unit: 0 },
  ],
};

const poolCurve: UtilityCurve = {
  unit: "celsius",
  points: [
    { at: 25, sek_per_unit: 80 },
    { at: 28, sek_per_unit: 30 },
    { at: 30, sek_per_unit: 8 },
    { at: 31, sek_per_unit: 0 },
  ],
};

function evStore(
  slots: number,
  rangeKm: number,
  departure: number,
): DispatchStore {
  return {
    key: "ev",
    curve: evCurve,
    initial_state: rangeKm,
    max_power_w: 11_000,
    retention_per_slot: 1, // a parked car does not leak range
    usage_weight: weightWindow(slots, departure, departure + 1),
    units_per_kwh: () => 0.9 / 0.16, // 90% charging at 0.16 kWh/km
    drift: (state) => state,
  };
}

function poolStore(slots: number, waterC: number): DispatchStore {
  const capacityKwhPerK = 55 * 1.163;
  return {
    key: "pool",
    curve: poolCurve,
    initial_state: waterC,
    max_power_w: 3_500,
    min_run_slots: 4,
    start_cost_sek: 0.5,
    retention_per_slot: 0.994,
    // Somebody might swim any afternoon; the weight says when warmth is wanted.
    usage_weight: weightWindow(slots, 0, slots),
    units_per_kwh: () => 4.5 / capacityKwhPerK, // COP 4.5 into 55 m³
    drift: (state) => state - (state - 18) * 0.006,
  };
}

Deno.test("a car with unmet range takes today's surplus instead of exporting", () => {
  // The §1.6.1 defect exactly: surplus today, car below target, old planner
  // exported and scheduled charging days later.
  const slots = buildSlots([solarDay(8_000), solarDay(8_000)]);
  const ev = evStore(slots.length, 90, slots.length - 1);

  const result = planDispatch(slots, [ev], LIMITS);

  const firstDay = result.power_w.ev.slice(0, SLOTS_PER_DAY);
  const chargedToday = firstDay.reduce((sum, value) => sum + value, 0);
  assert(
    chargedToday > 0,
    "charging must start on the first day's surplus, not wait",
  );
  // And it must land in daylight, where the energy costs the export price
  // rather than the much dearer import price.
  const middayW = firstDay.slice(40, 60).reduce((sum, value) => sum + value, 0);
  assert(middayW > 0, "the cheapest energy of the day is midday surplus");
});

Deno.test("charging is spread across slots, not one contiguous block", () => {
  const slots = buildSlots([solarDay(8_000), solarDay(8_000)]);
  const ev = evStore(slots.length, 90, slots.length - 1);

  const schedule = planDispatch(slots, [ev], LIMITS).power_w.ev;
  const runs: number[] = [];
  let run = 0;
  for (const value of schedule) {
    if (value > 0) run += 1;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);

  assert(runs.length >= 2, `expected several runs, got ${runs.length}`);
});

Deno.test("a full car stops bidding and the energy is exported", () => {
  const slots = buildSlots([solarDay(8_000)]);
  const ev = evStore(slots.length, 500, slots.length - 1);

  const result = planDispatch(slots, [ev], LIMITS);

  assertEquals(
    result.power_w.ev.reduce((sum, value) => sum + value, 0),
    0,
    "past the top of its curve a store must not buy at any price",
  );
  assert(result.export_w.some((value) => value > 0));
});

Deno.test("nothing is bought when the price exceeds what it is worth", () => {
  // No sun, and import dearer than the top of the pool's curve is worth.
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 40,
  });
  const pool = poolStore(slots.length, 26);

  const result = planDispatch(slots, [pool], LIMITS);

  assertEquals(result.power_w.pool.reduce((sum, value) => sum + value, 0), 0);
});

Deno.test("§8.12 #3 — a cloudy tomorrow pulls pool heating into today", () => {
  const sunnyThenCloudy = buildSlots([solarDay(9_000), solarDay(300)]);
  const twoSunnyDays = buildSlots([solarDay(9_000), solarDay(9_000)]);

  const todayWhenTomorrowIsCloudy = planDispatch(
    sunnyThenCloudy,
    [poolStore(sunnyThenCloudy.length, 25)],
    LIMITS,
  ).power_w.pool.slice(0, SLOTS_PER_DAY).reduce((sum, v) => sum + v, 0);

  const todayWhenTomorrowIsSunny = planDispatch(
    twoSunnyDays,
    [poolStore(twoSunnyDays.length, 25)],
    LIMITS,
  ).power_w.pool.slice(0, SLOTS_PER_DAY).reduce((sum, v) => sum + v, 0);

  assert(
    todayWhenTomorrowIsCloudy >= todayWhenTomorrowIsSunny,
    "a cloudy forecast must bring heating forward, not leave it unchanged",
  );
});

Deno.test("§8.12 #4 — the ranking between car and pool reverses on state", () => {
  const slots = buildSlots([solarDay(4_000)]);
  const scarce: DispatchLimits = {
    grid_import_limit_w: 0, // only surplus is available, so they must compete
    grid_export_limit_w: 13_200,
  };

  const emptyCar = planDispatch(
    slots,
    [evStore(slots.length, 60, slots.length - 1), poolStore(slots.length, 25)],
    scarce,
  );
  const fullCar = planDispatch(
    slots,
    [evStore(slots.length, 430, slots.length - 1), poolStore(slots.length, 25)],
    scarce,
  );

  const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
  assert(
    sum(emptyCar.power_w.ev) > sum(emptyCar.power_w.pool),
    "a nearly empty car must outbid a cool pool",
  );
  assert(
    sum(fullCar.power_w.pool) > sum(fullCar.power_w.ev),
    "and a nearly full one must not — no static priority can do this",
  );
});

Deno.test("a minimum run is honoured once a compressor starts", () => {
  const slots = buildSlots([solarDay(9_000)]);
  const pool = poolStore(slots.length, 24);

  const schedule = planDispatch(slots, [pool], LIMITS).power_w.pool;
  let run = 0;
  const runs: number[] = [];
  for (const value of schedule) {
    if (value > 0) run += 1;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);

  assert(runs.length > 0, "a cold pool on a sunny day must be heated");
  for (const length of runs) {
    assert(length >= 4, `every run must respect min_run_slots, got ${length}`);
  }
});

Deno.test("the grid import limit is never exceeded", () => {
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 0.05,
  });
  const tight: DispatchLimits = {
    grid_import_limit_w: 4_000,
    grid_export_limit_w: 13_200,
  };
  const result = planDispatch(
    slots,
    [evStore(slots.length, 60, slots.length - 1), poolStore(slots.length, 24)],
    tight,
  );

  for (let index = 0; index < slots.length; index += 1) {
    const drawW = slots[index].fixed_load_w +
      result.power_w.ev[index] + result.power_w.pool[index] -
      slots[index].pv_w;
    assert(
      drawW <= tight.grid_import_limit_w + 1e-6,
      `slot ${index} draws ${drawW} W above a ${tight.grid_import_limit_w} W limit`,
    );
  }
});

Deno.test("dispatch terminates without hitting the iteration cap", () => {
  const slots = buildSlots([solarDay(9_000), solarDay(9_000), solarDay(9_000)]);
  const result = planDispatch(
    slots,
    [evStore(slots.length, 70, slots.length - 1), poolStore(slots.length, 24)],
    LIMITS,
  );

  assertEquals(result.stopped_because, "no_profitable_candidate");
});
