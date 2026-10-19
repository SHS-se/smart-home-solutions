import { assertEquals } from "jsr:@std/assert@1";
import { plannedThermalRooms, roomModelStatus, zoneRefitIsDue } from "./thermal-training.ts";

const NOW = Date.parse("2026-10-19T17:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

Deno.test("trained rooms refit once a day", () => {
  const attempts = [{ room_key: "bedroom", trained: true, last_attempted_at: ago(3) }];
  assertEquals(zoneRefitIsDue(NOW, attempts, ["bedroom"]), false);
  assertEquals(zoneRefitIsDue(NOW, [{ ...attempts[0], last_attempted_at: ago(25) }], ["bedroom"]), true);
  assertEquals(zoneRefitIsDue(NOW, [], ["bedroom"]), true);
});

Deno.test("a planned room without a trained model is retried hourly", () => {
  // The bathroom was mapped after the bedroom's daily fit: its history should
  // not wait the rest of that day.
  const attempts = [{ room_key: "bedroom", trained: true, last_attempted_at: ago(3) }];
  assertEquals(zoneRefitIsDue(NOW, attempts, ["bedroom", "master_bathroom"]), true);
  // A failed attempt half an hour ago waits for the hour.
  const untrained = [...attempts, { room_key: "master_bathroom", trained: false, last_attempted_at: ago(0.5) }];
  assertEquals(zoneRefitIsDue(NOW, untrained, ["bedroom", "master_bathroom"]), false);
  assertEquals(zoneRefitIsDue(NOW, untrained.map((a) => ({ ...a, last_attempted_at: ago(2) })),
    ["bedroom", "master_bathroom"]), true);
});

Deno.test("each planned room reports its model, or why it has none", () => {
  const device = (key: string, name: string, role = "controllable") => ({
    mapping_summary: { room_key: key, room_name: name }, planning_role_override: role,
    control_type_override: "setpoint", mapping_status: "ready", mapped_control_type: "setpoint",
  });
  // Base-load rooms are not fitted, and two heaters in one room are one room.
  const rooms = plannedThermalRooms([device("bath", "Bathroom"), device("bath", "Bathroom"),
    device("bed", "Bedroom"), device("kitchen", "Kitchen", "base_load"), device("office", "Office")]);
  assertEquals(rooms.map((room) => room.key), ["bath", "bed", "office"]);
  assertEquals(roomModelStatus(rooms, [
    { room_key: "bath", trained: true, last_fit_attempt: { issues: ["insufficient_heating", "made_up"] } },
    { room_key: "bed", trained: false, last_fit_attempt: { issues: ["insufficient_samples"] } },
  ]).map(({ key, status, issues }) => ({ key, status, issues })), [
    { key: "bath", status: "limited", issues: ["insufficient_heating"] },
    { key: "bed", status: "unidentified", issues: ["insufficient_samples"] },
    { key: "office", status: "waiting", issues: ["waiting"] },
  ]);
});
