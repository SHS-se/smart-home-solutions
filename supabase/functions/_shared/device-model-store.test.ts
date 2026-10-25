// Independently generated synthetic equipment; no household replay data.
import { assertEquals } from "@std/assert";
import { poolLearningOwner, requestDeviceLearning, type LearningOwner } from "./device-model-store.ts";

Deno.test("pool telemetry without a mapped heating meter omits only its learning owner", async () => {
  const pool = { volume_m3: 25, water_temperature_c: 24 };
  const devices = [{ key: "synthetic-room-heater", active_power_w: 700, planning_service: "room" }];
  const before = structuredClone({ pool, devices });
  const room: LearningOwner = { kind: "room", key: "synthetic-room", input: { location: null } };
  const owner = poolLearningOwner(pool, devices);
  assertEquals(owner, null);
  let submitted: Record<string, unknown> | undefined;
  await requestDeviceLearning({ rpc(name, args) {
    assertEquals(name, "request_energy_device_learning");
    submitted = args;
    return Promise.resolve({ data: 1, error: null });
  } }, "synthetic-home", "synthetic-customer", [room, ...(owner ? [owner] : [])]);
  assertEquals(submitted?.p_owners, [room]);
  // Learning availability never removes telemetry or equipment from planning.
  assertEquals({ pool, devices }, before);
});

Deno.test("mapped heater electricity retains the existing pool learning request", () => {
  const pool = { volume_m3: 25 };
  const devices = [
    { key: "synthetic-compressor", active_power_w: 3000, planning_service: "pool", pool_role: "heater" as const },
    { key: "synthetic-pump", active_power_w: 400, planning_service: "pool", pool_role: "circulation" as const },
  ];
  assertEquals(poolLearningOwner(pool, devices), { kind: "pool", key: "pool",
    input: { volume_m3: 25, device_keys: ["synthetic-compressor"] } });
  assertEquals(poolLearningOwner(null, devices), null);
});
