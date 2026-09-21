import {
  batterySnapshot,
  mixedModeSnapshot,
} from "../../../scripts/generate-ha-plan-fixture.ts";
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert@1";
import {
  CAPTURED_AT,
  snapshot,
  snapshotV8,
} from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import {
  automaticCurveIdentity,
  reusableAutomaticCurve,
} from "./automatic-battery-curve.ts";
import {
  dispatchWorkbench,
  generateOptimisationPlan,
} from "./energy-optimisation.ts";
import {
  type DispatchAuctionSolver,
  dispatchAuctionSteps,
  scoreDispatch,
} from "./dispatch-plan.ts";
import { comparePreference } from "../../../src/lib/energy-shift/curve-preview.ts";

const solveAuction: DispatchAuctionSolver = (...args) => {
  const steps = dispatchAuctionSteps(...args);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

Deno.test("automatic curve selection and its comparison ignore every forecast-only price and load", () => {
  const input = snapshot();
  const plan = generateOptimisationPlan(input, new Date(CAPTURED_AT));
  const record = plan.battery_value_curve!.optimisation!;
  assert(record.candidates > 1);
  assert(record.objective_after_sek <= record.objective_before_sek);
  const changed = structuredClone(input);
  changed.slots.forEach((slot) => {
    if (slot.import_price_sek_per_kwh === null) {
      slot.base_load_forecast_w = 9000;
      slot.pv_forecast_w = 10000;
    }
  });
  const outlook = structuredClone(plan.price_outlook);
  outlook.shadow_import_sek_per_kwh = outlook.shadow_import_sek_per_kwh.map((
    p,
    i,
  ) => input.slots[i].import_price_sek_per_kwh === null ? p * 1000 : p);
  const other = generateOptimisationPlan(
    changed,
    new Date(CAPTURED_AT),
    [],
    outlook,
  );
  assertEquals(other.battery_value_curve!.optimisation, record);
  assertEquals(
    other.battery_value_curve!.curve,
    plan.battery_value_curve!.curve,
  );
  assertEquals(other.plans.priority.slots.length, 288);
  const curves = {
    battery: {
      unit: "kwh",
      points: [{ at: 0, sek_per_unit: 2 }, { at: 17.176, sek_per_unit: 0.5 }],
    },
  };
  assertEquals(
    comparePreference(input, {}, curves, plan.price_outlook),
    comparePreference(changed, {}, curves, outlook),
  );
});

Deno.test("daily curve survives rolling horizon and live measurements; new or corrected prices and settings invalidate it", () => {
  const input = snapshotV8();
  const plan = generateOptimisationPlan(input, new Date(CAPTURED_AT));
  const record = plan.battery_value_curve!.optimisation!;
  const rolling = structuredClone(input);
  rolling.slots = rolling.slots.slice(4);
  rolling.battery!.soc = 0.3;
  rolling.pool!.water_temperature_c = 26;
  rolling.services.forEach((service) => {
    service.id += ":next-quarter";
  });
  assert(reusableAutomaticCurve(automaticCurveIdentity(rolling), record));
  rolling.slots[1].import_price_sek_per_kwh! += 0.01;
  assert(!reusableAutomaticCurve(automaticCurveIdentity(rolling), record));
  const newPrices = structuredClone(input);
  newPrices.slots[100].import_price_sek_per_kwh = 1.1;
  newPrices.slots[100].export_price_sek_per_kwh = 0.2;
  assert(!reusableAutomaticCurve(automaticCurveIdentity(newPrices), record));
  const settings = structuredClone(input);
  settings.battery!.max_soc = 0.9;
  assert(!reusableAutomaticCurve(automaticCurveIdentity(settings), record));
  let calls = 0;
  const cached = generateOptimisationPlan(
    {
      ...input,
      automatic_battery_curves: [record],
    },
    new Date(CAPTURED_AT),
    [],
    undefined,
    undefined,
    (...args) => {
      calls++;
      return solveAuction(...args);
    },
  );
  assertEquals(
    calls,
    1,
    "cached generation solves dispatch once without repeating the daily trials",
  );
  assertEquals(cached.battery_value_curve!.optimisation, record);
  assertEquals(cached.plans, plan.plans);
});

Deno.test("selected curve is scored under a common reference and explicit custom curves remain untouched", () => {
  const input = batterySnapshot();
  const plan = generateOptimisationPlan(input, new Date(input.captured_at));
  const record = plan.battery_value_curve!.optimisation!;
  assert(record.objective_after_sek < record.objective_before_sek);
  assertNotEquals(record.curve, record.reference_curve);
  const published = dispatchWorkbench(
    { ...input, automatic_battery_curves: [record] },
    [],
    undefined,
    new Date(input.captured_at),
    "published",
  )!;
  assert(published.slots.every((s) => s.published_price));
  assertEquals(published.slots.length, input.slots.length);
  const score = scoreDispatch(
    published.slots,
    published.stores,
    published.limits,
    published.planned,
  );
  assertAlmostEquals(score.billable_sek, score.billable_quoted_sek, 1e-10);
  const commonReference = published.stores.map((store) =>
    store.key === "battery"
      ? { ...store, curve: record.reference_curve }
      : store
  );
  assertAlmostEquals(
    scoreDispatch(
      published.slots,
      commonReference,
      published.limits,
      published.planned,
    ).total_sek,
    record.objective_after_sek,
    1e-9,
  );
  const custom = {
    unit: "kwh",
    points: [{ at: 0, sek_per_unit: 100 }, { at: 17.176, sek_per_unit: 50 }],
  };
  const overridden = generateOptimisationPlan({
    ...input,
    value_curves: { battery: custom },
    automatic_battery_curves: [record],
  }, new Date(input.captured_at));
  assertEquals(overridden.battery_value_curve!.curve, custom);
  assertEquals(overridden.battery_value_curve!.source, "customer");
  assertEquals(overridden.battery_value_curve!.optimisation, undefined);
  assertNotEquals(
    overridden.plans.priority.summary.battery_soc_end,
    plan.plans.priority.summary.battery_soc_end,
  );
});

Deno.test("comparison ends at the first unpublished quarter without compressing gaps in time", () => {
  const input = snapshot();
  input.slots[8].import_price_sek_per_kwh = null;
  input.slots[8].export_price_sek_per_kwh = null;
  const before = dispatchWorkbench(
    input,
    [],
    undefined,
    new Date(CAPTURED_AT),
    "published",
  )!;
  assertEquals(before.slots.length, 8);
  assertEquals(automaticCurveIdentity(input).published_prices.length, 8);
  input.slots.slice(9).forEach((slot) => {
    if (slot.import_price_sek_per_kwh !== null) {
      slot.import_price_sek_per_kwh *= 10;
    }
  });
  const after = dispatchWorkbench(
    input,
    [],
    undefined,
    new Date(CAPTURED_AT),
    "published",
  )!;
  assertEquals(after.planned, before.planned);
});

Deno.test("the conditional battery verification branch publishes and reuses its own daily curve", () => {
  const input = mixedModeSnapshot();
  input.operating_scope.modes.$battery = "control_verification";
  const first = generateOptimisationPlan(input, new Date(input.captured_at));
  const verification = first.battery_verification_value_curve?.optimisation;
  assert(verification);
  const records = [
    first.battery_value_curve?.optimisation,
    first.execution_plan?.battery_value_curve?.optimisation,
    verification,
  ].filter((record) => record !== undefined);
  let calls = 0;
  const next = generateOptimisationPlan(
    { ...input, automatic_battery_curves: records },
    new Date(input.captured_at),
    [],
    undefined,
    undefined,
    (...args) => {
      calls++;
      return solveAuction(...args);
    },
  );
  assertEquals(
    next.battery_verification_value_curve?.optimisation,
    verification,
  );
  assertEquals(
    calls,
    2,
    "only hypothetical and conditional dispatch run; execution has no controlled stores",
  );
});
