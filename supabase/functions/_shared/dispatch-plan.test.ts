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

  assert(shared > 0, "no quarter had two stores charging, so nothing was tested");
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
    const minRun = store.min_run_slots ?? 1;
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

Deno.test("a compressor minimum run must clear its complete block cost", () => {
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
    min_run_slots: 4,
    retention_per_slot: 1,
    usage_weight: new Array(slots.length).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 1,
    drift: (state) => state,
  };

  const result = planDispatch(slots, [store], LIMITS);

  assertEquals(result.power_w[store.key], [0, 0, 0, 0]);
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
