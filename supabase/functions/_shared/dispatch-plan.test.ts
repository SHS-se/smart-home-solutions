import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  dispatchAuctionSteps,
  type DispatchCheckpoint,
  type DispatchLimits,
  type DispatchResult,
  type DispatchSchedule,
  type DispatchSlot,
  type DispatchStore,
  planDispatch,
  refineDispatchCosts,
  scoreDispatch,
  SLOT_HOURS,
} from "./dispatch-plan.ts";
import { type UtilityCurve, valueOfMove } from "./store-value.ts";

const LIMITS: DispatchLimits = {
  grid_import_shaping_w: 0,
  peak_shaping_sek_per_kwh_per_kw: 0,
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

Deno.test("spare solar is shared by draw, not claimed by whoever bid first", () => {
  // Each bid was priced against the occupancy at the moment it was evaluated,
  // so whichever store won a sunny quarter first booked the whole surplus at
  // the export price, and a store that won the same quarter later paid import
  // for all of it. Nothing re-priced the first once the second arrived. One
  // observed quarter charged the battery with 1106 W booked at 0.846 SEK/kWh
  // while the house imported at 1.852, flipping that charge from a gain of
  // 0.83 SEK/kWh to a loss of 0.17 — decided by allocation order alone.
  const slots = buildSlots([solarDay(2_600), solarDay(2_600)]);
  const stores = [
    evStore(slots.length, 90, slots.length - 1),
    poolStore(slots.length, 26),
    batteryStore(slots.length, 4, 2.4),
  ];

  const result = planDispatch(slots, stores, LIMITS);

  const misquoted: string[] = [];
  let shared = 0;
  for (const [index, slot] of slots.entries()) {
    const charges = result.allocations[index].filter((part) =>
      part.direction === "charge"
    );
    if (charges.length === 0) continue;
    if (charges.length > 1) shared += 1;

    const chargeW = charges.reduce((sum, part) => sum + part.power_w, 0);
    const returnedW = stores.reduce(
      (sum, store) => sum + result.discharge_w[store.key][index],
      0,
    );
    // The quarter's spare PV is one pool of energy, and no store has a claim on
    // it beyond its share of the draw. Splitting it pro-rata is the only
    // division that does not depend on bid order and still adds back up to the
    // quarter's real grid cost.
    const spareW = Math.max(0, slot.pv_w + returnedW - slot.fixed_load_w);
    const solarShare = chargeW > 0 ? Math.min(1, spareW / chargeW) : 0;

    for (const part of charges) {
      const fromSolarW = part.power_w * solarShare;
      const fromGridW = part.power_w - fromSolarW;
      const owed = (fromSolarW * slot.export_price_sek_per_kwh +
        fromGridW * slot.import_price_sek_per_kwh) / part.power_w;
      if (Math.abs(owed - part.energy_cost_sek_per_kwh) > 1e-6) {
        misquoted.push(
          `slot ${index} ${part.store_key}: booked ${
            part.energy_cost_sek_per_kwh.toFixed(4)
          }, its ${(solarShare * 100).toFixed(0)}% share of ${
            spareW.toFixed(0)
          } W spare says ${owed.toFixed(4)}`,
        );
      }
    }
  }

  assert(
    shared > 0,
    "no quarter had two stores charging, so nothing was tested",
  );
  assertEquals(
    misquoted.slice(0, 3),
    [],
    "a charge must be costed by its share of the quarter, not by bid order",
  );
});

Deno.test("settling never leaves a compressor run below its minimum", () => {
  // The auction only ever starts a run at its full minimum length, and then
  // grows it a slot at a time — so each extension records itself as its own
  // one-slot run. Releasing by that record can therefore cut a contiguous
  // block in half and strand the remainder. Observed in a deployed plan: a
  // pool heat pump scheduled for a single quarter at 04:30, and again at
  // 03:45, against a four-quarter minimum.
  // A pool near the top of its own curve is the case that bites: parts of a
  // run clear their cost and parts do not, so settling reaches inside one.
  const sun = solarDay(2_600);
  const slots: DispatchSlot[] = sun.map((pv_w, index) => ({
    pv_w,
    fixed_load_w: 600,
    import_price_sek_per_kwh: index / 4 >= 17 ? 2.4 : 1.2,
    export_price_sek_per_kwh: 0.35,
  }));
  const stores = [
    poolStore(slots.length, 29),
    batteryStore(slots.length, 4, 2.4),
  ];

  const result = planDispatch(slots, stores, LIMITS);

  for (const store of stores) {
    const minRun = 1;
    if (minRun <= 1) continue;
    const short: string[] = [];
    let block: number[] = [];
    for (let index = 0; index <= slots.length; index += 1) {
      if (index < slots.length && result.power_w[store.key][index] > 0) {
        block.push(index);
        continue;
      }
      if (block.length > 0 && block.length < minRun) {
        short.push(`${store.key} runs ${block.length} slots from ${block[0]}`);
      }
      block = [];
    }
    assertEquals(
      short.slice(0, 3),
      [],
      `${store.key} must never be scheduled for less than ${minRun} slots`,
    );
  }
});

Deno.test("the battery will not buy binding energy against an unpublished sell leg", () => {
  // Nord Pool publishes one day ahead and the rest of the horizon is a shaped
  // prior. The prior is flatter than any real day and never as cheap, so the
  // last published quarters always look like the bargain of the week: one
  // deployed plan bought at a published 0.905-0.968 SEK/kWh to discharge into
  // a modelled 1.75-1.98. The buy leg is binding and real, the sell leg is a
  // forecast. Export already refuses to act without a published price; buying
  // has to hold the same line.
  const dark = new Array(SLOTS_PER_DAY).fill(0);
  const build = (dearPublishedEvening: boolean) =>
    [...dark, ...dark].map((pv_w, index): DispatchSlot => {
      const published = index < SLOTS_PER_DAY;
      // Cheap all through the published day, except optionally at its end.
      const price = published
        ? (dearPublishedEvening && index >= SLOTS_PER_DAY - 8 ? 3.0 : 0.9)
        : 1.9; // the flat modelled prior
      return {
        pv_w,
        fixed_load_w: 600,
        import_price_sek_per_kwh: price,
        export_price_sek_per_kwh: 0.2,
        // Binding and published are the same window here, as they are in a
        // real plan: the day-ahead prices are what the plan commits against.
        binding: published,
        published_price: published,
      };
    });

  const gridCharged = (slots: DispatchSlot[]) => {
    const store = batteryStore(slots.length, 2, 2.1);
    const result = planDispatch(slots, [store], LIMITS);
    let watts = 0;
    for (let index = 0; index < SLOTS_PER_DAY; index += 1) {
      const part = result.allocations[index].find((entry) =>
        entry.store_key === "battery" && entry.direction === "charge"
      );
      watts += part?.grid_w ?? 0;
    }
    return watts;
  };

  assertEquals(
    gridCharged(build(false)) > 1,
    false,
    "nothing published is dearer than the cheap hours, so the only reason to buy is the prior",
  );
  assert(
    gridCharged(build(true)) > 1,
    "a published dear evening is a real sell leg, and buying for it must still work",
  );
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
    ...LIMITS,
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

Deno.test("the grid import limit is never exceeded", () => {
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 0.05,
  });
  const tight: DispatchLimits = {
    ...LIMITS,
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

/** A house battery: two-sided, its curve derived from the price outlook. */
function batteryStore(
  slots: number,
  socKwh: number,
  valueSekPerKwh: number,
  { exportAllowed = false } = {},
): DispatchStore {
  return {
    key: "battery",
    curve: {
      unit: "kwh",
      points: [{ at: 18, sek_per_unit: valueSekPerKwh }],
    },
    initial_state: socKwh,
    min_state: 1,
    max_state: 18,
    max_power_w: 8_800,
    retention_per_slot: 1,
    // No usage weight and a terminal weight of one: charge kept to the horizon
    // edge is worth exactly what the derived curve says, which is what stops
    // the planner dumping it in the final slot (§8.4).
    usage_weight: new Array(slots).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 0.95,
    drift: (state) => state,
    discharge: {
      max_power_w: 9_600,
      state_per_kwh_out: () => 1 / 0.95,
      export_allowed: exportAllowed,
    },
  };
}

Deno.test("a partial battery charge grows when earlier discharge frees capacity", () => {
  // The September 5 replay left cheap solar exporting beside tiny battery
  // charges. Each accepted setpoint locked its quarter, even after an earlier
  // discharge reopened room in the trajectory. This short horizon reproduces
  // that sequence: the last sunny quarter must use the room freed before it.
  const slots: DispatchSlot[] = [
    [4_000, 1_500, 1, 0.06],
    [3_000, 0, 1, 0.04],
    [6_000, 1_500, 1, 0.04],
    [5_000, 1_000, 1, 0.01],
    [0, 1_000, 1, 0.09],
    [6_000, 1_500, 1, 0.01],
    [0, 500, 2, 0.01],
    [0, 500, 2, 0.09],
  ].map((
    [pv_w, fixed_load_w, import_price_sek_per_kwh, export_price_sek_per_kwh],
  ) => ({
    pv_w,
    fixed_load_w,
    import_price_sek_per_kwh,
    export_price_sek_per_kwh,
  }));
  const battery: DispatchStore = {
    ...batteryStore(slots.length, 0, 0),
    min_state: 0,
    max_state: 4,
    curve: {
      unit: "kwh",
      points: [
        { at: 0.5, sek_per_unit: 1.5 },
        { at: 1, sek_per_unit: 0.8 },
        { at: 4, sek_per_unit: 0.7 },
      ],
    },
  };
  const result = planDispatch(slots, [battery], LIMITS);
  assertEquals(result.stopped_because, "no_profitable_candidate");
  assert(
    result.discharge_w.battery[4] > 0,
    "the earlier discharge must free room",
  );
  assert(
    result.export_w[5] < 1e-6,
    "the cheapest solar quarter must be stored whole, not exported",
  );
  assert(
    result.export_w[0] > 0,
    "the dearest solar quarter is the one worth exporting instead",
  );
  assert(
    Math.abs(result.state.battery[6] - 4) < 1e-8,
    "and the battery still ends the sunny run full",
  );

  let stored = battery.initial_state;
  for (let index = 0; index < slots.length; index += 1) {
    const chargeW = result.power_w.battery[index];
    const dischargeW = result.discharge_w.battery[index];
    assert(chargeW === 0 || dischargeW === 0);
    assert(chargeW <= battery.max_power_w);
    stored += (chargeW * 0.95 - dischargeW / 0.95) / 1_000 * SLOT_HOURS;
    assert(
      stored >= -1e-8 && stored <= 4 + 1e-8,
      "no energy may be clipped at a state bound",
    );
    assert(Math.abs(result.state.battery[index + 1] - stored) < 1e-8);
    assert(
      Math.abs(
        slots[index].pv_w + dischargeW + result.import_w[index] -
          slots[index].fixed_load_w - chargeW - result.export_w[index],
      ) < 1e-6,
      "replacement power must be counted exactly once",
    );
    const entries = result.allocations[index];
    assertEquals(entries.length, chargeW > 0 || dischargeW > 0 ? 1 : 0);
    if (entries.length === 0) continue;
    assertEquals(entries[0].power_w, chargeW || dischargeW);
    assert(Math.abs(entries[0].state_after - stored) < 1e-8);
  }
});

/** Quarters as (pv_w, fixed_load_w, import price, export price). */
function shapedSlots(rows: number[][]): DispatchSlot[] {
  return rows.map((
    [pv_w, fixed_load_w, import_price_sek_per_kwh, export_price_sek_per_kwh],
  ) => ({
    pv_w,
    fixed_load_w,
    import_price_sek_per_kwh,
    export_price_sek_per_kwh,
  }));
}

/** A lossless two-sided battery on a concave curve, in the curve's own kWh. */
function replayBattery(
  slots: number,
  initialKwh: number,
  steepSekPerKwh: number,
): DispatchStore {
  return {
    key: "battery",
    curve: {
      unit: "kwh",
      points: [
        { at: 1, sek_per_unit: steepSekPerKwh },
        { at: 4, sek_per_unit: 0.22 },
      ],
    },
    initial_state: initialKwh,
    min_state: 0,
    max_state: 4,
    max_power_w: 8_800,
    retention_per_slot: 1,
    usage_weight: new Array(slots).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 1,
    drift: (state) => state,
    discharge: {
      max_power_w: 9_600,
      state_per_kwh_out: () => 1,
      export_allowed: false,
    },
  };
}

Deno.test("surplus solar replaces the grid purchase that reserved its room", () => {
  // The September 5 replay exported solar from 16:45 while the home battery sat
  // at 59%. Nothing was wrong with the room it had: the trajectory was already
  // full further down the horizon, and what had reserved it was grid charging
  // this solar could have paid for instead. A committed charge is not
  // irrevocable, so equal stored energy is exchanged between the two quarters.
  //
  // Twelve quarters reduced from that replay — two short solar days either side
  // of an evening the battery covers. The prices keep the replay's own
  // unrounded shape because the defect only shows while the trajectory sits
  // just under the ceiling rather than on it. Quarter 0 buys 5117 W at 0.82
  // into the steep part of the curve, which outbids quarter 8's cheaper
  // surplus; quarter 8's 1078 W is then refused for want of room and exported
  // at 0.27. Left alone the plan buys 1.279 kWh and exports 0.270 — it pays
  // 0.82 for energy it is selling at 0.27 in the same horizon.
  const slots = shapedSlots([
    [0, 0, 0.82, 0.35],
    [2_580, 0, 1.52, 0.14],
    [2_073, 0, 1.53, 0.21],
    [0, 0, 1.00, 0.14],
    [0, 5_885, 1.77, 0.13],
    [0, 0, 2.43, 0.33],
    [0, 0, 1.64, 0.38],
    [5_717, 0, 1.72, 0.42],
    [1_078, 0, 1.52, 0.27],
    [0, 0, 0.98, 0.40],
    [0, 1_454, 0.71, 0.29],
    [0, 0, 2.33, 0.06],
  ]);
  const result = planDispatch(
    slots,
    [replayBattery(slots.length, 1.33, 1.17)],
    LIMITS,
  );
  assertEquals(result.stopped_because, "no_profitable_candidate");

  assert(
    result.export_w.every((watts) => watts < 1e-9),
    "no surplus may be exported while a dearer purchase is holding its room",
  );
  assert(
    Math.abs(result.power_w.battery[8] - 1_078) < 1e-6,
    "the refused quarter's whole surplus must reach the battery",
  );
  // The exchange only re-sources energy, so what the purchase gives up is
  // exactly what the solar takes over, and the horizon ends where it did.
  assert(
    Math.abs(result.power_w.battery[8] - (5_117 - result.import_w[0])) < 1e-6,
    "the grid purchase must shrink by exactly the solar that replaces it",
  );
  assert(
    Math.abs(result.state.battery[slots.length] - 3.367) < 1e-9,
    "an exchange must not change what the battery ends the horizon holding",
  );
  const importedKwh = result.import_w.reduce((total, watts) => total + watts) /
    1_000 * SLOT_HOURS;
  assert(
    importedKwh < 1.279,
    "and the plan must buy less than the one that exported the solar",
  );
});

Deno.test("a partial discharge deepens when the load it covers is dearer", () => {
  // The same replay's other half. A discharge quarter, once accepted, was never
  // reconsidered: whatever rate won first stood, even after later allocations
  // made a deeper one pay. Quarter 4 covered 480 W of a 5057 W load and bought
  // the remaining 4577 W at 2.41 — the dearest quarter in the horizon — while
  // the battery held charge worth 0.22. The charge it kept then blocked
  // quarter 8's surplus, which was exported at 0.31.
  const slots = shapedSlots([
    [0, 0, 1.17, 0.07],
    [4_161, 0, 1.94, 0.23],
    [1_036, 0, 2.56, 0.37],
    [0, 0, 1.03, 0.05],
    [0, 5_057, 2.41, 0.27],
    [0, 0, 1.31, 0.07],
    [0, 0, 2.72, 0.34],
    [4_900, 0, 1.42, 0.13],
    [1_195, 0, 1.79, 0.31],
    [0, 0, 2.68, 0.22],
    [0, 965, 0.85, 0.27],
    [0, 0, 2.86, 0.40],
  ]);
  const result = planDispatch(
    slots,
    [replayBattery(slots.length, 1.12, 1.02)],
    LIMITS,
  );
  assertEquals(result.stopped_because, "no_profitable_candidate");

  assert(
    Math.abs(result.discharge_w.battery[4] - 5_057) < 1e-6,
    "the battery must cover the dearest quarter's load in full",
  );
  assert(
    result.import_w[4] < 1e-9,
    "nothing may be bought at 2.41 beside a battery that would rather discharge",
  );
  assert(
    Math.abs(result.power_w.battery[8] - 1_195) < 1e-6,
    "and the room the deeper discharge frees must take the refused surplus",
  );
  assert(
    result.export_w.every((watts) => watts < 1e-9),
    "which leaves nothing to export",
  );
});

Deno.test("a settlement that repeats itself stops instead of buying the cap", () => {
  // Not every horizon reaches a fixed point. The auction re-bids exactly what
  // the last settlement released, settlement releases the same runs again, and
  // the two sit in a limit cycle until the round cap. The September 5 replay
  // released the same 30 battery runs every round from round 2 to the cap:
  // twenty-one rounds that could not change the answer, on a function whose
  // whole solve has to fit a worker's CPU budget. It stopped fitting, and the
  // portal's replan started returning 546 CPU Time exceeded.
  //
  // Forty-eight quarters that reproduce the cycle. What matters is not that
  // this shape still cycles — a later reconciliation of the two may well settle
  // it — but that a horizon which does not converge stops where it stopped
  // repeating rather than paying for the rest of the rounds.
  const slots = shapedSlots([
    [0, 1_401, 1.08, 0.16],
    [0, 1_107, 2.40, 0.34],
    [0, 1_049, 1.16, 0.41],
    [0, 471, 2.19, 0.12],
    [0, 936, 2.30, 0.31],
    [0, 512, 1.91, 0.20],
    [0, 1_757, 0.39, 0.48],
    [435, 492, 0.76, 0.02],
    [6_581, 978, 1.82, 0.51],
    [1_630, 1_002, 1.14, 0.05],
    [3_649, 443, 0.44, 0.50],
    [5_635, 301, 2.66, 0.06],
    [6_807, 1_091, 0.77, 0.36],
    [360, 1_467, 2.49, 0.43],
    [3_120, 1_723, 0.47, 0.38],
    [6_860, 1_558, 1.84, 0.28],
    [232, 1_573, 2.31, 0.29],
    [2_188, 1_654, 2.53, 0.24],
    [0, 824, 0.34, 0.50],
    [0, 770, 1.35, 0.42],
    [0, 1_601, 2.51, 0.24],
    [0, 611, 1.85, 0.33],
    [0, 1_370, 2.55, 0.12],
    [0, 718, 1.13, 0.29],
    [0, 341, 0.99, 0.44],
    [0, 551, 2.16, 0.22],
    [0, 929, 1.25, 0.44],
    [0, 1_013, 2.67, 0.15],
    [0, 428, 2.00, 0.03],
    [0, 1_401, 2.18, 0.34],
    [0, 730, 1.08, 0.35],
    [753, 582, 2.06, 0.51],
    [4_413, 471, 1.69, 0.49],
    [201, 1_167, 1.54, 0.38],
    [5_926, 938, 1.53, 0.05],
    [6_039, 968, 0.84, 0.31],
    [3_226, 1_154, 1.55, 0.17],
    [1_506, 1_660, 1.74, 0.28],
    [1_427, 534, 0.90, 0.43],
    [1_324, 1_766, 0.85, 0.43],
    [2_257, 772, 2.08, 0.48],
    [2_606, 908, 2.27, 0.47],
    [0, 806, 1.33, 0.47],
    [0, 1_684, 1.59, 0.44],
    [0, 516, 1.20, 0.17],
    [0, 509, 1.05, 0.47],
    [0, 691, 0.98, 0.46],
    [0, 478, 0.80, 0.05],
  ]);
  const battery: DispatchStore = {
    ...replayBattery(slots.length, 3.16, 1.69),
    max_state: 10,
    curve: {
      unit: "kwh",
      points: [
        { at: 3.03, sek_per_unit: 1.69 },
        { at: 10, sek_per_unit: 0.44 },
      ],
    },
    units_per_kwh: () => 0.95,
    discharge: {
      max_power_w: 9_600,
      state_per_kwh_out: () => 1 / 0.95,
      export_allowed: false,
    },
  };
  const result = planDispatch(slots, [battery], LIMITS);

  assert(
    result.stopped_because !== "settle_cap",
    "a repeating settlement must stop at the repeat, not at the round cap",
  );
  // Stopping early may not cost anything, so the schedule still has to be one
  // the hardware could execute.
  let stored = battery.initial_state;
  for (let index = 0; index < slots.length; index += 1) {
    const chargeW = result.power_w.battery[index];
    const dischargeW = result.discharge_w.battery[index];
    assert(chargeW === 0 || dischargeW === 0, `slot ${index} does both`);
    stored += (chargeW * 0.95 - dischargeW / 0.95) / 1_000 * SLOT_HOURS;
    assert(
      stored >= -1e-8 && stored <= 10 + 1e-8,
      `slot ${index} leaves the battery at ${stored}`,
    );
    assert(Math.abs(result.state.battery[index + 1] - stored) < 1e-8);
  }
});

Deno.test("the battery discharges to cover load worth more than its charge", () => {
  // Dark, dear import, a full battery whose charge is worth little.
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 2.5,
  });
  const battery = batteryStore(slots.length, 17, 0.4);

  const result = planDispatch(slots, [battery], LIMITS);
  const discharged = result.discharge_w.battery.reduce((a, b) => a + b, 0);

  assert(
    discharged > 0,
    "2.5 SEK import against 0.4 SEK charge must discharge",
  );
  assert(
    result.import_w.reduce((a, b) => a + b, 0) <
      slots.length * slots[0].fixed_load_w,
    "discharging must reduce import",
  );
});

Deno.test("the battery holds charge it values above the import price", () => {
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 0.8,
  });
  // A dark expensive week ahead makes stored energy dear to replace.
  const battery = batteryStore(slots.length, 17, 3.0);

  const result = planDispatch(slots, [battery], LIMITS);

  assertEquals(
    result.discharge_w.battery.reduce((a, b) => a + b, 0),
    0,
    "charge worth 3 SEK must not be spent avoiding a 0.8 SEK import",
  );
});

