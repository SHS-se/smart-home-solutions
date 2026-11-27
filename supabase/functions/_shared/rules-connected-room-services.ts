import { sha256 } from "@noble/hashes/sha2.js";
import { commandOwner, unavailableOwner } from "./rules-commitments.ts";
import { connectedRoomHeaterSupported } from "./planner/room-response.ts";
import {
  MAX_ROOM_RELAYS,
  type RoomHeatingPlan,
} from "./room-heating-schedule.ts";
import {
  connectedProcessWeightedHypotheses,
  forecastConnectedExchange,
} from "./planner/models/room/connected-exchange.ts";
import { connectedRoomDependencies, type ConnectedRoomPlanningNode, type ConnectedRoomForecastIdentity } from "./planner/models/room/network.ts";
import { roomPlanClock } from "./planner/models/room/state.ts";
import { isThermostat } from "./planner/thermostat.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import {
  compileRoomSchedule,
  storeRoomCommands,
} from "./room-scheduling-inputs.ts";
import type {
  RoomPlanningInputs,
  RoomServices,
  Zone,
} from "./rules-room-services.ts";
import type { PlanningTrace } from "./planning-trace.ts";
import { planningWarning } from "./planner/planning-warnings.ts";
import {
  connectedForecastTarget,
  type NativeRoomNetworkBelief,
  type NativeRoomNetworkInput,
  type NativeRoomNetworkOutput,
  type NativeRoomNetworkProposal,
  type NativeRoomNetworkReplicaWork,
  type NativeRoomReplica,
  type NativeRoomNetworkSelectedHypothesis,
  ROOM_NETWORK_WORK_REVISION,
  type RoomNetworkWork,
} from "./room-network-contract.ts";

/** A proposal uses winner physics and exact dependency order. The execution archive owns the populations. */
export type ConnectedRoomProposalNode = Omit<ConnectedRoomPlanningNode, "process_belief"> & {
  required_peers: string[]; hypothesis_peers: string[];
};
export interface ConnectedRoomProposalNetwork { forecast: ConnectedRoomForecastIdentity; nodes: ConnectedRoomProposalNode[] }
export function proposalDependencies(node: ConnectedRoomPlanningNode | ConnectedRoomProposalNode) {
  return "required_peers" in node ? node.required_peers : connectedRoomDependencies(node);
}
/** The final barrier includes disconnected identified thermal rooms using their
 * original compiled transitions. Empirical-only demand remains a fixed ledger
 * entry. Thus later stochastic demand cannot invalidate an interleaved room. */
