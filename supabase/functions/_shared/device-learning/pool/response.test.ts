import { assertEquals } from "@std/assert";
import { fitPoolDynamics, fitPoolDynamicsPair } from "./response.ts";
import { syntheticPoolHistory, syntheticPoolMeanHistory, SYNTHETIC_POOL_CAPACITY } from "../../pool-model-selection.fixture.ts";

Deno.test("same-call pool family comparison preserves both independent fits", () => {
  for (const observation of ["interval_start", "quarter_mean"] as const) {
    for (const recovery of [false, true]) {
      const samples = (observation === "quarter_mean" ? syntheticPoolMeanHistory(recovery) : syntheticPoolHistory(recovery)).slice(0, 14 * 96);
      const pair = fitPoolDynamicsPair(samples, SYNTHETIC_POOL_CAPACITY, observation);
      assertEquals(pair.constant, fitPoolDynamics(samples, SYNTHETIC_POOL_CAPACITY, "constant_gain", observation));
      assertEquals(pair.recovery, fitPoolDynamics(samples, SYNTHETIC_POOL_CAPACITY, "recovering_source", observation));
    }
  }
});

Deno.test("unidentified pool family comparison retains the same rejection evidence", () => {
  const pair = fitPoolDynamicsPair([], SYNTHETIC_POOL_CAPACITY, "quarter_mean");
  assertEquals(pair, { constant: { rejected: "unidentifiable", sample_count: 0 }, recovery: { rejected: "unidentifiable", sample_count: 0 } });
});
