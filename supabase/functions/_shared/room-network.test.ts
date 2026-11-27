import { connectedRoomSnapshot as fixture } from "./room-network.fixture.ts";
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "@std/assert";
import {
  prepareRoomBatch,
  prepareRoomProposals,
  prepareRoomServices,
  type RoomPrices,
} from "./rules-room-services.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";

const prices = (s: OptimisationSnapshot): RoomPrices => ({
  import_sek_per_kwh: s.slots.map((_, i) => i < 4 ? .2 : 3),
  export_sek_per_kwh: s.slots.map(() => .1),
  surplus_w: s.slots.map(() => 0),
});

Deno.test("synthetic adaptive posterior changes native room commands and electrical demand", () => {
  const weak = fixture(false, .02), strong = fixture(false, .02);
  for (const [snapshot, rate] of [[weak, .02], [strong, .7]] as const) {
    const node = snapshot.room_network!.nodes[0];
    node.posterior = structuredClone(node.posterior);
    node.posterior.log_rates[0] = Math.log(rate);
    node.process_belief.hypotheses[0].posterior = node.posterior;
  }
  assertEquals(
    weak.room_network!.nodes[0].model,
    strong.room_network!.nodes[0].model,
    "same learned parameters and revision; only recent inferred state differs",
  );
  for (const snapshot of [weak, strong]) {
    const zone = snapshot.thermal_zones![0];
    zone.comfort_max_c = Array(16).fill(24);
    // A flexible comfort ceiling permits useful heat storage under uncertainty.
    // A genuine future comfort deadline makes cheap preheating useful only
    // when recently inferred neighbour transfer cannot cover that deadline.
    zone.target_c = zone.comfort_min_c = Array.from(
      { length: 16 },
      (_, i) => i < 8 ? 18 : 21,
    );
  }
  const a = prepareRoomServices(weak, [], Array(16).fill(4000), prices(weak));
  const b = prepareRoomServices(
    strong,
    [],
    Array(16).fill(4000),
    prices(strong),
  );
  assertNotEquals(a.commands, b.commands);
  assert(
    b.room_power["synthetic-a"].reduce((a, b) => a + b, 0) <
      a.room_power["synthetic-a"].reduce((a, b) => a + b, 0),
  );
  assertEquals(Object.keys(b.commands), ["synthetic-a-heater"]);
  assert(b.temperature["synthetic-a"].every(Number.isFinite));
});

Deno.test("later neighbour commands replay earlier thermostat demand and preserve final literal qualification", () => {
  const s = fixture(true), p = prices(s), headroom = Array(16).fill(4000);
  const first = prepareRoomBatch({
    snapshot: s,
    retained: [],
    headroom,
    prices: p,
  });
  const earlier = first.services.room_power["synthetic-a"].slice();
  let final = prepareRoomBatch(
    { snapshot: s, retained: [], headroom, prices: p },
    undefined,
    first,
  );
  while (final.network_work || final.forecast_pending) {
    final = prepareRoomBatch(
      { snapshot: s, retained: [], headroom, prices: p },
      undefined,
      final,
    );
  }
  assertNotEquals(earlier, final.services.room_power["synthetic-a"]);
  assertEquals(final.services, prepareRoomServices(s, [], headroom, p));
  const totals = (power: Record<string, number[]>) =>
    s.slots.map((_, i) =>
      Object.values(power).reduce((a, row) => a + row[i], 0)
    );
  const selected = totals(final.services.room_power),
    literal = totals(final.services.unplanned_power);
  assert(selected.every((w) => w <= 4000 + 1e-6));
  const cost = (watts: number[]) =>
    watts.reduce((sum, w, i) => sum + w * .00025 * p.import_sek_per_kwh[i], 0);
  const expectedShortfall = (values: Record<string, number[]>) =>
    Object.values(values).reduce(
      (sum, row) => sum + row.reduce((s, v) => s + v * .25, 0),
      0,
    );
  assert(
    expectedShortfall(final.services.expected_shortfall_c!) <=
      expectedShortfall(final.services.unplanned_expected_shortfall_c!) + 1e-8,
  );
  if (cost(selected) > cost(literal) + 1e-8) {
    let closes = false;
    for (const zone of s.thermal_zones!) {
      for (let i = 0; i < 16; i++) {
        const chosen = final.services.temperature[zone.key][i]! <
          zone.comfort_min_c[i] - 1e-6;
        const base = final.services.unplanned_temperature[zone.key][i]! <
          zone.comfort_min_c[i] - 1e-6;
        assert(!chosen || base);
        closes ||= base && !chosen;
      }
    }
    assert(closes);
  }
  for (let i = 0; i < 16; i++) {
    assertAlmostEquals(
      selected[i],
      Object.values(final.services.power).reduce((sum, row) => sum + row[i], 0),
      1e-9,
    );
  }
});