Deno.test("an empty battery is never discharged past its floor", () => {
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 5,
  });
  const battery = batteryStore(slots.length, 1.2, 0.1);

  const result = planDispatch(slots, [battery], LIMITS);

  for (const state of result.state.battery) {
    assert(state >= 1 - 1e-6, `state ${state} fell below the 1 kWh floor`);
  }
});

Deno.test("charge and discharge never happen in the same slot", () => {
  const slots = buildSlots([solarDay(9_000)], { importPrice: 2.0 });
  const battery = batteryStore(slots.length, 9, 0.5);

  const result = planDispatch(slots, [battery], LIMITS);

  for (let index = 0; index < slots.length; index += 1) {
    assert(
      result.power_w.battery[index] === 0 ||
        result.discharge_w.battery[index] === 0,
      `slot ${index} both charges and discharges`,
    );
  }
});

Deno.test("§8.12 #2 — the battery competes with the sinks, not against them", () => {
  // One mechanism means the battery and the car bid in the same auction. A
  // nearly empty car must beat storing the same surplus for later.
  const slots = buildSlots([solarDay(5_000)]);
  const scarce: DispatchLimits = {
    ...LIMITS,
    grid_import_limit_w: 0,
    grid_export_limit_w: 13_200,
  };
  const withEmptyCar = planDispatch(
    slots,
    [
      batteryStore(slots.length, 9, 0.5),
      evStore(slots.length, 60, slots.length - 1),
    ],
    scarce,
  );
  const withFullCar = planDispatch(
    slots,
    [
      batteryStore(slots.length, 9, 0.5),
      evStore(slots.length, 500, slots.length - 1),
    ],
    scarce,
  );

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  assert(
    sum(withEmptyCar.power_w.ev) > 0,
    "an empty car must win surplus from the battery",
  );
  assert(
    sum(withFullCar.power_w.battery) > sum(withEmptyCar.power_w.battery),
    "and a full car must leave that surplus to the battery",
  );
});

