// Independently generated synthetic equipment; no household replay data.
import { assertEquals } from "@std/assert";
import { poolLearningOwner, requestDeviceLearning, variablePowerLearningOwners, type LearningOwner } from "./device-model-store.ts";

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

Deno.test("mapped heater electricity retains the pool learning request and adds its circulation pump", () => {
  const pool = { volume_m3: 25 };
  const devices = [
    { key: "synthetic-compressor", active_power_w: 3000, planning_service: "pool", pool_role: "heater" as const },
    { key: "synthetic-pump", active_power_w: 400, planning_service: "pool", pool_role: "circulation" as const },
  ];
  assertEquals(poolLearningOwner(pool, devices), { kind: "pool", key: "pool",
    input: { volume_m3: 25, device_keys: ["synthetic-compressor"], auxiliary_keys: ["synthetic-pump"] } });
  // Without other members the request is exactly what it was.
  assertEquals(poolLearningOwner(pool, devices.slice(0, 1)), { kind: "pool", key: "pool",
    input: { volume_m3: 25, device_keys: ["synthetic-compressor"] } });
  assertEquals(poolLearningOwner(null, devices), null);
});

Deno.test("every variable-power device outside the pool is its own learning owner", () => {
  const devices = [
    { key: "synthetic-charger", control_type: "variable_power" },
    { key: "synthetic-pool-pump", control_type: "variable_power" },
    { key: "synthetic-heater", control_type: "variable_power" },
    { key: "synthetic-boiler", control_type: "permit_inhibit" },
    { key: "synthetic-unset", control_type: null },
  ];
  assertEquals(variablePowerLearningOwners(devices, new Set(["synthetic-pool-pump"])), [
    { kind: "device", key: "synthetic-charger", input: {} },
    { kind: "device", key: "synthetic-heater", input: {} },
  ]);
});