import {
  assembleConnectedRoomNodes,
} from "./room-network-capture.ts";
import type { PreparedRoom } from "./prepared-energy-forecasts.ts";

Deno.test("derived assembly keeps late, missing and unavailable-meter room services and repairs its current inference", () => {
  const s = fixture(false, .5),
    at = Date.parse(s.captured_at),
    from = at - 86400000;
  const raw: Array<
    { start: number; temperature: number[]; watts: number; outdoor: number }
  > = [];
  let t = [19, 27];
  for (let i = 0; i < 96; i++) {
    const watts = i % 12 < 5 ? 900 : 0,
      outdoor = 5 + Math.sin(i / 12),
      mean = [0, 0];
    for (let j = 0; j < 60; j++) {
      const next = [
        t[0] +
        .25 / 60 *
          (-.03 * (t[0] - outdoor) + .5 * (t[1] - t[0]) + .002 * watts),
        t[1] + .25 / 60 * (-.03 * (t[1] - outdoor) + .1 * (t[0] - t[1])),
      ];
      for (let k = 0; k < 2; k++) mean[k] += (t[k] + next[k]) / 120;
      t = next;
    }
    raw.push({ start: from + i * 900000, temperature: mean, watts, outdoor });
  }
  const rooms: PreparedRoom[] = s.room_network!.nodes.map((node) => ({
    key: node.key,
    name: node.key,
    device_keys: [],
    model: null,
    connected_exchange: node.model,
    rated_power_w: 0,
    maximum_power_w_by_slot: Array(16).fill(2000),
  }));
  const run = (mode: "complete" | "late" | "hole" | "counter") => {
    const captures = rooms.map((room,index) => ({
      room,
      model: {...room.connected_exchange!, process_belief:s.room_network!.nodes[index].process_belief},
      rows: raw.filter((_,i) => !(mode === "late" && i === 95) && !(mode === "hole" && i === 70)).map(row=>({
        start_ms:row.start, duration_s:900 as const, room_c:row.temperature[index], outdoor_c:row.outdoor,
        heat_w:mode === "counter" ? null : index === 0 ? row.watts : 0,
        solar_w_per_m2:0,cooling:false,
        peer_c:{"synthetic-a":row.temperature[0],"synthetic-b":row.temperature[1]},
      })),
    }));
    return assembleConnectedRoomNodes(s,captures,new Map());
  };
  const complete = run("complete");
  assertEquals(complete.nodes.length, 2, JSON.stringify(complete.warnings));
  for (const mode of ["late", "hole", "counter"] as const) {
    const result = run(mode);
    assertEquals(result.nodes.length, 2, mode);
    assert(
      result.nodes.every((node) => Number.isFinite(node.start_temperature_c)),
      mode,
    );
    assertEquals(
      result.nodes[0].model.thermal,
      rooms[0].connected_exchange!.thermal,
      "capture process identification preserves the published thermal body",
    );
  }
  const late = run("late");
  assert(late.warnings.some((w) => w.code === "room_state_boundary_late"));
  assertEquals(
    (run("complete")).nodes,
    complete.nodes,
    "a later complete capture repairs inferred state deterministically",
  );

});

