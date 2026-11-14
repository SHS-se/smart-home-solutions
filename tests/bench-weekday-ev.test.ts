import { assertAlmostEquals, assertEquals } from "@std/assert";
import { recordedEvUsage } from "../bench/history.ts";
import { planningCase } from "../bench/execution.ts";
import { readyProblem } from "../bench/wasm-planner.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { simulate } from "../src/lib/planner-bench/referee.ts";
import { plan, quarters, world } from "../src/lib/planner-bench/world.fixture.ts";

Deno.test("the bench freezes weekday averages before the case and replays common held-out use", async () => {
  const c = { ...world(), start: "2026-02-09T00:00:00.000Z", timezone: "UTC" };
  const start = Date.parse(c.start), quarter = 900_000;
  // Synthetic history holds SOC constant by recharging 4 battery kWh per day
  // before the case and 12 per day afterwards. All quantities are invented.
  const rows = Array.from({ length: 10 * 96 + 1 }, (_, index) => {
    const n = index - 7 * 96;
    const charge = n % 96 === 16 || n % 96 === -80 ? (n < 0 ? 4 : 12) / HOUSEHOLD.car.battery.charge_efficiency : 0;
    return [start + n * quarter, 0.5, charge];
  });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(rows));
  try {
    // At midnight the closing SOC observation has not matured for Sunday.
    const usage = await recordedEvUsage({ url: "https://synthetic.test", key: "synthetic", homeId: "synthetic" }, c, start + 4 * 96 * quarter);
    assertEquals(usage.forecast!.days, [0, 1, 1, 1, 1, 1, 1]);
    usage.forecast!.kwh.forEach(kwh => assertAlmostEquals(kwh, 4));
    assertAlmostEquals(usage.actual!.reduce((sum, kwh) => sum + kwh, 0), 36);
    c.recorded.history.ev_weekday_usage = usage.forecast;
    c.recorded.actual = { base_load_w: quarters(() => 500), solar_w: quarters(() => 0), ev_usage_kwh: usage.actual };
    const input = planningCase(c);
    assertEquals(input.recorded.actual?.ev_usage_kwh, undefined);
    assertEquals(input.recorded.history.ev_weekday_usage, usage.forecast);
    const ready = readyProblem(input, HOUSEHOLD);
    const forecast = ready.slots.map(slot => slot.ev_usage_kw! * slot.hours);
    assertAlmostEquals(forecast.reduce((sum, kwh) => sum + kwh, 0), 12);
    const previous = plan();
    const candidate = { ...previous, ev_usage_forecast_kwh: forecast };
    assertEquals(simulate(c, HOUSEHOLD, previous).evKwh, simulate(c, HOUSEHOLD, candidate).evKwh);
    assertAlmostEquals(simulate(c, HOUSEHOLD, previous, 'told').evKwh.at(-1)!
      - simulate(c, HOUSEHOLD, candidate, 'told').evKwh.at(-1)!, 12);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

Deno.test("recorded use beyond stored charge stays visible as unserved kWh", () => {
  const c = world({ start: { ev: { soc: 0 } } });
  c.recorded.actual = { base_load_w: quarters(() => 500), solar_w: quarters(() => 0),
    ev_usage_kwh: quarters(i => i === 0 ? 2 : 0) };
  const result = simulate(c, HOUSEHOLD, plan());
  assertEquals(result.evKwh[0], 0);
  assertEquals(result.evUsageUnservedKwh, 2);
  assertEquals(result.netW[0], 500);
});