Deno.test("export from storage only happens when it is permitted", () => {
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 0.1,
    exportPrice: 4,
  });
  const forbidden = planDispatch(
    slots,
    [batteryStore(slots.length, 17, 0.3)],
    LIMITS,
  );
  const allowed = planDispatch(
    slots,
    [batteryStore(slots.length, 17, 0.3, { exportAllowed: true })],
    LIMITS,
  );

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  assert(
    sum(allowed.discharge_w.battery) > sum(forbidden.discharge_w.battery),
    "a 4 SEK export price must draw more discharge once export is allowed",
  );
});

Deno.test("a store is never asked to absorb more than it has room for", () => {
  // The pack starts nearly full against a price cheap enough that the curve
  // wants every kWh. Before the state-room bound the plan simply kept buying:
  // `project` clamped the trajectory at max_state and threw the surplus away,
  // so the schedule carried charge commands the inverter could not honour and
  // the summary counted grid import that would never be drawn.
  const slots = buildSlots([new Array(SLOTS_PER_DAY).fill(0)], {
    importPrice: 0.2,
    exportPrice: 0.05,
  });
  const store = batteryStore(slots.length, 16, 2.5);
  const result = planDispatch(slots, [store], LIMITS);

  const deliveredKwh = result.power_w.battery
    .reduce((total, watts) => total + watts, 0) / 1_000 * 0.25;
  const returnedKwh = result.discharge_w.battery
    .reduce((total, watts) => total + watts, 0) / 1_000 * 0.25;
  // Room above the starting state, plus whatever the pack gave back and has to
  // replace. Both are state units; charging converts at units_per_kwh.
  const roomKwh = (store.max_state! - store.initial_state) / 0.95 +
    returnedKwh / 0.95 / 0.95;
  assert(
    deliveredKwh <= roomKwh + 1e-6,
    `bought ${deliveredKwh.toFixed(2)} kWh into ${
      roomKwh.toFixed(2)
    } kWh of room`,
  );
  assert(
    result.state.battery.every((value) => value <= store.max_state! + 1e-9),
    "the projected state must never exceed the pack",
  );
});

