import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deviceContractBreach,
  type IncomingDevice,
  roomMapping,
} from "./device-contract.ts";

// Matches mapping_report(pool_control=True) in the HA integration: the website
// retains setpoint as its planning type, but the local actuator is one switch.
const pool: IncomingDevice = {
  key: "sensor.pool_heater_energy",
  statistic_id: "sensor.pool_heater_energy",
  name: "Pool heater",
  category: "pool_heating",
  suggested_load_type: "duty_cycle",
  suggested_planning_role: "controllable",
  suggested_control_type: "setpoint",
  active_power_w: 2000,
  profile_sample_count: 96,
  inference: {},
  mapping_status: "ready",
  mapped_control_type: "setpoint",
  mapping_error: null,
  mapping_summary: {
    control_type: "setpoint",
    entity_count: 2,
    configured_fields: ["actuator_entity_ids", "power", "temperature_entity_id"],
    power_entity_name: "sensor.pool_heater_power",
    planning_service: "pool",
  },
};

Deno.test("pool switch summary passes ingest without inventing a room or temperature controls", () => {
  assertEquals(deviceContractBreach(pool, new Set()), null);
  assertEquals(roomMapping(pool), null);
  const onOff = { ...pool, mapped_control_type: "switch_schedule" as const };
  assertEquals(deviceContractBreach(onOff, new Set()), null);
});

Deno.test("room setpoint still requires complete room metadata", () => {
  const room = { ...pool, category: "heating", mapping_summary: {} };
  assertEquals(
    deviceContractBreach(room, new Set()),
    "mapping_summary.room_key/room_name/controlled_devices",
  );
  room.mapping_summary = {
    room_key: "living",
    room_name: "Living room",
    controlled_devices: ["Heater"],
  };
  assertEquals(deviceContractBreach(room, new Set()), null);
  assertEquals(roomMapping(room), {
    key: "living",
    name: "Living room",
    controlled_devices: ["Heater"],
  });
});

Deno.test("pool classification does not excuse incomplete room metadata or duplicate devices", () => {
  const partial = {
    ...pool,
    mapping_summary: { ...pool.mapping_summary, room_name: "Pool room" },
  };
  assertEquals(
    deviceContractBreach(partial, new Set()),
    "mapping_summary.room_key/room_name/controlled_devices",
  );
  assertEquals(
    deviceContractBreach(pool, new Set([pool.key])),
    "key (duplicate)",
  );
});
