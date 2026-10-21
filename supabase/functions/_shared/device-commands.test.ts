import { runRulesPlanner } from "./run-rules-planner.ts";
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { prepareRoomServices } from "./rules-room-services.ts";

import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";

Deno.test("schema 7 plans carry finite per-device commands in every scenario and final quarter", () => {
  const snapshot = commandSnapshot();
  const plan = runRulesPlanner({ snapshot: snapshot, now: (new Date(snapshot.captured_at)).toISOString(), price_archive: [] }).plan;
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
Deno.test("discrete relays remain full-quarter runs and impossible comfort warns without stopping service", () => {
  const snapshot = commandSnapshot();
  const zone = snapshot.thermal_zones![0];
  const result = prepareRoomServices(snapshot);
  assert(result.power.relay.every((w) => w === 0 || w === 1000));
  zone.start_temperature_c = 10;
  const limited = prepareRoomServices(snapshot);
  assert(limited.warnings.some(w => w.code === "comfort_shortfall"));
  assertEquals(limited.commands.thermostat.length, snapshot.slots.length);

});
Deno.test("unmodelled controls get a reason, never a command guessed from a forecast", () => {
  const snapshot = commandSnapshot();
  snapshot.thermal_zones = [];
  const plan = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }).plan;
  const commands = plan.plans.priority.slots[0].device_commands!;
  assertEquals(commands.relay.type, "unavailable");
  assertEquals(commands.thermostat.type, "unavailable");
});