Deno.test("an exact zero exchange edge needs no peer model", () => {
  const s = fixture(false, .1), node = s.room_network!.nodes[0];
  node.model.incoming = [{
    kind: "constant",
    from: "synthetic-absent",
    per_h: 0,
  }];
  node.posterior.log_rates = [];
  node.posterior.covariance = [[.01, 0], [0, 0]];
  node.process_belief.hypotheses = [{
    replica: 0,
    multiplicity: 1,
    hazards: node.model.incoming.map(() => ({ shape: 1, rate_h: 1 })),
    log_weight: 0,
    incoming: node.model.incoming,
    posterior: node.posterior,
    thermal_state_identified: true,
  }];
  s.room_network!.nodes = [node];
  const result = prepareRoomServices(s, [], Array(16).fill(4000), prices(s));
  assert(result.temperature[node.key].every(Number.isFinite));
  assert(!result.warnings.some((w) => w.code === "room_evidence_unavailable"));
});

Deno.test("a malformed connected component resets its earlier thermal forecasts without stopping an unrelated room", () => {
  const s = fixture(true), p = prices(s), headroom = Array(16).fill(6000);
  const other = structuredClone(s.thermal_zones![0]);
  other.key = "synthetic-independent";
  other.device_keys = ["synthetic-independent-heater"];
  const device = structuredClone(s.device_models[0]);
  device.key = other.device_keys[0];
  s.device_models.push(device);
  s.thermal_zones!.push(other);
  const first = prepareRoomBatch({
    snapshot: s,
    retained: [],
    headroom,
    prices: p,
  });
  assert(first.services.temperature["synthetic-a"].every(Number.isFinite));
  s.room_network!.nodes[1].model.thermal.outdoor_per_h = NaN;
  const second = prepareRoomBatch(
    { snapshot: s, retained: [], headroom, prices: p },
    undefined,
    first,
  );
  const final = prepareRoomBatch(
    { snapshot: s, retained: [], headroom, prices: p },
    undefined,
    second,
  );
  for (const key of ["synthetic-a", "synthetic-b"]) {
    assertEquals(final.services.temperature[key], Array(16).fill(null));
    assertEquals(final.services.room_power[key], Array(16).fill(500));
    assert(
      final.services.warnings.some((w) =>
        w.scope === key && w.code === "room_evidence_unavailable"
      ),
    );
  }
  assert(
    final.services.temperature["synthetic-independent"].every(Number.isFinite),
  );
});

Deno.test("connected commands share electrical headroom under constrained comfort", () => {
  const s = fixture(true),
    result = prepareRoomServices(s, [], Array(16).fill(2000), prices(s));
  assert(
    Object.values(result.temperature).every((row) =>
      row.every(Number.isFinite)
    ),
  );
  for (let i = 0; i < 16; i++) {
    assert(
      Object.values(result.room_power).reduce((sum, row) => sum + row[i], 0) <=
        2000 + 1e-6,
    );
  }
});

Deno.test("connected exchange does not bypass sparse-heater evidence", () => {
  const s = fixture(false, .3);
  s.room_network!.nodes[0].model.evidence.heater_identified = false;
  const result = prepareRoomServices(s, [], Array(16).fill(4000), prices(s));
  assertEquals(result.temperature["synthetic-a"], Array(16).fill(null));
  assertEquals(result.room_power["synthetic-a"], Array(16).fill(500));
});