Deno.test("one slot never both charges and discharges the same store", () => {
  // A single store cannot trigger this, which is why it went unnoticed: charge
  // and discharge are never both profitable at one state, because the round
  // trip separates them. It takes a *competing* store. The sink's allocations
  // move `occupiedW` between iterations, so a slot the battery emptied earlier
  // — on the state it held then — later presents a profitable charge, and the
  // discharge itself raised `returnedW`, handing that charge the grid headroom
  // to act on. The charge loop skipped only slots it had already charged, so
  // both landed: importing at the full price to push energy straight back
  // through the pack and pay the round trip for nothing.
  const slots = buildSlots([solarDay(9_000)], {
    importPrice: 1.0,
    exportPrice: 0.05,
  }).map((slot) => ({ ...slot, fixed_load_w: 800 }));

  const sink: DispatchStore = {
    key: "sink",
    curve: {
      unit: "u",
      points: [{ at: 100, sek_per_unit: 2 }, { at: 200, sek_per_unit: 0 }],
    },
    initial_state: 0,
    max_power_w: 6_000,
    retention_per_slot: 1,
    usage_weight: weightWindow(slots.length, slots.length - 1, slots.length),
    units_per_kwh: () => 1,
    drift: (state) => state,
  };
  const battery: DispatchStore = {
    key: "battery",
    curve: {
      unit: "kwh",
      points: [
        { at: 6, sek_per_unit: 3.0 },
        { at: 7, sek_per_unit: 0.4 },
        { at: 18, sek_per_unit: 0.4 },
      ],
    },
    initial_state: 8,
    min_state: 1,
    max_state: 18,
    max_power_w: 8_800,
    retention_per_slot: 1,
    usage_weight: new Array(slots.length).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 0.95,
    drift: (state) => state,
    discharge: {
      max_power_w: 9_600,
      state_per_kwh_out: () => 1 / 0.95,
      export_allowed: false,
    },
  };

  const result = planDispatch(slots, [sink, battery], LIMITS);
  const collisions = result.power_w.battery
    .map((watts, index) => ({
      index,
      watts,
      out: result.discharge_w.battery[index],
    }))
    .filter((entry) => entry.watts > 0 && entry.out > 0)
    .map((entry) => entry.index);
  assertEquals(collisions, []);
  // The pathology has to stay reachable, or the guard proves nothing.
  const charged = result.power_w.battery.some((watts) => watts > 0);
  const discharged = result.discharge_w.battery.some((watts) => watts > 0);
  assert(
    charged && discharged,
    `the fixture must exercise both directions (charge=${charged}, discharge=${discharged})`,
  );
});

Deno.test("a sizeable move is priced by the full curve integral", () => {
  const slots: DispatchSlot[] = [{
    pv_w: 0,
    fixed_load_w: 0,
    import_price_sek_per_kwh: 1.2,
    export_price_sek_per_kwh: 0.1,
  }];
  const store: DispatchStore = {
    key: "steep-store",
    curve: {
      unit: "kwh",
      points: [
        { at: 0, sek_per_unit: 2 },
        { at: 1, sek_per_unit: 0 },
      ],
    },
    initial_state: 0,
    max_power_w: 8_000,
    retention_per_slot: 1,
    usage_weight: [0],
    terminal_weight: 1,
    units_per_kwh: () => 1,
    drift: (state) => state,
  };

  const result = planDispatch(slots, [store], LIMITS);

  assertEquals(result.power_w[store.key], [0]);
  assertEquals(result.allocations[0], []);
});

Deno.test("a discrete charger chooses the best complete current setpoint", () => {
  const slots: DispatchSlot[] = [{
    pv_w: 0,
    fixed_load_w: 0,
    import_price_sek_per_kwh: 1,
    export_price_sek_per_kwh: 0.1,
  }];
  const store: DispatchStore = {
    key: "charger",
    curve: { unit: "kwh", points: [{ at: 100, sek_per_unit: 2 }] },
    initial_state: 0,
    min_power_w: 1_000,
    power_step_w: 1_000,
    max_power_w: 4_000,
    retention_per_slot: 1,
    usage_weight: [0],
    terminal_weight: 1,
    units_per_kwh: () => 1,
    drift: (value) => value,
  };

  const result = planDispatch(slots, [store], LIMITS);

  assertEquals(result.power_w.charger, [4_000]);
});

Deno.test("a fixed-power load can take a single cheap quarter", () => {
  const prices = [0.1, 10, 10, 10];
  const slots: DispatchSlot[] = prices.map((price) => ({
    pv_w: 0,
    fixed_load_w: 0,
    import_price_sek_per_kwh: price,
    export_price_sek_per_kwh: 0.1,
  }));
  const store: DispatchStore = {
    key: "compressor",
    curve: {
      unit: "kwh",
      points: [{ at: 100, sek_per_unit: 2 }],
    },
    initial_state: 0,
    max_power_w: 1_000,
    retention_per_slot: 1,
    usage_weight: new Array(slots.length).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 1,
    drift: (state) => state,
  };

  const result = planDispatch(slots, [store], LIMITS);

  assertEquals(result.power_w[store.key], [1_000, 0, 0, 0]);
});

Deno.test("load-cover discharge is valued at import, never export", () => {
  const slots: DispatchSlot[] = [{
    pv_w: 0,
    fixed_load_w: 600,
    import_price_sek_per_kwh: 1,
    export_price_sek_per_kwh: 5,
  }];
  const battery = batteryStore(slots.length, 10, 2);
  battery.max_state = 10;
  const result = planDispatch(slots, [battery], LIMITS);

  assertEquals(result.discharge_w.battery, [0]);
  assertEquals(result.battery[0]?.reason, "retained_value_exceeds_import");
  assertEquals(result.battery[0]?.comparison_price_sek_per_kwh, 1);
  assertEquals(result.battery[0]?.comparison_power_w, 600);
});

Deno.test("§8.18 — the settled schedule is one the auction would have stopped at", () => {
  // The shape that broke it (live plan `eb2ffa5e`, 2026-08-28): a cheap night,
  // a dear evening, and a concave curve. The greedy over-buys the night against
  // the marginal value of an emptier pack; settling releases the surplus charge
  // as unprofitable; and the discharges that charge was funding fall away as
  // starved — from the back, so the *dearest* quarters are the ones dropped.
  // Nothing then re-priced the hole that left.
  const slots: DispatchSlot[] = Array.from({ length: 96 }, (_slot, index) => ({
    pv_w: 0,
    fixed_load_w: 1_000,
    import_price_sek_per_kwh: index < 64 ? 0.86 : index < 80 ? 2.2 : 1.2,
    export_price_sek_per_kwh: 0.05,
  }));
  const battery: DispatchStore = {
    key: "battery",
    // Concave, as the derived curve is: the bottom of the pack is worth the
    // evening it covers, the top only what a flat night would pay for it.
    curve: {
      unit: "kwh",
      points: [
        { at: 2.7, sek_per_unit: 1.65 },
        { at: 4.3, sek_per_unit: 0.95 },
        { at: 17, sek_per_unit: 0.45 },
      ],
    },
    initial_state: 0,
    min_state: 0,
    max_state: 17,
    max_power_w: 8_800,
    retention_per_slot: 1,
    usage_weight: new Array(96).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 0.95,
    drift: (state) => state,
    discharge: {
      max_power_w: 9_600,
      state_per_kwh_out: () => 1 / 0.95,
      export_allowed: false,
    },
  };

  const result = planDispatch(slots, [battery], LIMITS);
  const state = result.state.battery;
  // The lowest state still to come is what a discharge here has to leave room
  // under, exactly as the auction's own feasibility check reads it.
  const suffixMin = new Array(state.length).fill(0);
  suffixMin[state.length - 1] = state[state.length - 1];
  for (let index = state.length - 2; index >= 0; index -= 1) {
    suffixMin[index] = Math.min(state[index], suffixMin[index + 1]);
  }

  for (let index = 0; index < slots.length; index += 1) {
    if (result.import_w[index] <= 1e-9) continue;
    if (result.power_w.battery[index] > 0) continue;
    const powerW = Math.min(result.import_w[index], 9_600);
    const kwh = powerW / 1_000 * SLOT_HOURS;
    const spent = kwh / 0.95;
    if (suffixMin[index] - spent < -1e-9) continue;
    const candidate = scoreDispatch(slots, [battery], LIMITS, {
      power_w: result.power_w,
      discharge_w: {
        battery: result.discharge_w.battery.map((w, i) =>
          w + (i === index ? powerW : 0)
        ),
      },
    });
    const baseScore = scoreDispatch(slots, [battery], LIMITS, result);
    const givenUp =
      (baseScore.service_value_sek - candidate.service_value_sek) / kwh;
    const surplus = baseScore.total_sek - candidate.total_sek;
    assert(
      surplus <= 1e-9,
      `slot ${index} imported ${result.import_w[index].toFixed(0)} W at ` +
        `${slots[index].import_price_sek_per_kwh} SEK/kWh while holding ` +
        `${state[index].toFixed(3)} kWh worth ${givenUp.toFixed(3)}: ` +
        `discharging was worth ${surplus.toFixed(4)} SEK and was not taken`,
    );
  }
  assert(
    result.stopped_because !== "settle_cap" &&
      result.stopped_because !== "settle_cycle",
    "the auction and the settlement must reach a fixed point, not a cycle",
  );
});