function compileNetwork(
  inputs: RoomPlanningInputs,
  zone: Zone | null,
  result: RoomServices,
  accepted: Record<string, RoomHeatingPlan> | undefined,
  disabled: ReadonlySet<string>,
) {
  const { snapshot, retained, prices } = inputs,
    network = inputs.proposal_network ?? snapshot.room_network;
  if (
    snapshot.schema_version < 12 || !network ||
    (zone && !network.nodes.some((node) => node.key === zone.key))
  ) return;
  const nodes = network.nodes.filter((node) => !disabled.has(node.key));
  const nodeIndex = new Map(nodes.map((node, index) => [node.key, index]));
  const zones = (snapshot.thermal_zones ?? []).filter((room) => {
    const node = nodeIndex.get(room.key);
    const supported = node === undefined
      ? zone === null && !!accepted?.[room.key]
      : connectedRoomHeaterSupported(nodes[node].model);
    return supported && room.model && room.start_temperature_c !== null &&
      snapshot.device_models.filter((m) =>
          room.device_keys.includes(m.key) &&
          m.control_type === "switch_schedule"
        ).length <= MAX_ROOM_RELAYS &&
      snapshot.device_models.filter((m) => room.device_keys.includes(m.key))
        .every((m) =>
          (m.active_power_w ?? 0) > 0 &&
          !snapshot.slots.some((slot) =>
            unavailableOwner(snapshot, commandOwner(snapshot, m), slot.start)
          ) &&
          (m.control_type === "setpoint"
            ? isThermostat(m.thermostat)
            : m.control_type === "switch_schedule" &&
              m.category === "heating" && typeof m.relay_on === "boolean")
        );
  });
  const stage = zone
    ? zones.findIndex((room) => room.key === zone.key)
    : zones.length - 1;
  if (stage < 0) return;
  for (const room of zones) {
    if (!nodeIndex.has(room.key)) nodeIndex.set(room.key, nodeIndex.size);
  }
  const clock = roomPlanClock(snapshot),
    n = snapshot.slots.length,
    included = new Set(zones.map((room) => room.key));
  const headroom = inputs.headroom?.slice() ?? Array(n).fill(Number.MAX_VALUE),
    surplus = prices?.surplus_w.slice() ?? Array(n).fill(0);
  for (const room of snapshot.thermal_zones ?? []) {
    if (zone && room.key === zone.key) break;
    if (included.has(room.key)) continue;
    for (let i = 0; i < n; i++) {
      headroom[i] = Math.max(
        0,
        headroom[i] - (result.room_power[room.key]?.[i] ?? 0),
      );
      surplus[i] = Math.max(
        0,
        surplus[i] - (result.room_power[room.key]?.[i] ?? 0),
      );
    }
  }
  const compiled = zones.map((room) => {
    const devices = snapshot.device_models.filter((m) =>
        room.device_keys.includes(m.key)
      ),
      thermostats = devices.filter((m) => m.control_type === "setpoint");
    const relays = devices.filter((m) => m.control_type === "switch_schedule")
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return {
      zone: room,
      members: thermostats,
      relays,
      ...compileRoomSchedule(
        snapshot,
        room,
        thermostats,
        relays,
        retained,
        headroom,
        surplus,
        prices,
        result,
      ),
    };
  });
  let elapsed = 0;
  const offsets = clock.hours.map((hours) => {
    const start = elapsed;
    elapsed += hours;
    return start;
  });
  const nativeNodes: NativeRoomNetworkInput["nodes"] = nodes.map((node) => {
    const response = node.model,
      thermal = response.thermal,
      heater = thermal.heater;
    const incomingPeers = zone ? response.incoming.map(edge => edge.from)
      : "hypothesis_peers" in node ? node.hypothesis_peers : node.process_belief.hypotheses.flatMap(h => h.incoming.map(edge => edge.from));
    const requiredPeers = new Set(proposalDependencies(node));
    const peerKeys = [...new Set([...incomingPeers, ...requiredPeers])];
    const topology = peerKeys.flatMap((from) => {
      const index = nodeIndex.get(from);
      if (index === undefined) {
        if (
          requiredPeers.has(from)
        ) {
          throw new Error(
            `Connected room ${node.key} has no supported peer ${from}`,
          );
        }
        return [];
      }
      return [{ from, index }];
    });
    return {
      key: node.key,
      start_c: node.start_temperature_c,
      start_stored_heat_c: node.start_stored_heat_c,
      outdoor_per_h: thermal.outdoor_per_h,
      lag_h: heater?.lag_h ?? 0,
      gain_c_per_wh: clock.hours.map((_, i) =>
        heater
          ? heater.gain_c_per_wh *
            Math.max(
              0,
              1 +
                heater.gain_outdoor_slope_per_c *
                  (snapshot.outdoor_temperature_c![i]! -
                    heater.gain_reference_outdoor_c),
            )
          : 0
      ),
      forcing_c_per_h: clock.hours.map((_, i) =>
        thermal.outdoor_per_h * snapshot.outdoor_temperature_c![i]! +
        thermal.background_per_h +
        thermal.solar_per_wm2_h * (snapshot.solar_irradiance_w_per_m2?.[i] ?? 0)
      ),
      incoming: topology.map(({ from, index }) => ({
        node: index,
        rates: zone
          ? clock.hours.map((hours, i) => {
            const steps = Math.ceil(hours * 60),
              edge = response.incoming.findIndex((edge) => edge.from === from);
            return Array.from({ length: steps }, (_, minute) =>
              edge < 0 ? 0 : forecastConnectedExchange(
                response,
                node.posterior,
                offsets[i] + (minute + .5) * hours / steps,
              )[edge]);
          })
          : [[0]],
      })),
    };
  });
  for (const room of compiled) {
    if (!nodes.some((node) => node.key === room.zone.key)) {
      nativeNodes.push({
        key: room.zone.key,
        start_c: room.zone.start_temperature_c!,
        start_stored_heat_c: room.zone.start_stored_heat_c ?? 0,
        outdoor_per_h: 0,
        lag_h: 0,
        gain_c_per_wh: Array(n).fill(0),
        forcing_c_per_h: Array(n).fill(0),
        incoming: [],
        legacy_steps: room.quarters.map((q) => ({
          step: q.step,
          memory_scale: q.memory_scale ?? null,
        })),
      });
    }
  }
  const native: NativeRoomNetworkInput = {
    nodes: nativeNodes,
    rooms: compiled.map((room) => ({
      node: nodeIndex.get(room.zone.key)!,
      input: {
        start_c: room.zone.start_temperature_c!,
        start_stored_heat_c: room.zone.start_stored_heat_c ?? 0,
        thermostats: room.actuators,
        quarters: room.quarters,
      },
    })),
    stage,
    hours: clock.hours,
    headroom_w: headroom,
    import_sek_per_kwh: prices?.import_sek_per_kwh ?? Array(n).fill(1),
    export_sek_per_kwh: prices?.export_sek_per_kwh ?? Array(n).fill(1),
    surplus_w: surplus,
    ...(accepted && compiled.every((room) => accepted[room.zone.key])
      ? { accepted: compiled.map((room) => accepted[room.zone.key]) }
      : {}),
  };
  return { native, compiled, stage };
}
/** Compile exactly one catalogue entry, irrespective of where its source was stored. */
export function compileConnectedNodeBelief(node: ConnectedRoomPlanningNode | null, native: NativeRoomNetworkInput): NativeRoomNetworkBelief {
  if (!node) return { hypotheses: [], thermal_noise_c2_per_h: 0, bounded_thermal: true };
  const nodeIndex = new Map(native.nodes.map((node, index) => [node.key, index]));
  const requiredPeers = new Set(connectedRoomDependencies(node));
  const response = node.model;
  return {
    bounded_thermal: node.initial_state === "bounded_thermal",
    thermal_noise_c2_per_h: response.thermal_noise_c2_per_h,
    reset_priors: node.process_belief.reset_priors?.map((prior) => ({
      ...prior,
      from: nodeIndex.get(prior.from)!,
    })),
    hypotheses: connectedProcessWeightedHypotheses(node.process_belief).map(
      (h) => {
        const selected = h.incoming.flatMap((edge, index) => {
          const from = nodeIndex.get(edge.from);
          if (from === undefined) {
            if (
              edge.kind === "constant" && edge.per_h === 0 &&
              !requiredPeers.has(edge.from)
            ) return [];
            throw new Error("Missing hypothesis peer");
          }
          return [{ edge: { ...edge, from }, index }];
        });
        return {
          log_weight: h.log_weight,
          posterior: h.posterior,
          incoming: selected.map((value) => value.edge),
          hazards: h.hazards
            ? selected.map((value) => h.hazards![value.index])
            : undefined,
        };
      },
    ),
  };
}
function storePlans(
  prepared: Pick<NonNullable<ReturnType<typeof compileNetwork>>, "compiled" | "stage">,
  output: NativeRoomNetworkOutput | NativeRoomNetworkProposal,
  result: RoomServices,
  retained: RoomPlanningInputs["retained"],
) {
  for (let j = 0; j <= prepared.stage; j++) {
    const room = prepared.compiled[j], plan = output.plans[j];
    storeRoomCommands(
      result,
      room.zone,
      room.thermostats,
      room.members,
      room.relays,
      retained,
      plan,
      room.quarters,
      true,
    );
    result.room_power[room.zone.key] = plan.power_w;
    (result.expected_shortfall_c ??= {})[room.zone.key] = plan.shortfall_c;
    result.temperature[room.zone.key] = plan.temperature_c;
    if ("literal" in output) {
      (result.unplanned_expected_shortfall_c ??= {})[room.zone.key] = output.literal[j].shortfall_c;
      result.unplanned_temperature[room.zone.key] = output.literal[j].temperature_c;
      result.unplanned_power[room.zone.key] = output.literal[j].power_w;
    }
    result.warnings = result.warnings.filter((w) =>
      !(w.code === "comfort_shortfall" && w.scope === room.zone.key)
    );
    const misses = plan.shortfall_c.filter((value) => value > 1e-6).length;
    if (misses) {
      result.warnings.push(
        planningWarning(
          "comfort_shortfall",
          room.zone.key,
          `${room.zone.name}: ${misses} quarters may be outside the requested comfort band.`,
          "The best attainable room schedule is included and household planning continues.",
          { quarters: misses },
        ),
      );
    }
  }
}
/** Mean rates produce commands in original room order; final demand is replayed jointly. */
export function prepareConnectedRoomStage(
  inputs: RoomPlanningInputs,
  zone: Zone,
  result: RoomServices,
  accepted: Record<string, RoomHeatingPlan> | undefined,
  disabled: ReadonlySet<string>,
  trace?: PlanningTrace,
) {
  const prepared = compileNetwork(inputs, zone, result, accepted, disabled);
  if (!prepared) return;
  const output = nativePlanner(trace).roomNetwork(prepared.native, trace);
  storePlans(prepared, output, result, inputs.retained);
  return {
    ...accepted,
    ...Object.fromEntries(
      prepared.compiled.map((room, i) => [room.zone.key, output.plans[i]]),
    ),
  };
}
/** Compile the final numerical problem once, after ordered proposals. The
 * returned context is serializable and contains the existing command mapping. */