Deno.test("fixed empirical peer heat follows available devices, retained switches and forecast weather in either room order", () => {
  const s = fixture(true);
  const room = s.thermal_zones![1], member = s.device_models[1];
  delete member.thermostat;
  const relay = { ...member, key: "synthetic-peer-relay", control_type: "switch_schedule" as const,
    active_power_w: 600, relay_on: false, forecast_w_by_slot: s.slots.map(() => 80) };
  room.device_keys.push(relay.key);
  s.device_models.push(relay);
  const index = 2;
  s.execution_availability = [{ owner: member.key, status: "temporarily_absent", cause: "synthetic",
    blocked_intervals: [{ start: s.slots[index].start, end: s.slots[index + 1].start }] }];
  const retained = [0, 900].map(on_seconds => ({
    device_commands: { [relay.key]: { type: "switch_schedule" as const, on_seconds } },
  }));
  const heater = s.room_network!.nodes[1].model.thermal.heater!;
  heater.gain_outdoor_slope_per_c = .1;
  s.outdoor_temperature_c![1] = heater.gain_reference_outdoor_c + 2;
  const headroom = s.slots.map(() => 4000);
  const capture = () => prepareRoomProposals({ snapshot: s, retained, headroom, prices: prices(s) }, undefined, null, Infinity);
  const original = capture();
  s.thermal_zones!.reverse();
  const reversed = capture();
  for (const { progress, forecast } of [original, reversed]) {
    const { network } = forecast!.nativeInput;
    const { services } = progress;
    const electrical = s.slots.map((_, i) => i === 0 ? 500 : i === 1 ? 1100 : 580);
    const thermal = electrical.map((w, i) => i === index ? w - 500 : w);
    assertEquals(network.rooms.map(r => r.node), [0]);
    assertEquals(network.fixed_heaters, [{ node: 1, watts: thermal }]);
    assertAlmostEquals(network.nodes[1].gain_c_per_wh[1], heater.gain_c_per_wh * 1.2);
    assertEquals(services.room_power[room.key], electrical);
    assertEquals(network.headroom_w, electrical.map(w => 4000 - w));
    assertEquals(services.temperature[room.key], s.slots.map(() => null));
    assertEquals(services.commands[relay.key].slice(0, 2), retained.map(r => r.device_commands[relay.key]));
    assertEquals(services.commands[member.key][index].type, "unavailable");
  }
  assertEquals(original.progress.network_plans, reversed.progress.network_plans);
});

Deno.test("a sparse connected peer retains literal comfort and excludes its heater from the joint heat input", () => {
  for (const warningOnly of [false, true]) {
    const s = fixture(true), peer = s.thermal_zones![1];
    peer.model_source = {kind: "shared", revision: "synthetic-response"};
    peer.unplanned_power_w = s.slots.map(() => 720);
    if (warningOnly) peer.model_warnings = ["insufficient_heating"];
    else s.room_network!.nodes[1].model.evidence.heater_identified = false;
    const { progress, forecast } = prepareRoomProposals({ snapshot: s, retained: [], prices: prices(s) }, undefined, null, Infinity);
    assertEquals(forecast!.nativeInput.network.fixed_heaters, []);
    assertEquals(forecast!.nativeInput.network.rooms.map(r => r.node), [0]);
    assertEquals(progress.services.temperature[peer.key], s.slots.map(() => null));
    assertEquals(progress.services.room_power[peer.key], s.slots.map(() => 500));
    const warning = progress.services.warnings.find(w => w.scope === peer.key && w.consequence.includes("omit additional heat"));
    assert(warning);
    assertEquals(warning.message.includes("too few measured"), warningOnly);
    assertEquals(progress.services.unplanned_power[peer.key], s.slots.map(() => warningOnly ? 500 : 720));
    assertEquals(!!progress.services.heating_model_use![peer.key].baseline, !warningOnly);
    for (const [i, command] of progress.services.commands[peer.device_keys[0]].entries()) {
      assert(command.type === "setpoint");
      assertEquals(command.room_target_c, peer.target_c[i]);
    }
  }
});

Deno.test("Off thermostat keeps the supported target grid and historical draw in a standalone room", () => {
  const s = fixture(), member = s.device_models[0], zone = s.thermal_zones![0];
  delete s.room_network;
  member.thermostat = {...member.thermostat!, hvac_action: "off", minimum_c: 5, maximum_c: 28, step_c: 1};
  zone.target_c.fill(20.6);
  zone.unplanned_power_w.fill(890);
  const rooms = prepareRoomServices(s);
  assertEquals(rooms.temperature[zone.key], s.slots.map(() => null));
  assertEquals(rooms.power[member.key], member.forecast_w_by_slot);
  assertEquals(rooms.unplanned_power[zone.key], member.forecast_w_by_slot);
  assertEquals(rooms.commands[member.key][0], {type: "setpoint", target_c: 21, room_target_c: 20.6, minimum_c: 5, maximum_c: 28});
  assert(rooms.warnings.some(w => w.scope === zone.key && w.message.includes("Off mode")));
});