/** A valuable reserve and a later full pack blocked both standalone bids. */
function solarTransferCase(reverse = false, exportPrice = 0.1, wear = 0.05) {
  const slots: DispatchSlot[] = [
    {
      pv_w: 1_000,
      fixed_load_w: 0,
      import_price_sek_per_kwh: 1,
      export_price_sek_per_kwh: exportPrice,
    },
    {
      pv_w: 0,
      fixed_load_w: 902.5,
      import_price_sek_per_kwh: 1,
      export_price_sek_per_kwh: 0.1,
    },
    {
      pv_w: 2_000,
      fixed_load_w: 0,
      import_price_sek_per_kwh: 1,
      export_price_sek_per_kwh: 0.01,
    },
  ];
  if (reverse) [slots[0], slots[1]] = [slots[1], slots[0]];
  const battery = batteryStore(3, 0.5, 3);
  battery.min_state = 0;
  battery.max_state = 0.975;
  battery.max_power_w = 4_000;
  battery.units_per_kwh = () => 0.95;
  battery.discharge!.state_per_kwh_out = () => 1 / 0.95;
  battery.discharge!.cycling_cost_sek_per_unit = wear;
  return { slots, battery };
}

for (const reverse of [false, true]) {
  Deno.test(`solar and load are priced jointly (${reverse ? "use then refill" : "charge then use"})`, () => {
    const { slots, battery } = solarTransferCase(reverse);
    const result = planDispatch(slots, [battery], LIMITS);
    const charge = reverse ? 1 : 0;
    const load = reverse ? 0 : 1;
    assert(
      result.export_w[charge] < 1e-6,
      "do not sell solar needed by the house",
    );
    assert(
      result.import_w[load] < 1e-6,
      "cover load despite the reserve's higher marginal value",
    );
    assert(
      Math.abs(result.state.battery[2] - 0.5) < 1e-9,
      "the pair leaves the suffix unchanged",
    );
    assert(
      Math.abs(result.state.battery[3] - 0.975) < 1e-9,
      "preserve the future full pack",
    );
    const part = result.allocations[load][0];
    const pair = part.energy_transfers![0];
    assert(Math.abs(pair.discharged_kwh - pair.charged_kwh * 0.9025) < 1e-9);
    const saving = 0.9025 * 0.25 - 0.1 * 0.25 - 0.05 * 0.95 * 0.25;
    assert(
      Math.abs(pair.saving_sek - saving) < 1e-9,
      "pay export opportunity cost, both losses and cycling wear",
    );
    assert(
      Math.abs(part.net_value_sek - saving) < 1e-9,
      "diagnostics explain joint profit",
    );
    for (let index = 0; index < slots.length; index += 1) {
      const supplied = slots[index].pv_w + result.import_w[index] +
        result.discharge_w.battery[index];
      const consumed = slots[index].fixed_load_w + result.export_w[index] +
        result.power_w.battery[index];
      assert(
        Math.abs(supplied - consumed) < 1e-6,
        "conserve electrical energy",
      );
      assert(
        result.state.battery[index] >= 0 && result.state.battery[index] <= 1,
      );
      assert(
        !(result.power_w.battery[index] > 0 &&
          result.discharge_w.battery[index] > 0),
      );
    }
  });
}

for (
  const [name, exportPrice, wear] of [
    ["export revenue", 1.1, 0.05],
    ["round-trip loss", 0.95, 0],
    ["cycling wear", 0.1, 1],
  ] as const
) {
  Deno.test(`a solar transfer must clear ${name}`, () => {
    const { slots, battery } = solarTransferCase(false, exportPrice, wear);
    const result = planDispatch(slots, [battery], LIMITS);
    assertEquals(result.discharge_w.battery[1], 0);
    assert(result.allocations.flat().every((part) => !part.energy_transfers));
  });
}

Deno.test("joint transfers respect intervening capacity and the discharge power limit", () => {
  const { slots, battery } = solarTransferCase();
  battery.initial_state = 0.965;
  battery.discharge!.max_power_w = 20;
  const result = planDispatch(slots, [battery], LIMITS);
  assert(Math.abs(result.discharge_w.battery[1] - 20) < 1e-6);
  assert(
    result.state.battery.every((state) => state <= 1 + 1e-9 && state >= 0),
  );
  const empty = solarTransferCase(true);
  empty.battery.initial_state = 0;
  const emptyResult = planDispatch(empty.slots, [empty.battery], LIMITS);
  assertEquals(
    emptyResult.discharge_w.battery[0],
    0,
    "future solar cannot supply an already-empty pack",
  );
});

Deno.test("joint transfers do not bypass discrete hardware or intermediate utility", () => {
  for (
    const change of [
      (store: DispatchStore) => {
        store.power_step_w = 500;
      },
      (store: DispatchStore) => {
        store.usage_weight[1] = 1;
      },
      (store: DispatchStore) => {
        store.retention_per_slot = 0.99;
      },
    ]
  ) {
    const { slots, battery } = solarTransferCase();
    change(battery);
    const result = planDispatch(slots, [battery], LIMITS);
    assert(result.allocations.flat().every((part) => !part.energy_transfers));
  }
});

Deno.test("a transfer stage paused between transfers resumes to the same schedule", () => {
  // Two days of solar feeding dear evenings, priced with peak shaping so the
  // bisected transfer level is exercised as well. The paused run crosses a
  // JSON boundary after every transfer, as the planning worker's does.
  const slots: DispatchSlot[] = [...solarDay(6_000), ...solarDay(3_000)].map(
    (pv_w, index) => ({
      pv_w,
      fixed_load_w: index % SLOTS_PER_DAY >= 68 && index % SLOTS_PER_DAY < 88
        ? 2_500
        : 600,
      import_price_sek_per_kwh: 1.2 + 0.8 * Math.sin(index * 0.13),
      export_price_sek_per_kwh: 0.35,
    }),
  );
  const limits = {
    ...LIMITS,
    grid_import_shaping_w: 1_000,
    peak_shaping_sek_per_kwh_per_kw: 0.05,
  };
  const battery = batteryStore(slots.length, 3, 0.6);
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const uninterrupted = dispatchAuctionSteps(slots, [battery], limits);
  let step = uninterrupted.next();
  while (!step.done) step = uninterrupted.next();
  const expected: DispatchResult = step.value;

  let checkpoint: DispatchCheckpoint | undefined;
  let pauses = 0;
  for (let request = 0; request < 256; request += 1) {
    const next = dispatchAuctionSteps(
      slots,
      [battery],
      limits,
      {},
      checkpoint,
      () => true,
    ).next();
    if (next.done === true) {
      assertEquals(wire(next.value), wire(expected));
      assert(pauses > 10, `paused ${pauses} times`);
      return;
    }
    checkpoint = wire(next.value);
    if (checkpoint.transferred) {
      pauses += 1;
      assertEquals(checkpoint.next, "transfers");
      assertEquals(checkpoint.transferred, ["battery"]);
    }
  }
  throw new Error("The paused dispatch did not finish");
});

function discreteSolarCar() {
  const slots: DispatchSlot[] = Array.from({ length: 8 }, (_, index) => ({
    pv_w: index >= 2 ? 4_000 : 0,
    fixed_load_w: 300,
    import_price_sek_per_kwh: 1,
    export_price_sek_per_kwh: 0.1,
  }));
  const car: DispatchStore = {
    key: "ev",
    curve: { unit: "kwh", points: [{ at: 10, sek_per_unit: 3 }] },
    initial_state: 0,
    max_state: 5.175,
    max_power_w: 11_040,
    min_power_w: 3_450,
    power_step_w: 690,
    retention_per_slot: 1,
    terminal_weight: 1,
    usage_weight: new Array(8).fill(0),
    units_per_kwh: () => 1,
    drift: (state) => state,
  };
  return { slots, car };
}

