import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  learnDoorwayExchange,
  selectDoorwayExchange,
} from "./doorway-exchange.ts";
import {
  doorwayBoundary,
  readRoomDoorwayModel,
} from "../../planner/models/room/doorway-boundary.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";

const Q = 900_000;
const model: ThermalZoneModel = {
  gain_c_per_wh: .001,
  cooling_constant_per_h: .1,
  house_coupling_per_h: .3,
  background_gain_c_per_h: .5,
  thermal_capacity_wh_per_c: 1000,
  heat_loss_w_per_c: 400,
  time_constant_h: 2.5,
  heating_rate_c_per_h: .5,
  r2: 0,
  sample_count: 0,
  residual_std_c: 0,
};

function synthetic(first: number, second: number) {
  const a = new Map<number, number>();
  const b = new Map<number, number>();
  let temperature = 20;
  const rows = Array.from({ length: 96 * 12 }, (_, i) => {
    const time = i * Q;
    const left = 20 + 3 * Math.sin(i / 52);
    const right = 20 + 4 * Math.cos(i / 87);
    const heat = i % 96 < 30 ? 500 : 0;
    // Independently integrate the plant at one-second steps.
    let total = 0;
    for (let s = 0; s < 900; s++) {
      const rate = .001 * heat + .1 * (10 - temperature) +
        .3 * (20 - temperature) +
        first * (left - 20) + second * (right - 20) + .5;
      total += temperature + rate / 7200;
      temperature += rate / 3600;
    }
    a.set(time, left);
    b.set(time, right);
    return {
      start_ms: time,
      room_c: total / 900,
      house_c: 20,
      heat_w: heat,
      cooling: false,
      outdoor_c: 10,
      solar_w_per_m2: 0,
    };
  });
  return {
    rows,
    peers: [{ key: "left", source: "a", observed: a }, {
      key: "right",
      source: "b",
      observed: b,
    }],
  };
}

Deno.test("steady doorway learner jointly partitions the room's indoor exchange", () => {
  const { rows, peers } = synthetic(.17, .10);
  const fit = learnDoorwayExchange(rows, peers, model);
  assertEquals(fit.map((p) => p.key), ["left", "right"]);
  assertAlmostEquals(fit[0].weight, .17, .002);
  assertAlmostEquals(fit[1].weight, .10, .002);
  const overflow = synthetic(.22, .22);
  assertAlmostEquals(
    learnDoorwayExchange(overflow.rows, overflow.peers, model)
      .reduce((total, peer) => total + peer.weight, 0),
    .30,
    .0001,
  );
});

Deno.test("the fitted exchange must beat the same baseline with past-only probe inputs", () => {
  const coupled = synthetic(.17, .10);
  assert(selectDoorwayExchange(coupled.rows, coupled.peers, model).length > 0);
  const isolated = synthetic(0, 0);
  assertEquals(selectDoorwayExchange(isolated.rows, isolated.peers, model), []);
});

Deno.test("a missing, disconnected or rebound neighbour cannot add exchange to the forecast", () => {
  const fitted = readRoomDoorwayModel({
    source: "receiver",
    peers: [
      { key: "left", source: "a", weight: .15, usual: 1, persistence: .5 },
    ],
  }, .3)!;
  const probe = {
    room_key: "target",
    other_key: "left",
    room_source: "receiver",
    other_source: "a",
    quarters: [[0, 25] as [number, number]],
  };
  const run = (probes: Parameters<typeof doorwayBoundary>[2]) =>
    doorwayBoundary(fitted, .3, probes, [20, 20, 20], [Q, 2 * Q, 3 * Q], Q);
  assertEquals(run([probe]), {
    temperatures: [21, 20.5, 20.25],
    incomplete: false,
  });
  assertEquals(run([{ ...probe, other_source: "new" }]), { incomplete: false });
  assertEquals(run([{ ...probe, room_source: "new" }]), { incomplete: false });
  assertEquals(run([{ ...probe, quarters: [] }]), { incomplete: true });
  assertEquals(run([]), { incomplete: false });
});
