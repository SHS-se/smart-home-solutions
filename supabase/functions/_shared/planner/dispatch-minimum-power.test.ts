import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  dispatchAuctionSteps,
  type DispatchCheckpoint,
  type DispatchLimits,
  type DispatchResult,
  type DispatchSchedule,
  type DispatchSlot,
  type DispatchStore,
  enforceMinimumSizedPower,
  planDispatch,
  scoreDispatch,
} from "./dispatch-plan.ts";

// The household's rule (19 September 2026): nothing the plan asks the battery
// for by size — a grid charge, a discharge that leaves the house importing —
// is smaller than 500 W, because each becomes an inverter limit that spends a
// quarter's fixed conversion overhead on a few öre. Taking surplus solar and
// covering the house outright are permissions, and keep every watt.
const MINIMUM_W = 500;

const SHAPED: DispatchLimits = {
  grid_import_shaping_w: 0,
  peak_shaping_sek_per_kwh_per_kw: 0.1,
  grid_ramp_sek_per_kw: 0.05,
  grid_import_limit_w: 13_200,
  grid_export_limit_w: 13_200,
};
const PLAIN: DispatchLimits = {
  grid_import_shaping_w: 0,
  peak_shaping_sek_per_kwh_per_kw: 0,
  grid_import_limit_w: 13_200,
  grid_export_limit_w: 13_200,
};

function battery(
  slots: number,
  overrides: Partial<DispatchStore> = {},
): DispatchStore {
  return {
    key: "battery",
    curve: {
      unit: "kwh",
      points: [
        { at: 2, sek_per_unit: 1.6 },
        { at: 8, sek_per_unit: 1.15 },
        { at: 17, sek_per_unit: 0.9 },
      ],
    },
    initial_state: 9,
    min_state: 0,
    max_state: 17,
    max_power_w: 8_800,
    min_sized_power_w: MINIMUM_W,
    retention_per_slot: 1,
    usage_weight: new Array(slots).fill(0),
    terminal_weight: 1,
    units_per_kwh: () => 0.95,
    drift: (state) => state,
    discharge: {
      max_power_w: 9_600,
      state_per_kwh_out: () => 1 / 0.95,
      export_allowed: false,
      cycling_cost_sek_per_unit: 0.05,
    },
    ...overrides,
  };
}

/**
 * A day from 18:00 under the production preferences: a dear evening, a cheap
 * night, a solar morning, and a house load that wanders. Shaping makes the
 * search top import up to a flat line with whatever the load leaves over,
 * which is exactly where sized trickles come from.
 */
function wanderingDay(): DispatchSlot[] {
  return Array.from({ length: 96 }, (_, index) => {
    const hour = (18 + index / 4) % 24;
    const pv = hour >= 7 && hour <= 17
      ? Math.round(3_500 * Math.sin(((hour - 7) / 10) * Math.PI))
      : 0;
    const evening = hour >= 17 && hour < 21 ? 500 : 0;
    const price = hour >= 17 && hour < 22
      ? 1.4 - 0.05 * Math.cos(index)
      : hour < 6
      ? 0.78 + 0.02 * Math.sin(index)
      : 0.95 + 0.03 * Math.sin(index / 3);
    return {
      pv_w: pv,
      fixed_load_w: Math.round(900 + 350 * Math.sin(index * 0.9) + evening),
      import_price_sek_per_kwh: Number(price.toFixed(3)),
      export_price_sek_per_kwh: 0.15,
    };
  });
}

/** Flows below the floor that the plan would have to name a size for. */
function sizedTrickles(
  slots: DispatchSlot[],
  schedule: Pick<DispatchSchedule, "power_w" | "discharge_w">,
): string[] {
  const found: string[] = [];
  for (const [index, slot] of slots.entries()) {
    const charge = schedule.power_w.battery[index];
    const discharge = schedule.discharge_w.battery[index];
    const surplus = Math.max(0, slot.pv_w - slot.fixed_load_w);
    const residual = Math.max(0, slot.fixed_load_w - slot.pv_w);
    if (
      charge > 1e-6 && charge < MINIMUM_W - 1e-6 && charge > surplus + 0.01
    ) found.push(`${index}: charges ${charge.toFixed(0)} W from the grid`);
    if (
      discharge > 1e-6 && discharge < MINIMUM_W - 1e-6 &&
      Math.abs(discharge - residual) > 0.01
    ) found.push(`${index}: returns ${discharge.toFixed(0)} W`);
  }
  return found;
}

