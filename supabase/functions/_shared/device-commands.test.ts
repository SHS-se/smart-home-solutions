import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  generateOptimisationPlan,
  type OptimisationSnapshot,
} from "./energy-optimisation.ts";
import { discreteRoomPlan } from "./discrete-room-plan.ts";
import { deviceCommands } from "./device-commands.ts";

import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";

Deno.test("schema 7 plans carry finite per-device commands in every scenario and final quarter", () => {
  const snapshot = commandSnapshot();
  const plan = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
  );
  assertEquals(plan.schema_version, 7);
  for (const scenario of Object.values(plan.plans)) {
    assertEquals(scenario.status, "ready");
    for (const slot of scenario.slots) {
      assertEquals(Object.keys(slot.device_commands!).sort(), [
        "relay",
        "thermostat",
      ]);
      assertEquals(slot.device_commands!.relay.type, "switch_schedule");
      const c = slot.device_commands!.thermostat;
      assert(c.type === "setpoint" && Number.isFinite(c.target_c));
      const relay = slot.device_commands!.relay;
      assert(relay.type === "switch_schedule");
      assertEquals(
        slot.device_loads_w.relay,
        relay.on_seconds === 900 ? 1000 : 0,
      );
    }
  }
});
Deno.test("discrete relays remain full-quarter runs and impossible comfort fails explicitly", () => {
  const snapshot = commandSnapshot();
  const zone = snapshot.thermal_zones![0];
  const result = discreteRoomPlan(snapshot, zone, zone.unplanned_power_w)!;
  assert(result.devicePower.relay.every((w) => w === 0 || w === 1000));
  zone.start_temperature_c = 10;
  assertThrows(
    () => discreteRoomPlan(snapshot, zone, zone.unplanned_power_w),
    Error,
    "no feasible",
  );
});
Deno.test("unmodelled controls get a reason, never a command guessed from a forecast", () => {
  const snapshot = commandSnapshot();
  snapshot.thermal_zones = [];
  const commands = deviceCommands(snapshot, {
    index: 0,
    roomHeating: {},
    relayPower: {},
    boilerPermitted: true,
    poolW: 0,
    evCurrentA: 0,
  });
  assertEquals(commands.relay.type, "unavailable");
  assertEquals(commands.thermostat.type, "unavailable");
});
