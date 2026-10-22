import { assertEquals } from "@std/assert";
import { createPriceExperimentHandler, type PriceExperimentStore, type PricePairReservation } from "./index.ts";
import type { PricePairForecast } from "../_shared/price-pair.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const request = (token = "research-token") => new Request(`${TEST}/functions/v1/energy-price-experiment`, {
  method: "POST", headers: { "x-energy-market-archive-token": token },
});
function fixture() {
  const calls: string[] = [];
  const reservation: PricePairReservation = { id: "pair", status: "pending", context: {
    homeId: "home", mixRunId: "mix", actualObservationId: "actual", priceCutoff: 12,
    knownAt: "2026-10-22T20:00:00Z", origin: "2026-10-22T20:00:00Z", prices: [],
    generation: { algorithm: "se3-generation-analog-v2", zone: "SE3", origin: "2026-10-22T19:00:00Z",
      hours: [], training: {}, diagnostics: { actuals: { productionIntervals: 0, completeHours: 0, reason: null },
        weather: { status: "unavailable", issueTime: null, reason: "fixture" },
        published: { productionIntervals: 0, completeHours: 0, reason: null } } },
  } };
  const forecast: PricePairForecast = { status: "unavailable", reason: "fixture", fit: null, targets: [] };
  const store: PriceExperimentStore = {
    verifyToken(token) { calls.push("verify"); return Promise.resolve(token === "research-token"); },
    begin() { calls.push("begin"); return Promise.resolve(reservation); },
    actualIntervals(id) { calls.push(`actual:${id}`); return Promise.resolve([]); },
    complete(id, payload) { calls.push(`complete:${id}`); assertEquals(payload, forecast); return Promise.resolve(); },
  };
  return { calls, reservation, forecast, store };
}
Deno.test("price experiment refuses production and unauthorized calls before reading inputs", async () => {
  const f = fixture();
  assertEquals((await createPriceExperimentHandler("https://production.supabase.co", f.store)(request())).status, 403);
  assertEquals(f.calls, []);
  assertEquals((await createPriceExperimentHandler(TEST, f.store)(request("wrong"))).status, 401);
  assertEquals(f.calls, ["verify"]);
});
Deno.test("price experiment pins actual evidence and commits unavailable results explicitly", async () => {
  const f = fixture();
  const handler = createPriceExperimentHandler(TEST, f.store, input => {
    assertEquals(input.knownAt, f.reservation.context.knownAt);
    assertEquals(input.actualIntervals, []);
    return f.forecast;
  });
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).status, "unavailable");
  assertEquals(f.calls, ["verify", "begin", "actual:actual", "complete:pair"]);
});
Deno.test("price experiment skips completed reservations and leaves failed pending work retryable", async () => {
  const f = fixture();
  f.reservation.status = "paired";
  const handler = createPriceExperimentHandler(TEST, f.store);
  assertEquals((await (await handler(request())).json()).status, "already_saved");
  assertEquals(f.calls, ["verify", "begin"]);
  f.reservation.status = "pending";
  f.store.actualIntervals = () => Promise.reject(new Error("private transport detail"));
  const response = await handler(request());
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "test_price_experiment_failed" });
  assertEquals(f.calls, ["verify", "begin", "verify", "begin"]);
});