Deno.test("no sized battery flow is smaller than the household's floor", () => {
  const slots = wanderingDay();
  const free = planDispatch(
    slots,
    [battery(slots.length, { min_sized_power_w: undefined })],
    SHAPED,
  );
  // Without the rule this day is full of them, so the rule is exercised.
  assert(
    sizedTrickles(slots, free).length >= 10,
    `${sizedTrickles(slots, free).length} sized trickles`,
  );

  const store = battery(slots.length);
  const result = planDispatch(slots, [store], SHAPED);
  assertEquals(sizedTrickles(slots, result), []);
  assertEquals(scoreDispatch(slots, [store], SHAPED, result).infeasibilities, []);
  // Still a working battery, not one the rule parked.
  const kwh = (series: number[]) =>
    series.reduce((sum, watts) => sum + watts, 0) / 4_000;
  assert(kwh(result.power_w.battery) > 5, "the pack still charges");
  assert(kwh(result.discharge_w.battery) > 5, "and still discharges");
  // Every quarter's diagnostics describe the power the schedule runs.
  for (let index = 0; index < slots.length; index += 1) {
    const watts = result.power_w.battery[index] ||
      result.discharge_w.battery[index];
    const part = result.allocations[index].find((entry) =>
      entry.store_key === "battery"
    );
    if (watts > 1e-6) assertAlmostEquals(part?.power_w ?? 0, watts, 1e-6);
    else assertEquals(part, undefined);
  }
});

Deno.test("the sun still fills the pack a hundred watts at a time", () => {
  // Surplus solar is a permission: the command sends the pack's whole charge
  // limit and it takes what the roof gives, so no floor applies. The same
  // quarter may not buy 200 W from the grid on top of it.
  const slots: DispatchSlot[] = Array.from({ length: 8 }, () => ({
    pv_w: 1_100,
    fixed_load_w: 900,
    import_price_sek_per_kwh: 2,
    export_price_sek_per_kwh: 0.05,
  }));
  const store = battery(slots.length, { initial_state: 8 });
  const schedule: DispatchSchedule = {
    power_w: { battery: [200, 200, 200, 200, 400, 0, 0, 0] },
    discharge_w: { battery: new Array(8).fill(0) },
  };
  const changed = enforceMinimumSizedPower(slots, [store], PLAIN, schedule);
  // The 200 W charges are exactly the surplus; the 400 W one buys 200 W.
  assertEquals(schedule.power_w.battery.slice(0, 4), [200, 200, 200, 200]);
  assert(
    schedule.power_w.battery[4] === 0 ||
      schedule.power_w.battery[4] >= MINIMUM_W ||
      schedule.power_w.battery[4] <= 200,
    `a grid-backed charge must rest, reach the floor, or keep to the surplus: ${
      schedule.power_w.battery[4]
    }`,
  );
  assertEquals(changed.get("battery")?.has(4), true);
  assertEquals(sizedTrickles(slots, schedule), []);
  assertEquals(scoreDispatch(slots, [store], PLAIN, schedule).infeasibilities, []);
});

Deno.test("a small house is still covered outright", () => {
  // Covering the whole residual load is demand-following, not a size: the
  // command hands over the pack's discharge limit and the inverter follows a
  // 300 W house. Leaving 200 W of it on the grid would be a size, and is not.
  const slots: DispatchSlot[] = Array.from({ length: 8 }, () => ({
    pv_w: 0,
    fixed_load_w: 300,
    import_price_sek_per_kwh: 2,
    export_price_sek_per_kwh: 0.05,
  }));
  const store = battery(slots.length);
  const schedule: DispatchSchedule = {
    power_w: { battery: new Array(8).fill(0) },
    discharge_w: { battery: [300, 300, 300, 300, 100, 0, 0, 0] },
  };
  enforceMinimumSizedPower(slots, [store], PLAIN, schedule);
  assertEquals(schedule.discharge_w.battery.slice(0, 4), [300, 300, 300, 300]);
  assertEquals(sizedTrickles(slots, schedule), []);
  assertEquals(scoreDispatch(slots, [store], PLAIN, schedule).infeasibilities, []);
});

Deno.test("a paused auction resumes to the same rounded schedule", () => {
  const slots = wanderingDay();
  const store = battery(slots.length);
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const uninterrupted = dispatchAuctionSteps(slots, [store], SHAPED);
  let step = uninterrupted.next();
  while (!step.done) step = uninterrupted.next();
  const expected: DispatchResult = step.value;
  assertEquals(sizedTrickles(slots, expected), []);

  let checkpoint: DispatchCheckpoint | undefined;
  // Paused both before the rounding runs and inside the refinement after it.
  let beforeRounding = 0;
  let insideRefinement = 0;
  for (let request = 0; request < 4_096; request += 1) {
    let primitives = 0;
    const slice = checkpoint?.next === "refinement" ? 10 : 1_000;
    const next = dispatchAuctionSteps(
      slots,
      [store],
      SHAPED,
      {},
      checkpoint,
      () => ++primitives > slice,
    ).next();
    if (next.done === true) {
      assertEquals(wire(next.value), wire(expected));
      assert(beforeRounding > 0 && insideRefinement > 0);
      return;
    }
    checkpoint = wire(next.value);
    if (checkpoint.next === "refinement") {
      if (checkpoint.refinement) insideRefinement += 1;
      else beforeRounding += 1;
    }
  }
  throw new Error("The paused dispatch did not finish");
});

