import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { batterySnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import {
  type CostCurveInput,
  costCurveKey,
  costCurveSearch,
  samePublishedPrices,
} from "./battery-cost-curve.ts";
import { type CostCurveProgress, costCurveStep } from "./battery-cost-step.ts";
import {
  dispatchWorkbench,
  dispatchWorkbenchInputs,
  generateOptimisationPlan,
} from "./planner/energy-optimisation.ts";
import { dispatchAuctionSteps, scoreDispatch } from "./planner/dispatch-plan.ts";
import type { UtilityCurve } from "./planner/store-value.ts";

const curve: UtilityCurve = {
  unit: "kwh",
  points: [{ at: 0, sek_per_unit: 2.8 }, { at: 4.3, sek_per_unit: 2.4 }, {
    at: 8.6,
    sek_per_unit: 1.5,
  }, { at: 17.176, sek_per_unit: .8 }],
};
function input(): CostCurveInput {
  const snapshot = batterySnapshot();
  snapshot.slots = snapshot.slots.slice(0, 16);
  snapshot.value_curves = { ...snapshot.value_curves, battery: curve };
  return { snapshot, now: snapshot.slots[0].start };
}
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

Deno.test("price release reuse ignores elapsed quarters but detects published corrections", async () => {
  const a = input(), b = wire(a);
  b.now = new Date(Date.parse(a.now) + 800_000).toISOString();
  b.snapshot.battery!.soc = .7;
  b.snapshot.captured_at = b.now;
  b.snapshot.slots = b.snapshot.slots.map((s) =>
    Object.fromEntries(Object.entries(s).reverse()) as typeof s
  );
  assertEquals(await costCurveKey(a), await costCurveKey(b));
  b.snapshot.slots[3].import_price_sek_per_kwh! += .01;
  assertNotEquals(await costCurveKey(a), await costCurveKey(b));
  const c = wire(a);
  c.now = new Date(Date.parse(a.now) + 900_000).toISOString();
  assertEquals(samePublishedPrices(a, c), true);
  c.snapshot.slots = c.snapshot.slots.slice(1);
  assertEquals(samePublishedPrices(a, c), true);
  c.snapshot.slots[0].import_price_sek_per_kwh! += .01;
  assertEquals(samePublishedPrices(a, c), false);
  const d = wire(a);
  d.snapshot.slots[0].import_price_sek_per_kwh = null;
  await assertRejects(() => costCurveKey(d), Error, "No published prices");
});

Deno.test("adaptive curve search keeps exact incumbent, monotone proposals, hard evaluation budget and earliest ties", () => {
  const run = () => {
    const generator = costCurveSearch(17.176, 3, [curve]);
    let p = generator.next(), count = 0;
    while (p.done !== true) {
      if (count === 0) assertEquals(p.value, curve);
      for (let i = 1; i < p.value.points.length; i++) {
        assert(p.value.points[i].at > p.value.points[i - 1].at);
        assert(
          p.value.points[i].sek_per_unit <=
            p.value.points[i - 1].sek_per_unit + 1e-12,
        );
      }
      count++;
      p = generator.next(10);
    }
    assert(count <= 160);
    assertEquals(p.value.curve, curve);
    return { count, result: p.value };
  };
  assertEquals(run(), run());
  const generator = costCurveSearch(17.176, 3, [curve]);
  let p = generator.next();
  while (p.done !== true) {
    p = generator.next(
      p.value.points.reduce((s, v) => s + v.sek_per_unit ** 2, 0),
    );
  }
  assertEquals(p.value.bill_sek, 0);
});

async function complete(source: CostCurveInput, limited: boolean) {
  let progress: CostCurveProgress = { evaluations: [] };
  let calls = 0;
  for (; calls < 4096; calls++) {
    let checks = 0;
    const budget = limited
      ? { spent: () => ++checks > 3, allowsAuction: () => checks <= 3 }
      : { spent: () => false, allowsAuction: () => true };
    const step = await costCurveStep(wire(source), wire(progress), budget);
    if (step.done === true) return { record: step.record, calls: calls + 1 };
    // Completed trial auction histories must never accumulate across candidates.
    assert((step.progress.current?.completed.length ?? 0) <= 1);
    progress = step.progress;
    progress.evaluations = progress.evaluations.map((e) => ({
      ...e,
      curve: {
        ...e.curve,
        points: e.curve.points.map((p) => ({
          sek_per_unit: p.sek_per_unit,
          at: p.at,
        })),
      },
    }));
  }
  throw new Error("Search did not finish");
}
Deno.test("price search resumed through JSON equals uninterrupted search and beats exact custom bill", async () => {
  const source = input();
  const direct = await complete(source, false),
    staged = await complete(source, true);
  assertEquals(staged.record, direct.record);
  assert(staged.calls > direct.calls);
  assert(direct.record.evaluations <= 160);
  assert(direct.record.bill_after_sek <= direct.record.bill_before_sek + 1e-8);
  const work = dispatchWorkbench(
    {
      ...source.snapshot,
      battery_curve_mode: "custom",
      value_curves: { battery: direct.record.curve },
    },
    [],
    undefined,
    new Date(source.now),
    "published",
  )!;
  assertAlmostEquals(
    scoreDispatch(work.slots, work.stores, work.limits, work.planned)
      .billable_quoted_sek,
    direct.record.bill_after_sek,
    1e-8,
  );
  const live = generateOptimisationPlan({
    ...source.snapshot,
    battery_curve_mode: "price_only",
    battery_cost_curve: direct.record,
  }, new Date(source.now));
  assertEquals(live.battery_value_curve!.curve, direct.record.curve);
  assertEquals(live.battery_value_curve!.cost_selection, direct.record);
});
Deno.test("unknown-price forecast tail cannot affect selection or its published window", async () => {
  const a = input();
  a.snapshot.slots[8].import_price_sek_per_kwh = null;
  a.snapshot.slots[8].export_price_sek_per_kwh = null;
  const b = wire(a);
  for (const slot of b.snapshot.slots.slice(8)) slot.pv_forecast_w = 99999;
  assertEquals(await costCurveKey(a), await costCurveKey(b));
  assertEquals(
    (await complete(a, false)).record,
    (await complete(b, false)).record,
  );
});

Deno.test("price search refuses a newly infeasible completed dispatch", async () => {
  const source = input();
  const first = await costCurveStep(source, undefined, {
    spent: () => false,
    allowsAuction: () => false,
  });
  assert(first.done === false);
  const progress = first.progress;
  assertEquals(progress.evaluations.length, 1);
  const model = dispatchWorkbenchInputs(
    source.snapshot,
    [],
    undefined,
    new Date(source.now),
    "published",
  )!;
  const auction = dispatchAuctionSteps(model.slots, model.stores, model.limits);
  let result = auction.next();
  while (result.done !== true) result = auction.next();
  result.value.power_w.battery[0] = 100_000;
  progress.current = { completed: [result.value] };
  await assertRejects(
    () => costCurveStep(source, progress),
    Error,
    "physical dispatch infeasibility",
  );
});
