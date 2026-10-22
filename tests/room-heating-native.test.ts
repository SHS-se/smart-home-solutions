import { assertEquals } from "@std/assert";
import vectors from "./room-heating-native.fixture.json" with { type: "json" };
import { planRoomHeating, type RoomQuarter } from "../supabase/functions/_shared/room-heating-schedule.ts";
import type { RoomThermostat } from "../supabase/functions/_shared/planner/thermostat.ts";

// Captured from the original TypeScript search before moving it into Wasm.
// These preserve full actions and trajectories, independently of the new code.
for (const { name, input, plan } of vectors) {
  Deno.test(`native room search preserves original ${name}`, () => {
    assertEquals(planRoomHeating(input.start_c, input.thermostats as RoomThermostat[],
      input.quarters as RoomQuarter[], input.start_delivered_w), plan);
  });
}