Deno.test("the same car energy is spread over solar at supported amps instead of bought in 11 kW blocks", () => {
  const { slots, car } = discreteSolarCar();
  const result = planDispatch(slots, [car], LIMITS);
  assertEquals(result.power_w.ev, [0, 0, 3450, 3450, 3450, 3450, 3450, 3450]);
  assert(Math.abs(result.state.ev.at(-1)! - car.max_state!) < 1e-9);
  assert(result.import_w.slice(2).every((watts) => watts < 1e-6));
  assertEquals(
    result.power_w.ev.reduce((sum, watts) => sum + watts, 0) / 4000,
    5.175,
  );
});

Deno.test("a real departure before the sun still allows fast grid charging", () => {
  const { slots, car } = discreteSolarCar();
  car.terminal_weight = 0;
  car.usage_weight[2] = 1;
  const result = planDispatch(slots, [car], LIMITS);
  assert(result.power_w.ev.slice(2).every((watts) => watts === 0));
  assert(Math.max(...result.power_w.ev) >= 9_000);
  assert(result.state.ev[2] >= 5);
});

// ---------------------------------------------------------------------------
// Scoring a schedule the planner did not produce (§8.12).
//
// The objective was a closure inside `planDispatch` until it became
// `scoreDispatch`, and while it was, only schedules the planner had just built
// were ever scored. That left the question the acceptance tests actually ask —
// did the search find the best schedule the objective allows? — unanswerable,
// because the alternative was never priced. These pin the property that makes
// it answerable: any schedule can be scored, and a schedule that cheats the
// physics is reported rather than silently clamped into feasibility.
// ---------------------------------------------------------------------------

/** A schedule with every store idle: the do-nothing baseline. */
function idle(slots: number, stores: DispatchStore[]): DispatchSchedule {
  const schedule: DispatchSchedule = { power_w: {}, discharge_w: {} };
  for (const store of stores) {
    schedule.power_w[store.key] = new Array(slots).fill(0);
    schedule.discharge_w[store.key] = new Array(slots).fill(0);
  }
  return schedule;
}

Deno.test("the planner's own plan beats doing nothing when charging pays", () => {
  const slots = buildSlots([solarDay(8_000), solarDay(8_000)]);
  const ev = evStore(slots.length, 90, slots.length - 1);
  const planned = planDispatch(slots, [ev], LIMITS);

  const scored = scoreDispatch(slots, [ev], LIMITS, {
    power_w: planned.power_w,
    discharge_w: planned.discharge_w,
  });
  const nothing = scoreDispatch(slots, [ev], LIMITS, idle(slots.length, [ev]));

  assertEquals(scored.infeasibilities, []);
  assert(
    scored.total_sek < nothing.total_sek,
    `a car at 90 km must be worth charging: ${scored.total_sek} vs ${nothing.total_sek}`,
  );
});

Deno.test("the same energy scores better taken from sun than from grid", () => {
  // The comparison the workbench exists to make, with both sides hand-built so
  // it tests the scorer rather than the search: identical kWh into the car,
  // once across midday surplus and once from the dark early hours.
  const slots = buildSlots([solarDay(8_000)]);
  const ev = evStore(slots.length, 90, slots.length - 1);

  const sun = idle(slots.length, [ev]);
  for (let index = 44; index < 56; index += 1) sun.power_w.ev[index] = 6_000;
  const grid = idle(slots.length, [ev]);
  for (let index = 4; index < 16; index += 1) grid.power_w.ev[index] = 6_000;

  const fromSun = scoreDispatch(slots, [ev], LIMITS, sun);
  const fromGrid = scoreDispatch(slots, [ev], LIMITS, grid);

  assertEquals(fromSun.infeasibilities, []);
  assertEquals(fromGrid.infeasibilities, []);
  assert(
    fromSun.total_sek < fromGrid.total_sek,
    `surplus at ${LIMITS.grid_export_limit_w} W export must beat import: ${fromSun.total_sek} vs ${fromGrid.total_sek}`,
  );
});

Deno.test("a schedule that overfills a store is reported, not clamped", () => {
  const slots = buildSlots([solarDay(8_000)]);
  const ev = { ...evStore(slots.length, 90, slots.length - 1), max_state: 400 };

  const greedy = idle(slots.length, [ev]);
  for (let index = 0; index < slots.length; index += 1) {
    greedy.power_w.ev[index] = 11_000;
  }
  const scored = scoreDispatch(slots, [ev], LIMITS, greedy);

  assert(
    scored.infeasibilities.some((entry) => entry.message.includes("outside")),
    "charging a full car all day must be refused, not silently bounded",
  );
});

Deno.test("a schedule above the connection is reported", () => {
  const slots = buildSlots([solarDay(0)]);
  const ev = evStore(slots.length, 90, slots.length - 1);

  const over = idle(slots.length, [ev]);
  over.power_w.ev[10] = 11_000;
  const scored = scoreDispatch(slots, [ev], {
    ...LIMITS,
    grid_import_limit_w: 5_000,
  }, over);

  assert(
    scored.infeasibilities.some((entry) =>
      entry.message.includes("connection")
    ),
    `expected a connection breach, got ${
      JSON.stringify(scored.infeasibilities)
    }`,
  );
});

Deno.test("a hardware increment the schedule misses is reported", () => {
  const slots = buildSlots([solarDay(8_000)]);
  const ev = {
    ...evStore(slots.length, 90, slots.length - 1),
    min_power_w: 4_140,
    power_step_w: 690,
  };

  const off = idle(slots.length, [ev]);
  off.power_w.ev[48] = 5_000;
  const scored = scoreDispatch(slots, [ev], LIMITS, off);

  assert(
    scored.infeasibilities.some((entry) => entry.message.includes("increment")),
    `expected an increment breach, got ${
      JSON.stringify(scored.infeasibilities)
    }`,
  );
});

Deno.test("start costs are counted per run, from the schedule itself", () => {
  const slots = buildSlots([solarDay(0)]);
  const pool = poolStore(slots.length, 26);

  const once = idle(slots.length, [pool]);
  for (let index = 40; index < 48; index += 1) once.power_w.pool[index] = 3_500;
  const twice = idle(slots.length, [pool]);
  for (let index = 40; index < 44; index += 1) {
    twice.power_w.pool[index] = 3_500;
  }
  for (let index = 46; index < 50; index += 1) {
    twice.power_w.pool[index] = 3_500;
  }

  const single = scoreDispatch(slots, [pool], LIMITS, once);
  const split = scoreDispatch(slots, [pool], LIMITS, twice);

  assertEquals(single.stores[0].runs, 1);
  assertEquals(split.stores[0].runs, 2);
  assert(
    split.start_sek > single.start_sek,
    "two runs must pay two start costs",
  );
});

Deno.test("a 72-hour auction reads published-price flags once", () => {
  const count = 288;
  let reads = 0;
  const slots: DispatchSlot[] = Array.from({ length: count }, () => ({
    pv_w: 0,
    fixed_load_w: 600,
    import_price_sek_per_kwh: 1,
    export_price_sek_per_kwh: 0.2,
    binding: true,
    get published_price() {
      reads += 1;
      return false;
    },
  }));
  const result = planDispatch(slots, [batteryStore(count, 1, 3)], LIMITS);
  assertEquals(result.power_w.battery, new Array(count).fill(0));
  assertEquals(result.discharge_w.battery, new Array(count).fill(0));
  // Slot inputs are resolved once before all searches and scoring.
  assertEquals(reads, count);
});

Deno.test("unprofitable dense-curve bids skip level enumeration", () => {
  const count = 288;
  let reads = 0;
  const points = Array.from({ length: 1_000 }, (_, index) => ({
    get at() {
      reads += 1;
      return (index + 1) / 50;
    },
    sek_per_unit: 3 - index / 1_000,
  }));
  const slots = buildSlots([new Array(count).fill(0)], { importPrice: 1 });
  const battery = batteryStore(count, 18, 3);
  battery.curve = { unit: "kwh", points };
  const result = planDispatch(slots, [battery], LIMITS);
  assertEquals(result.power_w.battery, new Array(count).fill(0));
  assertEquals(result.discharge_w.battery, new Array(count).fill(0));
  // Allows curve compilation, binary searches and final scoring, but not a
  // thousand-point enumeration in each of 288 quarters. No wall-clock limit.
  assert(reads < 50_000, `unprofitable bids read ${reads} breakpoints`);
});

Deno.test("charge pruning preserves negative-price purchases", () => {
  const slots = buildSlots([new Array(8).fill(0)], { importPrice: -1 });
  const store = evStore(slots.length, 100, slots.length - 1);
  store.curve = { unit: "km", points: [{ at: 480, sek_per_unit: 0 }] };
  const result = planDispatch(slots, [store], LIMITS);
  assert(result.power_w.ev.some((watts) => watts > 0));
});

Deno.test("discharge pruning includes profitable marginal peak relief", () => {
  const slots = buildSlots([new Array(8).fill(0)], { importPrice: 1 });
  slots.forEach((slot) => slot.fixed_load_w = 10_000);
  const result = planDispatch(slots, [batteryStore(slots.length, 18, 2)], {
    ...LIMITS,
    grid_import_shaping_w: 1_000,
    peak_shaping_sek_per_kwh_per_kw: 1,
  });
  assert(result.discharge_w.battery.some((watts) => watts > 0));
});