Deno.test("synthetic Off thermostat activation requires a heating owner and advertised Heat support", () => {
  for (const mode of ["controlling", "control_verification", "planning", "monitoring"] as const) {
    const s = fixture(true), peer = s.thermal_zones![1], unit = s.device_models[1];
    const active = mode === "controlling" || mode === "control_verification";
    s.operating_scope = {modes: {"synthetic-owner": mode}, device_owners: {[unit.key]: "synthetic-owner"}, external_demands: {}};
    unit.thermostat = {...unit.thermostat!, hvac_action: "off", can_activate_heat: true};
    const capture = () => prepareRoomProposals({snapshot: s, retained: [], prices: prices(s)}, undefined, null, Infinity);
    const network = capture().forecast!.nativeInput.network;
    assertEquals(network.rooms.map(room => room.node), active ? [0, 1] : [0]);
    if (active) assertEquals(network.rooms[1].input.thermostats[0].hvac_action, "off");
    unit.thermostat.can_activate_heat = false;
    assertEquals(capture().forecast!.nativeInput.network.rooms.map(room => room.node), [0]);
    unit.thermostat.can_activate_heat = true;
    delete s.room_network;
    const scalar = prepareRoomServices(s);
    assertEquals(scalar.temperature[peer.key].every(Number.isFinite), active);
    if (active) {
      unit.thermostat.hvac_action = "idle";
      assertEquals(prepareRoomServices(s).room_power[peer.key], scalar.room_power[peer.key]);
      unit.thermostat.hvac_action = "off";
      unit.category = "other";
      assertEquals(prepareRoomServices(s).temperature[peer.key], s.slots.map(() => null));
    }
  }
});

Deno.test("a connected Off thermostat preserves its facts and only the other heater contributes new peer heat", () => {
  const s = fixture(true), peer = s.thermal_zones![1], unit = s.device_models[1];
  const thermostat = { ...unit.thermostat!, hvac_action: "off" as const, minimum_c: 7, maximum_c: 28, step_c: 1 };
  unit.thermostat = thermostat;
  peer.target_c.fill(22.7);
  const capture = () => prepareRoomProposals({snapshot: s, retained: [], prices: prices(s)}, undefined, null, Infinity);
  const alone = capture();
  assertEquals(alone.forecast!.nativeInput.network.rooms.map(r => r.node), [0]);
  assertEquals(alone.forecast!.nativeInput.network.fixed_heaters, []);
  assertEquals(alone.progress.services.temperature[peer.key], s.slots.map(() => null));
  assertEquals(alone.progress.services.commands[unit.key][0],
    {type: "setpoint", target_c: 23, room_target_c: 22.7, minimum_c: 7, maximum_c: 28});
  const other = { ...unit, key: "synthetic-peer-relay", control_type: "switch_schedule" as const,
    relay_on: false, forecast_w_by_slot: s.slots.map(() => 120), thermostat: null };
  s.device_models.push(other);
  peer.device_keys.push(other.key);
  const mixed = capture();
  assertEquals(mixed.forecast!.nativeInput.network.fixed_heaters, [{node: 1, watts: other.forecast_w_by_slot}]);
  assertEquals(mixed.progress.services.room_power[peer.key], s.slots.map(() => 620));
  assertEquals(unit.thermostat, thermostat);
  unit.thermostat = { ...thermostat, hvac_action: "idle" };
  const resumed = capture();
  assertEquals(resumed.forecast!.nativeInput.network.rooms.map(r => r.node), [0, 1]);
  assertEquals(resumed.forecast!.nativeInput.network.fixed_heaters, []);
});

