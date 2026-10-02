import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { type DemandDay, demandLevel, demandMargin, type DemandMarginInput } from "./demand-outlook.ts";
import { generateOptimisationPlan } from "./energy-optimisation.ts";
import { horizon, NOW } from "./energy-optimisation.fixture.ts";

const TODAY = "2026-10-02";
/** `count` matured days ending yesterday, each forecast 20 kWh and drawing what `actual` says. */
const days = (count: number, actual: (age: number) => number): DemandDay[] =>
  Array.from({ length: count }, (_, index) => {
    const age = index + 1;
    return { day: new Date(Date.parse(`${TODAY}T00:00:00Z`) - age * 86_400_000).toISOString().slice(0, 10), forecast_kwh: 20, actual_kwh: actual(age) };
  });

const battery = { usable_kwh: 17, charge_efficiency: 0.95, discharge_efficiency: 0.95, degradation_sek_per_kwh: 0.05 };
/** A day of quarters: a cheap night, an ordinary day, a dear evening. */
const market = (night: number, evening: number, surplusKwhPerDay = 0): DemandMarginInput => ({
  importSekPerKwh: Array.from({ length: 96 }, (_, q) => q < 24 ? night : q >= 68 && q < 88 ? evening : (night + evening) / 2),
  exportSekPerKwh: new Array(96).fill(0.3),
  surplusKwh: Array.from({ length: 96 }, (_, q) => q >= 40 && q < 60 ? surplusKwhPerDay / 20 : 0),
  horizonHours: 24,
  battery,
});

Deno.test("too few matured days leave the forecast as it is", () => {
  assertEquals(demandLevel(days(4, () => 30), TODAY), null);
  assertEquals(demandLevel(null, TODAY), null);
  // Today and days ahead have not happened; a day with no forecast says nothing.
  assertEquals(demandLevel([...days(4, () => 30), { day: TODAY, forecast_kwh: 20, actual_kwh: 30 }, { day: "2026-09-20", forecast_kwh: 0, actual_kwh: 30 }], TODAY), null);
});

Deno.test("a house drawing more than forecast every day is levelled up, short of all the way", () => {
  const level = demandLevel(days(14, () => 25), TODAY)!;
  assert(level.factor > 1.2 && level.factor < 1.25, `factor ${level.factor}`);
  // Every day strayed alike, so once levelled there is almost no spread left.
  assert(level.spread < 0.03, `spread ${level.spread}`);
});

Deno.test("the last days outweigh the weeks before them", () => {
  // Autumn: on forecast until five days ago, a quarter over since.
  const rising = demandLevel(days(20, (age) => age <= 5 ? 25 : 20), TODAY)!;
  const falling = demandLevel(days(20, (age) => age <= 5 ? 20 : 25), TODAY)!;
  assert(rising.factor > 1.1, `rising ${rising.factor}`);
  assert(falling.factor < rising.factor && falling.factor < 1.12, `falling ${falling.factor}`);
});

Deno.test("the level never replaces the forecast outright", () => {
  assertEquals(demandLevel(days(14, () => 80), TODAY)!.factor, 1.6);
  assertEquals(demandLevel(days(14, () => 2), TODAY)!.factor, 0.75);
});

Deno.test("a wide price spread with no sun plans above the forecast, as far as it ever goes", () => {
  const level = { factor: 1, spread: 0.25, days: 20, effective_days: 6 };
  const dark = demandMargin(level, market(1, 2.5));
  assertEquals(dark.quantile, 0.7);
  assertAlmostEquals(dark.factor, 1.131, 0.001);
  assertEquals(dark.solar_refill_share, 0);
  // A narrower spread that still pays stops short of that.
  const narrow = demandMargin(level, market(1, 1.26));
  assert(narrow.quantile > 0.5 && narrow.quantile < 0.7, `quantile ${narrow.quantile}`);
});

Deno.test("sun that would fill the pack anyway keeps the plan near the forecast", () => {
  const level = { factor: 1, spread: 0.25, days: 20, effective_days: 6 };
  const dark = demandMargin(level, market(1, 2.5));
  const sunny = demandMargin(level, market(1, 2.5, 30));
  assertEquals(sunny.solar_refill_share, 1);
  assert(sunny.factor < dark.factor - 0.03, `sunny ${sunny.factor} dark ${dark.factor}`);
  assert(sunny.over_sek_per_kwh > dark.over_sek_per_kwh);
});

Deno.test("flat prices, no battery or no spread plan on the forecast", () => {
  const level = { factor: 1, spread: 0.25, days: 20, effective_days: 6 };
  // Carrying energy through the pack costs more than the evening saves.
  assertEquals(demandMargin(level, market(1.6, 1.7)).factor, 1);
  assertEquals(demandMargin(level, { ...market(1, 2.5), battery: { ...battery, usable_kwh: 0 } }).factor, 1);
  assertEquals(demandMargin({ ...level, spread: 0 }, market(1, 2.5)).factor, 1);
});

Deno.test("the planner plans for the levelled, margined demand and says so", () => {
  // The fixture's captured_at is 2026-08-10; evidence ends the day before.
  const evidence = Array.from({ length: 10 }, (_, index) => ({
    day: new Date(Date.parse("2026-08-09T00:00:00Z") - index * 86_400_000).toISOString().slice(0, 10),
    forecast_kwh: 24, actual_kwh: index % 2 ? 26 : 34,
  }));
  const snapshot = horizon({ capabilities: { pv: true, battery: true, pool: false, boiler: false, ev: false } }, { peakPvW: 1_500 });
  const plain = generateOptimisationPlan(snapshot, new Date(NOW));
  const planned = generateOptimisationPlan({ ...snapshot, demand_outlook: { days: evidence } }, new Date(NOW));
  assertEquals(plain.demand_outlook, undefined);
  const outlook = planned.demand_outlook!;
  assert(outlook.level_factor > 1.15 && outlook.margin_factor > 1, JSON.stringify(outlook));
  assertAlmostEquals(planned.plans.priority.slots[0].base_w, 1_000 * outlook.level_factor * outlook.margin_factor, 0.5);
  assertEquals(plain.plans.priority.slots[0].base_w, 1_000);
  // More demand ahead of a dear evening is more charged for it.
  const charged = (plan: typeof plain) => plan.plans.priority.slots.reduce((sum, slot) => sum + slot.battery_charge_w, 0);
  assert(charged(planned) > charged(plain), `${charged(planned)} vs ${charged(plain)}`);
});