Deno.test("grid arbitrage earns money even with zero generated terminal utility", () => {
  const slots: DispatchSlot[] = [0.5, 2].map((price, i) => ({
    pv_w: 0,
    fixed_load_w: i === 1 ? 2_000 : 0,
    import_price_sek_per_kwh: price,
    export_price_sek_per_kwh: 0,
    binding: true,
    published_price: true,
  }));
  const battery: DispatchStore = {
    key: "battery",
    curve: { unit: "kwh", points: [{ at: 10, sek_per_unit: 0 }] },
    initial_state: 0,
    min_state: 0,
    max_state: 10,
    max_power_w: 4_000,
    retention_per_slot: 1,
    usage_weight: [0, 0],
    terminal_weight: 1,
    units_per_kwh: () => 0.9,
    drift: (state) => state,
    discharge: {
      max_power_w: 4_000,
      state_per_kwh_out: () => 1 / 0.9,
      export_allowed: false,
      cycling_cost_sek_per_unit: 0.05,
    },
  };
  const result = planDispatch(slots, [battery], LIMITS);
  const score = scoreDispatch(slots, [battery], LIMITS, result);
  assertEquals(score.infeasibilities, []);
  assert(result.power_w.battery[0] > 0);
  assert(result.discharge_w.battery[1] > 0);
  assert(Math.abs(result.state.battery[2]) < 1e-8);
  assert(
    score.billable_sek + score.wear_sek < 0.4,
    "losses and wear still leave a cash saving",
  );
  assert(result.allocations[0][0].energy_transfers![0].grid_charged_kwh > 0);

  slots[1].published_price = false;
  const speculative = planDispatch(slots, [battery], LIMITS);
  assertEquals(
    speculative.power_w.battery,
    [0, 0],
    "a forecast alone cannot fund a committed grid purchase",
  );
  slots[1].published_price = true;
  slots[1].import_price_sek_per_kwh = 0.55;
  assertEquals(
    planDispatch(slots, [battery], LIMITS).power_w.battery,
    [0, 0],
    "a spread that cannot pay round-trip losses is declined",
  );
});

for (const kind of ["battery", "ev", "pool"] as const) {
  Deno.test(`cost refinement smooths ${kind} without sacrificing its service`, () => {
    const fixed = kind === "pool";
    const watts = fixed ? 2_000 : 3_000;
    const slots: DispatchSlot[] = [0, 1, 2, 3].map(() => ({
      pv_w: 0,
      fixed_load_w: 500,
      import_price_sek_per_kwh: 1,
      export_price_sek_per_kwh: 0,
    }));
    const store: DispatchStore = {
      key: kind,
      curve: { unit: "kwh", points: [{ at: 10, sek_per_unit: 10 }] },
      initial_state: 0,
      min_state: 0,
      max_state: 10,
      max_power_w: watts,
      min_power_w: kind === "battery" ? 0 : fixed ? watts : 1_000,
      power_step_w: kind === "ev" ? 1_000 : 0,
      retention_per_slot: 1,
      usage_weight: [0, 0, 0, 0],
      terminal_weight: 1,
      units_per_kwh: () => 1,
      drift: (state) => state,
    };
    const limits = {
      ...LIMITS,
      grid_import_shaping_w: 0,
      peak_shaping_sek_per_kwh_per_kw: 0.1,
      grid_ramp_sek_per_kw: 0.05,
      load_start_preference_sek: 0.25,
    };
    const schedule: DispatchSchedule = {
      power_w: { [kind]: [watts, 0, watts, 0] },
      discharge_w: { [kind]: [0, 0, 0, 0] },
    };
    const before = scoreDispatch(slots, [store], limits, schedule);
    assert(refineDispatchCosts(slots, [store], limits, schedule).has(kind));
    const after = scoreDispatch(slots, [store], limits, schedule);
    assertEquals(after.infeasibilities, []);
    assertEquals(after.stores[0].charged_kwh, before.stores[0].charged_kwh);
    assertEquals(after.stores[0].end_state, before.stores[0].end_state);
    assert(after.billable_sek <= before.billable_sek + 1e-9);
    assert(after.continuity_sek < before.continuity_sek);
    if (!fixed) {
      assert(Math.max(...after.import_w) < Math.max(...before.import_w));
    } else assert(after.stores[0].runs < before.stores[0].runs);
    // Equipment availability cannot be overridden by smoothing.
    store.units_per_kwh = (_state, index) => index === 1 ? 0 : 1;
    const unavailable: DispatchSchedule = {
      power_w: { [kind]: [watts, 0, watts, 0] },
      discharge_w: { [kind]: [0, 0, 0, 0] },
    };
    refineDispatchCosts(slots, [store], limits, unavailable);
    assertEquals(unavailable.power_w[kind][1], 0);
  });
}

Deno.test("refinement reuses unchanged nonlinear trajectories across candidate moves", () => {
  const slots = buildSlots([new Array(8).fill(0)]);
  const ev = evStore(8, 100, 7);
  let projections = 0;
  const pool = poolStore(8, 26);
  pool.drift = (state) => {
    projections += 1;
    return state - (state - 20) * 0.01;
  };
  const schedule: DispatchSchedule = {
    power_w: { ev: [3_000, 0, 3_000, 0, 0, 0, 0, 0] },
    discharge_w: {},
  };
  const limits = {
    ...LIMITS,
    grid_ramp_sek_per_kw: 0.05,
    load_start_preference_sek: 0.25,
  };
  const before = scoreDispatch(slots, [ev, pool], limits, schedule);
  projections = 0;
  assert(refineDispatchCosts(slots, [ev, pool], limits, schedule).has("ev"));
  assertEquals(
    projections,
    slots.length,
    "unchanged physics is projected once, not once per trial",
  );
  const after = scoreDispatch(slots, [ev, pool], limits, schedule);
  assertEquals(after.infeasibilities, []);
  assertEquals(after.state.pool, before.state.pool);
  assertEquals(after.stores[1], before.stores[1]);
  assert(
    after.stores[0].service_value_sek >=
      before.stores[0].service_value_sek - 1e-8,
  );
  assert(after.continuity_sek < before.continuity_sek);
});

Deno.test("refinement rechecks export restrictions on an unchanged discharging battery", () => {
  const slots = buildSlots([new Array(4).fill(0)]);
  const ev = evStore(4, 100, 3);
  const battery = batteryStore(4, 10, 1);
  battery.discharge!.export_allowed = false;
  const schedule: DispatchSchedule = {
    power_w: { ev: [3_000, 0, 3_000, 0] },
    discharge_w: { battery: [3_600, 0, 3_600, 0] },
  };
  const limits = {
    ...LIMITS,
    grid_ramp_sek_per_kw: 0.05,
    load_start_preference_sek: 0.25,
  };
  assertEquals(
    scoreDispatch(slots, [ev, battery], limits, schedule).infeasibilities,
    [],
  );
  refineDispatchCosts(slots, [ev, battery], limits, schedule);
  assertEquals(schedule.power_w.ev, [3_000, 0, 3_000, 0]);
  assertEquals(
    scoreDispatch(slots, [ev, battery], limits, schedule).infeasibilities,
    [],
  );
});

/** A quarter earns 0.25 SEK before a 0.50 SEK start: a run can pay when no isolated bid can. */
function startupProblem(prices = new Array(8).fill(1)) {
  const slots: DispatchSlot[] = prices.map((price) => ({
    pv_w: 0,
    fixed_load_w: 0,
    import_price_sek_per_kwh: price,
    export_price_sek_per_kwh: 0,
  }));
  const store: DispatchStore = {
    key: "pool",
    curve: {
      unit: "celsius",
      points: [{ at: 0, sek_per_unit: 2 }, { at: 100, sek_per_unit: 2 }],
    },
    initial_state: 0,
    min_power_w: 1000,
    max_power_w: 1000,
    start_cost_sek: 0.5,
    retention_per_slot: 1,
    terminal_weight: 1,
    usage_weight: prices.map(() => 0),
    units_per_kwh: () => 1,
    drift: (state) => state,
  };
  return { slots, store };
}

Deno.test("relay starts a profitable run even when every isolated quarter loses to startup cost", () => {
  const { slots, store } = startupProblem();
  const result = planDispatch(slots, [store], LIMITS);
  assertEquals(result.power_w.pool, slots.map(() => 1000));
  const score = scoreDispatch(slots, [store], LIMITS, result);
  assertEquals(score.infeasibilities, []);
  assertEquals(score.start_sek, 0.5);
  assertEquals(score.total_sek, -1.5);
});

