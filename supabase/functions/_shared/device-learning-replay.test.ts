import { assert, assertEquals, assertThrows } from "@std/assert";
import { createDeviceLearningReplay } from "./device-learning-replay.ts";
import { handleDeviceLearning } from "./device-learning-worker.ts";
import { syntheticPoolLearningReplay } from "../../../tests/device-learning-cpu.fixture.ts";

Deno.test("full captured learning replays all pages and publishes with its explicit clock", async () => {
  const now = Date.UTC(2025, 0, 22);
  const input = syntheticPoolLearningReplay(now);
  const replay = createDeviceLearningReplay(input);
  const response = await handleDeviceLearning(new Request("https://synthetic.test/learn", {
    method: "POST", body: JSON.stringify({ job_id: input.claim.id }),
  }), replay.db, () => now);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { published: true });
  assertEquals(replay.failures, []);
  assertEquals(replay.publications.length, 1);
  const model = replay.publications[0].p_model as Record<string, unknown>;
  assertEquals(model.last_attempted_at, new Date(now).toISOString());
  const dynamics = model.thermal_dynamics as { sample_count: number; source: unknown };
  assert(dynamics.sample_count > 1000);
  assert(dynamics.source);
  assertEquals(replay.reads.filter(read => read.from !== undefined).map(read => read.from).sort((a, b) => a! - b!),
    [0, 0, 0, 1000, 1000, 1000, 2000, 2000, 2000, 2016, 2016, 2016]);
});

Deno.test("learning replay rejects uncaptured access instead of contacting a database", () => {
  const replay = createDeviceLearningReplay(syntheticPoolLearningReplay(Date.UTC(2025, 0, 22)));
  assertThrows(() => replay.db.from("uncaptured_table"), Error, "Uncaptured learning table");
  assertThrows(() => replay.db.rpc("uncaptured_write", {}), Error, "Uncaptured learning RPC");
});