export function compileConnectedRoomCatalog(
  inputs: RoomPlanningInputs,
  result: RoomServices,
  accepted: Record<string, RoomHeatingPlan> | undefined,
  disabled: ReadonlySet<string>,
) {
  const network = inputs.proposal_network ?? inputs.snapshot.room_network;
  if (
    !network || !accepted ||
    !network.nodes.some((node) => !disabled.has(node.key))
  ) return;
  const prepared = compileNetwork(inputs, null, result, accepted, disabled);
  if (!prepared) return;
  const forecast = network.forecast;
  if (!forecast || forecast.revision !== ROOM_NETWORK_WORK_REVISION) {
    throw new Error("Missing frozen joint forecast identity");
  }
  return { network: prepared.native, context: { compiled: prepared.compiled, stage: prepared.stage, forecast } };
}

export type ConnectedRoomCatalog = NonNullable<ReturnType<typeof compileConnectedRoomCatalog>>;

export function compileConnectedRoomForecast(inputs: RoomPlanningInputs, result: RoomServices,
  accepted: Record<string, RoomHeatingPlan> | undefined, disabled: ReadonlySet<string>) {
  const plan = compileConnectedRoomCatalog(inputs, result, accepted, disabled);
  if (!plan) return;
  const { network, context } = plan, { forecast } = context;
  const nodes = new Map(inputs.snapshot.room_network!.nodes.map(node => [node.key, node]));
  const beliefs = network.nodes.map(({key}) => compileConnectedNodeBelief(nodes.get(key) ?? null, network));
  const identity = Array.from(sha256(new TextEncoder().encode(JSON.stringify({ snapshot: inputs.snapshot.snapshot_id, forecast, network, beliefs }))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  return { context: { ...context, identity }, nativeInput: { network, beliefs, seed: forecast.seed, identity, replicate_count: forecast.replicates } };
}
export type ConnectedRoomForecastRequest = NonNullable<ReturnType<typeof compileConnectedRoomForecast>>;
export type ConnectedRoomForecastContext = ConnectedRoomForecastRequest["context"];

/** Applying an already-qualified joint result preserves the same demand ledger,
 * command ownership and captured numerical identity for hosted and local runs. */
export function applyConnectedRoomForecast(
  inputs: RoomPlanningInputs,
  result: RoomServices,
  context: ConnectedRoomCatalog["context"],
  output: NativeRoomNetworkOutput,
  statistics: { trajectories: number; replayed_paths: number; replicates: Array<{ trajectories: number }> },
) {
  storePlans(context, output, result, inputs.retained);
  const completed = { ...context.forecast, trajectories: statistics.trajectories,
    replayed_paths: statistics.replayed_paths,
    replicate_trajectories: statistics.replicates.map(replica => replica.trajectories) };
  if (inputs.snapshot.room_network) inputs.snapshot.room_network.forecast = completed;
  result.network_forecast = completed;
}

/** Bounded native blocks retain exact paths and common innovations across calls. */
export function advanceConnectedRoomBarrier(
  inputs: RoomPlanningInputs,
  result: RoomServices,
  accepted: Record<string, RoomHeatingPlan> | undefined,
  disabled: ReadonlySet<string>,
  previous: RoomNetworkWork | undefined,
  trace?: PlanningTrace,
  initialOnly = false,
): RoomNetworkWork | undefined {
  const request = compileConnectedRoomForecast(inputs, result, accepted, disabled);
  if (!request) return;
  const { context, nativeInput } = request;
  const { identity, forecast } = context;
  if (forecast.replicates !== 4 || previous && previous.replicas.length !== 4) throw new Error("Invalid frozen forecast replicas");
  const planner = nativePlanner(trace), started = performance.now();
  const headers = nativeInput.beliefs.map(belief => planner.roomNetworkHeader({ belief }, trace));
  const deterministic = headers.every(header => header.deterministic);
  const replicas: Array<NativeRoomNetworkReplicaWork | null> = previous?.replicas.slice() ?? Array(4).fill(null);
  const capturedTarget = connectedForecastTarget(forecast);
  const target = deterministic ? 1 : capturedTarget;
  let cursor = previous?.cursor ?? 0, lastDuration = 0;
  const maxWork = initialOnly ? 1 : Math.max(1, Math.min(131072, Math.floor(24576 * (9 / nativeInput.network.nodes.length) ** 2)));
  for (;;) {
    const localTarget = deterministic ? 1 : target / 4;
    if (!Number.isSafeInteger(localTarget) || localTarget < 1) throw new Error("Invalid balanced forecast target");
    const count = deterministic ? 1 : 4;
    const nextReplica = replicas.findIndex((work, index) => index < count && (!work || work.statistics.trajectories < localTarget));
    if (nextReplica < 0) {
      const merged = planner.roomNetworkMerge({ network: nativeInput.network, identity, seed: forecast.seed,
        replicas: replicas.slice(0, count).map(work => work!) }, trace);
      const output = planner.roomNetworkFinalize({ network: nativeInput.network, work: merged.work }, trace);
      applyConnectedRoomForecast(inputs, result, context, output, merged.statistics);
      return;
    } else {
      const replica = nextReplica as NativeRoomReplica, work = replicas[replica], complete = work?.statistics.trajectories ?? 0;
      const selections = planner.roomNetworkSelect({ node_headers: headers, seed: forecast.seed, replica,
        local_draws: Array.from({ length: Math.min(8, localTarget - complete) }, (_, i) => complete + i) }, trace);
      const selected = new Map<string, NativeRoomNetworkSelectedHypothesis>();
      for (const draw of selections) for (const [node, index] of draw.hypothesis_indexes.entries()) {
        if (index === null) continue;
        const key = `${node}:${index}`;
        if (!selected.has(key)) selected.set(key, { node, index, json: JSON.stringify(nativeInput.beliefs[node].hypotheses[index]) });
      }
      const begin = performance.now();
      const advanced = planner.roomNetworkReplicaAdvance({ network: nativeInput.network, node_headers: headers,
        seed: forecast.seed, identity, replica, target_local_draws: localTarget, max_work: maxWork,
        ...(work ? { work } : {}), selected_hypotheses: [...selected.values()] }, trace);
      replicas[replica] = advanced.work;
      cursor++;
      lastDuration = performance.now() - begin;
    }
    if (initialOnly || performance.now() - started + lastDuration >= 600) {
      return { revision: ROOM_NETWORK_WORK_REVISION, cursor, target_trajectories: target, replicas };
    }
  }
}
