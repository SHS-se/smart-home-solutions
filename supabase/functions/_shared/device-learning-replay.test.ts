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

Deno.test("the refit publishes measured operating points for the pool's setting combination", async () => {
  const now = Date.UTC(2025, 0, 22);
  const input = syntheticPoolLearningReplay(now);
  input.claim.input.auxiliary_keys = ["synthetic-pump"];
  input.tables.energy_optimisation_devices = [
    { id: "synthetic-heater-id", device_key: "synthetic-heater" }, { id: "synthetic-pump-id", device_key: "synthetic-pump" }];
  // Synthetic heat meter at COP 4.5 and a pump at 80 % capacity drawing 410 W while the heater runs.
  input.tables.energy_optimisation_device_slots = (input.tables.energy_optimisation_device_slots as Record<string, unknown>[])
    .flatMap(row => {
      const kwh = Number(row.energy_kwh);
      return [{ ...row, power_setting: 12, heat_kwh: kwh * 4.5 },
        { start_ts: row.start_ts, device_id: "synthetic-pump-id", energy_kwh: kwh > 0 ? .1025 : 0, power_setting: 80, heat_kwh: null }];
    });
  const replay = createDeviceLearningReplay(input);
  const response = await handleDeviceLearning(new Request("https://synthetic.test/learn", {
    method: "POST", body: JSON.stringify({ job_id: input.claim.id }),
  }), replay.db, () => now);
  assertEquals(await response.json(), { published: true });
  const model = replay.publications[0].p_model as Record<string, unknown>;
  const learned = model.operating_points as { points: Record<string, unknown>[]; unbounded_sessions: number };
  // The first day's run starts before the window: it is not a whole session.
  assertEquals(learned.unbounded_sessions, 1);
  assertEquals(learned.points.length, 1);
  const [point] = learned.points;
  assertEquals(point.settings, { "synthetic-heater": 12, "synthetic-pump": 80 });
  assertEquals(point.heat_sessions, 20);
  assertEquals(point.electric_w, { "synthetic-heater": 3000, "synthetic-pump": 410 });
  assertEquals(point.cop, 4.5);
  // The thermal fit still sees only the heater, as before.
  assert((model.thermal_dynamics as { sample_count: number }).sample_count > 1000);
});
