import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitRoomMeans, type RoomMeanQuarter } from "./mean-observations.ts";
import { fitRoomWithPassiveHeat } from "./passive-heat.ts";

// Synthetic independent plant, integrated in one-second steps.
function observations() {
  let temperature = 20, applianceMemory = 0;
  const source = { device_key: "synthetic-observed-appliance", watts: new Map<number, number>() };
  const rows: RoomMeanQuarter[] = Array.from({ length: 96 * 6 }, (_, i) => {
    const start_ms = i * 900_000;
    const active = i % 96 >= 45 && i % 96 < 50 + i % 4;
    const watts = active ? 500 + (i % 3) * 60 : 0;
    source.watts.set(start_ms, watts);
    const floor = i % 7 < 3 ? 400 : 0;
    const house = 21 + Math.sin(i / 50);
    const outdoor = 8 + 4 * Math.cos(i / 72);
    let mean = 0;
    for (let second = 0; second < 900; second++) {
      const slope = 0.07 * (outdoor - temperature) + 0.15 * (house - temperature) +
        0.0015 * floor + 0.1 + 0.0006 * watts + 0.002 * applianceMemory;
      mean += temperature + slope / 7200;
      temperature += slope / 3600;
      applianceMemory += (watts - applianceMemory) / 0.5 / 3600;
    }
    return { start_ms, heat_w: floor, house_c: house, outdoor_c: outdoor, room_c: mean / 900, solar_w_per_m2: null, cooling: false };
  });
  return { rows, source };
}

Deno.test("monitored appliance learns both heat gains and lag on independent synthetic cycles", () => {
  const { rows, source } = observations();
  const result = fitRoomWithPassiveHeat(rows, 400, source);
  assert(result.passive && result.scores);
  assertEquals(result.room, fitRoomMeans(rows, 400), "appliance learning cannot change the floor calibration");
  assertEquals(result.scores.cycles, 6);
  assertEquals(result.passive.lag_h, 0.5);
  assertAlmostEquals(result.passive.direct_c_per_wh, 0.0006, 0.00002);
  assertAlmostEquals(result.passive.delayed_c_per_wh, 0.002, 0.00002);
  assert(result.scores.running.fitted < result.scores.running.baseline / 10);
  assert(result.scores.cooldown.fitted < result.scores.cooldown.baseline / 10);
});

Deno.test("gaps do not turn one complete cycle into validated appliance evidence or stop room learning", () => {
  const { rows, source } = observations();
  for (const [i, row] of rows.entries()) {
    if (i >= 96 && i % 96 === 53) source.watts.delete(row.start_ms);
  }
  const result = fitRoomWithPassiveHeat(rows, 400, source);
  assert(result.room.ok);
  assertEquals(result.passive, undefined);
});