import { applyConnectedRoomCapture } from "./room-model-capture.ts";
import { readRoomHeatingBands } from "./planner/heating-bands.ts";

Deno.test("staged capture installs current state without bypassing heater support", () => {
  for (const supported of [true, false]) {
    const s = fixture(false, .1),
      node = s.room_network!.nodes[0],
      zone = s.thermal_zones![0];
    node.model.evidence.heater_identified = supported;
    s.room_network_capture = {
      rooms: [{ ...zone, connected_exchange: node.model }],
      observations: [],
    };
    zone.model = null;
    const applied = applyConnectedRoomCapture(s, s.room_network!.nodes, []);
    assertEquals("room_network_capture" in applied, false);
    assertEquals(!!applied.thermal_zones![0].model, supported);
    assertEquals(
      applied.thermal_zones![0].start_temperature_c,
      node.start_temperature_c,
    );
  }
});

Deno.test("an observed-only published response preserves its null heater and null scalar model", () => {
  const s = fixture(false), node = s.room_network!.nodes[1];
  const library = readRoomHeatingBands({
    binding: "synthetic",
    since: s.captured_at,
    reference_revision: "synthetic-v1",
    active: [],
    candidates: [],
    attempted: {},
    reference: {
      model: null,
      scope: { kind: "shared" },
      connected_exchange: node.model,
    },
  });
  assert(library?.reference);
  assertEquals(library.reference.model, null);
  assertEquals(library.reference.connected_exchange?.thermal.heater, null);
});

Deno.test("unprepared room relays contribute no optional future heat", () => {
  const s = fixture(true),
    device = s.device_models[1],
    node = s.room_network!.nodes[1],
    zone = s.thermal_zones![1];
  device.control_type = "switch_schedule";
  device.relay_on = true;
  delete device.thermostat;
  node.start_temperature_c = -5;
  zone.start_temperature_c = -5;
  const first = prepareRoomBatch({
    snapshot: s,
    retained: [],
    headroom: Array(16).fill(4000),
    prices: prices(s),
  });
  assertEquals(first.network_plans![zone.key].power_w, Array(16).fill(0));
});

Deno.test("an unobserved prior cannot fabricate a capture temperature", () => {
  const snapshot = fixture(false), node = snapshot.room_network!.nodes[0];
  node.model.reference_state.observations = 0;
  const room: PreparedRoom = {
    key: node.key,
    name: node.key,
    device_keys: [],
    model: null,
    connected_exchange: node.model,
    rated_power_w: 0,
    maximum_power_w_by_slot: [],
  };
  const result = assembleConnectedRoomNodes(snapshot, [{
    room,
    model: node.model,
    rows: [],
  }], new Map());
  assertEquals(result.nodes, []);
  assert(result.warnings.some((w) => w.code === "room_evidence_unavailable"));
});

Deno.test("an observed accepted posterior anchors bounded state when a fresh process prior has no rows", () => {
  const snapshot = fixture(false), node = snapshot.room_network!.nodes[0];
  const room: PreparedRoom = {
    key: node.key,
    name: node.key,
    device_keys: [],
    model: null,
    connected_exchange: structuredClone(node.model),
    rated_power_w: 0,
    maximum_power_w_by_slot: [],
  };
  const fresh = structuredClone(node.model);
  fresh.reference_state.observations = 0;
  fresh.reference_state.temperature_c = 0;
  fresh.incoming = [];
  fresh.reference_state.log_rates = [];
  fresh.reference_state.covariance = [[0, 0], [0, 0]];
  const result = assembleConnectedRoomNodes(snapshot, [{
    room,
    model: fresh,
    rows: [],
  }], new Map());
  assertEquals(result.nodes.length, 1);
  assertEquals(result.nodes[0].initial_state, "bounded_thermal");
  assert(result.nodes[0].start_temperature_c > 0);
  assert(
    result.nodes[0].start_temperature_c <=
      room.connected_exchange!.reference_state.temperature_c,
  );
});