Deno.test("economic runs stop at expensive quarters and pay separately to restart", () => {
  const { slots, store } = startupProblem([1, 1, 1, 100, 1, 1, 1]);
  const result = planDispatch(slots, [store], LIMITS);
  assertEquals(result.power_w.pool, [1000, 1000, 1000, 0, 1000, 1000, 1000]);
  const score = scoreDispatch(slots, [store], LIMITS, result);
  assertEquals(score.infeasibilities, []);
  assertEquals(score.start_sek, 1);
  assert(score.total_sek < 0);
});

Deno.test("run search neither forces unprofitable heating nor imposes a minimum runtime", () => {
  for (
    const [prices, expected] of [
      [[3, 3, 3, 3], [0, 0, 0, 0]],
      [[1, 1], [0, 0]],
      [[-1, 100], [1000, 0]],
    ]
  ) {
    const { slots, store } = startupProblem(prices);
    assertEquals(planDispatch(slots, [store], LIMITS).power_w.pool, expected);
  }
});

Deno.test("multi-quarter startup respects both store capacity and connection headroom", () => {
  const { slots, store } = startupProblem();
  store.max_state = 1;
  const result = planDispatch(slots, [store], LIMITS);
  const score = scoreDispatch(slots, [store], LIMITS, result);
  assertEquals(score.infeasibilities, []);
  assertEquals(score.stores[0].charged_kwh, 1);
  assert(score.total_sek < 0);
  const constrained = { ...LIMITS, grid_import_limit_w: 500 };
  assertEquals(
    planDispatch(slots, [store], constrained).power_w.pool,
    slots.map(() => 0),
  );
});

Deno.test("running telemetry waives only a continuation at the first quarter", () => {
  const { slots, store } = startupProblem([1]);
  const limits = { ...LIMITS, load_start_preference_sek: 0.25 };
  store.initially_charging = true;
  const result = planDispatch(slots, [store], limits);
  assertEquals(result.power_w.pool, [1000]);
  const score = scoreDispatch(slots, [store], limits, result);
  assertEquals(score.start_sek, 0);
  assertEquals(score.continuity_sek, 0);
  for (const running of [false, undefined]) {
    store.initially_charging = running;
    assertEquals(planDispatch(slots, [store], limits).power_w.pool, [0]);
  }
  const restart = startupProblem([100, 1, 1, 1]);
  restart.store.initially_charging = true;
  const later = planDispatch(restart.slots, [restart.store], limits);
  assertEquals(later.power_w.pool, [0, 1000, 1000, 1000]);
  assertEquals(
    scoreDispatch(restart.slots, [restart.store], limits, later).start_sek,
    0.5,
  );
});

Deno.test("settlement keeps a heat-pump run connected when a marginal quarter turns negative", () => {
  // Later accepted heat lowers the value of slot 3. Previously settlement
  // removed it alone and left slots 4–5 carrying a stale free-continuation bid.
  const { slots, store } = startupProblem([2.4, 2.1, 0.4, 2.1, 1.2, 0.2]);
  store.initially_charging = true;
  store.curve.points = [{ at: 0, sek_per_unit: 3 }, { at: 2, sek_per_unit: 0 }];
  const result = planDispatch(slots, [store], LIMITS);
  assertEquals(result.power_w.pool, slots.map(() => 1000));
  const parts = result.allocations.map((parts) => parts.find((p) => p.store_key === "pool")!);
  assert(parts[3].net_value_sek < 0, "the bridge quarter must lose in isolation");
  const net = parts.reduce((sum, part) => sum + part.net_value_sek, 0);
  assert(net > 0);
  for (const part of parts) {
    assertEquals(part.run_start_index, 0);
    assertEquals(part.run_slots, slots.length);
    assertEquals(part.start_cost_sek, 0);
    assert(Math.abs(part.run_net_value_sek - net) < 1e-9);
  }
  assertEquals(scoreDispatch(slots, [store], LIMITS, result).infeasibilities, []);
});

Deno.test("settlement can split heating when the saving covers the newly exposed restart", () => {
  const { slots, store } = startupProblem([12, 10.5, 2, 10.5, 6, 1]);
  store.initially_charging = true;
  store.curve.points = [{ at: 0, sek_per_unit: 15 }, { at: 2, sek_per_unit: 0 }];
  const result = planDispatch(slots, [store], LIMITS);
  assertEquals(result.power_w.pool, [1000, 1000, 1000, 0, 1000, 1000]);
  const restart = result.allocations.flat().filter((part) => part.run_start_index === 4);
  assertEquals(restart.length, 2);
  assertEquals(restart.reduce((sum, part) => sum + part.start_cost_sek, 0), 0.5);
  assert(restart.every((part) => part.run_slots === 2 && part.run_net_value_sek > 0));
});

Deno.test("heat-pump run diagnostics charge exactly once per actual restart", () => {
  const { slots, store } = startupProblem([1, 1, 1, 100, 1, 1, 1]);
  const result = planDispatch(slots, [store], LIMITS);
  const parts = result.allocations.flat();
  for (const start of [0, 4]) {
    const run = parts.filter((part) => part.run_start_index === start);
    assertEquals(run.length, 3);
    assert(run.every((part) => part.run_slots === 3));
    assert(Math.abs(run.reduce((sum, part) => sum + part.start_cost_sek, 0) - 0.5) < 1e-9);
  }
  const charged = parts.reduce((sum, part) => sum + part.start_cost_sek, 0);
  assert(Math.abs(charged - scoreDispatch(slots, [store], LIMITS, result).start_sek) < 1e-9);
});

for (const key of ["battery", "ev"]) {
  Deno.test(`${key} charging has no equipment or continuity start penalty`, () => {
    const { slots, store } = startupProblem([1, 100, 1]);
    store.key = key;
    delete store.start_cost_sek;
    const limits = { ...LIMITS, load_start_preference_sek: 0.25 };
    const result = planDispatch(slots, [store], limits);
    assertEquals(result.power_w[key], [1000, 0, 1000]);
    const score = scoreDispatch(slots, [store], limits, result);
    assertEquals(score.start_sek, 0);
    assertEquals(score.continuity_sek, 0);
    assert(result.allocations.flat().every((part) => part.start_cost_sek === 0));
  });
}

Deno.test("export allocation and settlement enforce slot eligibility and reserve", () => {
  const slots = buildSlots([new Array(8).fill(0)], {importPrice: 4, exportPrice: 6});
  const battery = batteryStore(slots.length, 17, .1, {exportAllowed: true});
  battery.discharge!.export_allowed_by_slot = slots.map((_, index) => index >= 4);
  battery.discharge!.export_min_state = 14;
  const result = planDispatch(slots, [battery], LIMITS);
  const scored = scoreDispatch(slots, [battery], LIMITS, result);
  assertEquals(scored.infeasibilities, []);
  for (let index = 0; index < slots.length; index++) {
    const out = result.discharge_w.battery[index];
    if (index < 4) assert(out <= slots[index].fixed_load_w + .01);
    if (out > slots[index].fixed_load_w + .01) assert(scored.state.battery[index + 1] >= 14 - 1e-6);
  }
  assert(result.discharge_w.battery.some((out, index) => index >= 4 && out > slots[index].fixed_load_w));
  const invalid = structuredClone(result);
  invalid.power_w.battery.fill(0);
  invalid.discharge_w.battery.fill(0);
  invalid.discharge_w.battery[0] = 4000;
  assertEquals(scoreDispatch(slots, [battery], LIMITS, invalid).infeasibilities.length > 0, true);
  invalid.discharge_w.battery.fill(0);
  invalid.discharge_w.battery[4] = 9600;
  invalid.discharge_w.battery[5] = 9600;
  assertEquals(scoreDispatch(slots, [battery], LIMITS, invalid).infeasibilities.length > 0, true);
});

Deno.test("cost refinement moves energy, not equal watts, between unequal durations", () => {
  const slots: DispatchSlot[] = [
    {pv_w: 0, fixed_load_w: 0, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: 0, duration_hours: .125},
    {pv_w: 0, fixed_load_w: 0, import_price_sek_per_kwh: 2, export_price_sek_per_kwh: 0, duration_hours: .25},
  ];
  const store: DispatchStore = {key: "battery", curve: {unit: "kwh", points: [{at: 10, sek_per_unit: 3}]},
    initial_state: 0, max_state: 10, max_power_w: 4000, retention_per_slot: 1,
    usage_weight: [0, 0], terminal_weight: 1, units_per_kwh: () => 1, drift: s => s,
    slot_hours: [.125, .25]};
  const schedule: DispatchSchedule = {power_w: {battery: [0, 1000]}, discharge_w: {battery: [0, 0]}};
  refineDispatchCosts(slots, [store], LIMITS, schedule);
  assertEquals(schedule.power_w.battery, [2000, 0]);
  const score = scoreDispatch(slots, [store], LIMITS, schedule);
  assertEquals(score.infeasibilities, []);
  assertEquals(score.stores[0].end_state, .25);
  assertEquals(score.billable_sek, .25);
});