Deno.test("rounding a trickle away offsets it before a full pack overflows", () => {
  // A 200 W discharge that leaves 100 W on the grid: a size, and under the
  // floor. Reaching the floor would export, which this pack may not; covering
  // the house outright is permitted but spends stored energy against a quarter
  // that costs almost nothing; and rest alone overfills the pack when the sun
  // fills it exactly, eighteen quarters later — beyond the nearby window. So
  // the energy has to come off a later charge.
  const slots: DispatchSlot[] = Array.from({ length: 24 }, (_, index) => ({
    pv_w: index >= 18 && index < 22 ? 5_000 : 0,
    fixed_load_w: 300,
    import_price_sek_per_kwh: index === 0 ? 0.05 : 1,
    export_price_sek_per_kwh: 0.1,
  }));
  const spent = 200 / 1_000 * 0.25 / 0.95;
  const gained = 4 * 2_000 / 1_000 * 0.25 * 0.95;
  const store = battery(slots.length, {
    max_state: 10,
    initial_state: 10 - gained + spent,
  });
  const schedule: DispatchSchedule = {
    power_w: {
      battery: slots.map((_, index) => index >= 18 && index < 22 ? 2_000 : 0),
    },
    discharge_w: { battery: slots.map((_, index) => index === 0 ? 200 : 0) },
  };
  const physical = { ...store, min_sized_power_w: 0 };
  assertEquals(scoreDispatch(slots, [physical], PLAIN, schedule).infeasibilities, []);

  const changed = enforceMinimumSizedPower(slots, [store], PLAIN, schedule);
  assertEquals(schedule.discharge_w.battery[0], 0);
  assertEquals(sizedTrickles(slots, schedule), []);
  assert(changed.get("battery")?.has(0));
  const score = scoreDispatch(slots, [store], PLAIN, schedule);
  assertEquals(score.infeasibilities, []);
  // The discharge's energy came off a later charge instead of overfilling.
  const chargedWh = schedule.power_w.battery.reduce((sum, w) => sum + w, 0) / 4;
  assertAlmostEquals(chargedWh, 2_000 - 200 / 0.95 / 0.95 / 4, 1e-6);
  assertAlmostEquals(score.state.battery[22], 10, 1e-9);
});

Deno.test("a store without a floor is left exactly as planned", () => {
  const slots = wanderingDay();
  const store = battery(slots.length, { min_sized_power_w: undefined });
  const schedule: DispatchSchedule = {
    power_w: { battery: slots.map((_, index) => index % 7 === 0 ? 150 : 0) },
    discharge_w: { battery: slots.map((_, index) => index % 7 === 3 ? 90 : 0) },
  };
  const before = structuredClone(schedule);
  assertEquals(enforceMinimumSizedPower(slots, [store], SHAPED, schedule).size, 0);
  assertEquals(schedule, before);
  assertEquals(
    scoreDispatch(slots, [store], SHAPED, schedule).infeasibilities.filter((
      entry,
    ) => entry.message.includes("minimum")),
    [],
  );
});

Deno.test("the scorer reports a hand-built sized trickle, and only that", () => {
  const slots: DispatchSlot[] = [
    // Dark: a 300 W charge is bought, a 200 W discharge leaves 700 W on the
    // grid, and 900 W covers the house exactly.
    { pv_w: 0, fixed_load_w: 900, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: 0.1 },
    { pv_w: 0, fixed_load_w: 900, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: 0.1 },
    { pv_w: 0, fixed_load_w: 900, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: 0.1 },
    // Sunny: a 300 W charge is all surplus.
    { pv_w: 1_400, fixed_load_w: 900, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: 0.1 },
  ];
  const store = battery(slots.length);
  const schedule: DispatchSchedule = {
    power_w: { battery: [300, 0, 0, 300] },
    discharge_w: { battery: [0, 200, 900, 0] },
  };
  const messages = scoreDispatch(slots, [store], PLAIN, schedule)
    .infeasibilities.map((entry) => `${entry.slot}: ${entry.message}`);
  assertEquals(messages, [
    "0: battery draws 300 W from the grid, below its 500 W minimum",
    "1: battery returns 200 W, below its 500 W minimum",
  ]);
});
