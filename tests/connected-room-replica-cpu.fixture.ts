/** Independently synthetic15-node/72-hour runtime fixtures. No household data. */
import { assert, assertEquals } from "@std/assert";
import { cpuConnectedRoomPlanningSource } from "./planner-handler-cpu.fixture.ts";
import { captureRulesPlanningInput, type CapturedRulesInput } from "../supabase/functions/_shared/rules-planning-capture.ts";
import { prepareCapturedRoomProposals } from "../supabase/functions/_shared/rules-planning-execution.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { nativePlanner } from "../supabase/functions/_shared/planner-wasm/runtime.ts";
import {
  packOwnedPlanningValue,
  unpackOwnedPlanningValue,
} from "../supabase/functions/_shared/owned-planning-codec.ts";
import type { ModelDatabase } from "../supabase/functions/_shared/device-model-store.ts";
import type {
  NativeRoomNetworkHypothesis,
  NativeRoomNetworkReplicaAdvanceInput,
  NativeRoomNetworkReplicaWork,
  NativeRoomReplica,
} from "../supabase/functions/_shared/room-network-contract.ts";
import { connectedAdmissionCpuInput, runConnectedAdmissionCpu } from "./connected-room-admission-cpu.fixture.ts";
import type { ConnectedRoomResponse } from "../supabase/functions/_shared/planner/models/room/connected-exchange.ts";
import { projectedPlanningNetwork } from "../supabase/functions/_shared/room-network.fixture.ts";
import { applyConnectedRoomCapture } from "../supabase/functions/_shared/room-model-capture.ts";
import type { ConnectedRoomForecastRequest } from "../supabase/functions/_shared/rules-connected-room-services.ts";

export const CONNECTED_REPLICA_CPU_PHASES = [
  "catalog",
  "initial",
  "resumed",
  "qualify",
  "finish",
  "apply",
] as const;
export type ConnectedReplicaCpuPhase =
  typeof CONNECTED_REPLICA_CPU_PHASES[number];
export const CONNECTED_REPLICA_CPU_OWNER = {
  home_id: "synthetic-wide-home",
  job_id: "synthetic-wide-job",
  fence: 1,
};
export interface ConnectedReplicaCpuFixture {
  phase: ConnectedReplicaCpuPhase | "prepare";
  saved: Record<string, unknown>;
  subsequent?: Record<string, unknown>;
  siblingCheckpoints?: Array<{ cursor: number; work: string }>;
  hypotheses: NativeRoomNetworkHypothesis[][];
}
/** All ordered prepare stages, encoded before the measured cold workers. */
async function preparationFixtures(stiff: boolean, wide: boolean) {
  const capture = captureRulesPlanningInput(
    cpuConnectedRoomPlanningSource(stiff, wide),
    null,
    resolveRulePolicy(),
  );
  const { room_network, ...snapshot } = capture.snapshot;
  const projected = { input: { ...capture, snapshot }, proposal_network: projectedPlanningNetwork(room_network!) };
  const fixtures: Uint8Array<ArrayBuffer>[] = [];
  let previous: Parameters<typeof prepareCapturedRoomProposals>[1] = null;
  for (let room = 0;; room++) {
    fixtures.push(
      new TextEncoder().encode(
        JSON.stringify(
          {
            phase: "prepare",
            hypotheses: [],
            saved: {
              dispatch: {
                phase: "prepare",
                cursor: room,
                target: 64,
                round: 0,
                replicas: [],
              },
              slice_fence: 1,
              ...projected,
              payload: previous ? await packOwnedPlanningValue(previous) : null,
            },
          } satisfies ConnectedReplicaCpuFixture,
        ),
      ),
    );
    const next = prepareCapturedRoomProposals(capture, previous);
    if (next.forecast) return { capture, fixtures, next };
    assert(next.room_progress);
    previous = next.room_progress;
  }
}
export async function connectedPreparationCpuInputs(): Promise<
  Uint8Array<ArrayBuffer>[]
> {
  return (await preparationFixtures(false, true)).fixtures;
}
/** Full72-hour stiff physics, sampled as bounded initial/resumed requests.
 * Whole-forecast convergence is a separate explicit diagnostic, not this gate. */
export async function connectedStiffCpuInputs() {
  const prepared = await preparationFixtures(true, false);
  const pair = await replicaCpuPair(prepared.next.forecast!.nativeInput, 24576);
  return {
    preparations: prepared.fixtures,
    initial: encodeReplicaFixture(pair.initial),
    resumed: encodeReplicaFixture({...pair.initial, phase: "resumed", saved: pair.resumed}),
  };
}

function encodeReplicaFixture(fixture: ConnectedReplicaCpuFixture) {
  return new TextEncoder().encode(JSON.stringify(fixture));
}

type ReplicaHeader = Pick<NativeRoomNetworkReplicaAdvanceInput, "network" | "node_headers" | "seed" | "identity">;

function selectedReplicaRecords(header: Pick<ReplicaHeader, "node_headers" | "seed">, hypotheses: NativeRoomNetworkHypothesis[][],
  replica: NativeRoomReplica, first: number, count: number) {
  const selections = nativePlanner().roomNetworkSelect({ node_headers: header.node_headers, seed: header.seed, replica,
    local_draws: Array.from({ length: count }, (_, i) => first + i) });
  const records = new Map<string, { node: number; index: number; json: string }>();
  for (const draw of selections) {
    draw.hypothesis_indexes.forEach((index, node) => {
      if (index !== null) records.set(`${node}:${index}`, {
        node, index, json: JSON.stringify(hypotheses[node][index]),
      });
    });
  }
  return [...records.values()];
}

async function replicaCpuPair(input: ConnectedRoomForecastRequest["nativeInput"], partialWork: number, includeSiblings = false) {
  const planner = nativePlanner();
  const node_headers = input.beliefs.map((belief) =>
    planner.roomNetworkHeader({ belief })
  );
  const header = {
    network: input.network,
    node_headers,
    seed: input.seed,
    identity: input.identity,
  };
  const hypotheses = input.beliefs.map(b => b.hypotheses);
  const checkpoint = async (replica: NativeRoomReplica) => {
    const work = planner.roomNetworkReplicaAdvance({
      ...header, replica, target_local_draws: 16, max_work: partialWork,
      selected_hypotheses: selectedReplicaRecords(header, hypotheses, replica, 0, 2),
    }).work;
    return { cursor: work.cursor, work: await packOwnedPlanningValue(work) };
  };
  const saved = {
    dispatch: {
      phase: "integrate",
      cursor: 0,
      target: 64,
      round: 1,
      replicas: [0, 1, 2, 3],
    },
    cursor: 0,
    slice_fence: 1,
    identity: input.identity,
    round: 1,
    target_local_draws: 16,
    header: await packOwnedPlanningValue(header),
    work: null,
  };
  return {
    initial: {phase: "initial", saved, hypotheses,
      siblingCheckpoints: includeSiblings ? await Promise.all(([1, 2, 3] as const).map(checkpoint)) : undefined,
    } satisfies ConnectedReplicaCpuFixture,
    resumed: {...saved, ...await checkpoint(0)},
  };
}

// This fixed prefix places each synthetic resume inside its first conditional stratum.
const DENSE_RESUME_FIXTURE_WORK = 3926;

/** Independent 13-room, 13,312-particle admission fixture for cold and resumed workers. */
export async function connectedDenseReplicaCpuInput(scaledCovariance = false) {
  const frozen = new Map<string, ConnectedRoomResponse>();
  const fixture = JSON.parse(new TextDecoder().decode(connectedAdmissionCpuInput((key, model) => frozen.set(key, model))));
  const {serialized} = await runConnectedAdmissionCpu(fixture);
  const capture = JSON.parse(serialized).input as CapturedRulesInput;
  const nodes = capture.snapshot.room_network_capture!.rooms.map(room => {
    const response = frozen.get(room.key)!, belief = response.process_belief!;
    if (scaledCovariance && belief.initial_incoming.length === 7) {
      // Seven stochastic 3/h exchanges trigger covariance scaling at a one-minute
      // step while the ordinary thermal generator still charges one minute of work.
      const center = Math.log(3);
      for (const edge of [...response.incoming, ...belief.initial_incoming]) {
        assert(edge.kind === "log_ou");
        edge.mean_log_per_h = center;
      }
      for (const prior of belief.reset_priors) prior.center_mean = center;
      for (const h of belief.hypotheses) {
        h.posterior.log_rates.fill(center);
        h.posterior.log_centers!.fill(center);
        for (const edge of h.incoming) {
          assert(edge.kind === "log_ou");
          edge.mean_log_per_h = center;
        }
      }
    }
    const posterior = belief.hypotheses[0].posterior;
    return {
      key: room.key, model: {...response, reference_state: posterior, process_belief: undefined},
      posterior, process_belief: belief, initial_state: "identified_joint" as const,
      start_temperature_c: posterior.temperature_c, start_stored_heat_c: posterior.stored_heat_c,
    };
  });
  assertEquals(nodes.length, 13);
  assertEquals(nodes.reduce((n,node) => n + node.process_belief.hypotheses.length, 0), 13312);
  capture.snapshot = applyConnectedRoomCapture(capture.snapshot, nodes, []);
  let next = prepareCapturedRoomProposals(capture, null);
  while (!next.forecast) {
    assert(next.room_progress);
    next = prepareCapturedRoomProposals(capture, next.room_progress);
  }
  const pair = await replicaCpuPair(next.forecast.nativeInput, DENSE_RESUME_FIXTURE_WORK, true);
  return encodeReplicaFixture({...pair.initial, subsequent: pair.resumed});
}
/** Prepare transport before spawning measured cold processes. */
export async function connectedReplicaCpuInputs(): Promise<
  Record<ConnectedReplicaCpuPhase, Uint8Array<ArrayBuffer>>
> {
  const capture = captureRulesPlanningInput(
    cpuConnectedRoomPlanningSource(false, true),
    null,
    resolveRulePolicy(),
  );
  let next = prepareCapturedRoomProposals(capture, null);
  while (!next.forecast) {
    assert(next.room_progress);
    next = prepareCapturedRoomProposals(capture, next.room_progress);
  }
  const { nativeInput: input, context } = next.forecast,
    planner = nativePlanner();
  const node_headers = input.beliefs.map((belief) =>
    planner.roomNetworkHeader({ belief })
  );
  const header = await packOwnedPlanningValue({
    network: input.network,
    node_headers,
    seed: input.seed,
    identity: input.identity,
    target: 64,
  });
  const dispatch = {
    phase: "integrate",
    cursor: 0,
    target: 64,
    round: 1,
    replicas: [0, 1, 2, 3],
  };
  const saved = {
    dispatch,
    cursor: 0,
    slice_fence: 1,
    identity: input.identity,
    round: 1,
    target_local_draws: 16,
    header,
    work: null,
  };
  const hypotheses = input.beliefs.map(b => b.hypotheses);
  const records = (replica: NativeRoomReplica, first: number, count: number) =>
    selectedReplicaRecords({ node_headers, seed: input.seed }, hypotheses, replica, first, count);
  const partial = planner.roomNetworkReplicaAdvance({
    network: input.network,
    node_headers,
    seed: input.seed,
    identity: input.identity,
    replica: 0,
    target_local_draws: 16,
    max_work: 8847,
    selected_hypotheses: records(0, 0, 3),
  }).work;
  const complete: NativeRoomNetworkReplicaWork[] = [];
  for (const replica of [0, 1, 2, 3] as NativeRoomReplica[]) {
    let work: NativeRoomNetworkReplicaWork | undefined;
    for (;;) {
      const first = work?.statistics.trajectories ?? 0;
      const advanced = planner.roomNetworkReplicaAdvance({
        network: input.network,
        node_headers,
        seed: input.seed,
        identity: input.identity,
        replica,
        target_local_draws: 16,
        max_work: 17694,
        work,
        selected_hypotheses: records(replica, first, Math.min(4, 16 - first)),
      });
      work = advanced.work;
      if (advanced.reached_target) {
        complete.push(work);
        break;
      }
    }
  }
  const { room_network, ...snapshot } = capture.snapshot;
  const contextBytes = await packOwnedPlanningValue({
    progress: next.room_progress,
    forecast: context,
  });
  const fixtures: Partial<
    Record<ConnectedReplicaCpuPhase, Record<string, unknown>>
  > = {
    initial: saved,
    resumed: {
      ...saved,
      cursor: partial.cursor,
      work: await packOwnedPlanningValue(partial),
    },
    catalog: {
      dispatch: { ...dispatch, phase: "catalog" },
      slice_fence: 1,
      identity: input.identity,
      catalog_next: 0,
      node_count: input.beliefs.length,
      header: await packOwnedPlanningValue({
        network: input.network,
        node_headers: [],
        seed: input.seed,
        identity: input.identity,
      }),
      catalog_source: { key: input.network.nodes[0].key, node: room_network!.nodes.find(node => node.key === input.network.nodes[0].key) ?? null },
    },
    qualify: {
      dispatch: { ...dispatch, phase: "qualify" },
      slice_fence: 1,
      identity: input.identity,
      header,
      replicas: await Promise.all(
        complete.map(async (work, replica) => ({
          replica,
          work: await packOwnedPlanningValue(work),
        })),
      ),
    },
  };
  // Archived fixed-count replay and fresh bounded forecasts both exercise
  // native finalization with their actual balanced completed counts.
  fixtures.finish = {
    ...fixtures.qualify,
    header: await packOwnedPlanningValue({
      network: input.network,
      node_headers,
      seed: input.seed,
      identity: input.identity,
      target: 64,
    }),
  };
  const merged = planner.roomNetworkMerge({network: input.network, seed: input.seed, identity: input.identity, replicas: complete});
  const {trajectories,replayed_paths,replicates} = merged.statistics;
  const qualified = {output:planner.roomNetworkFinalize({network:input.network,work:merged.work}),
    counts:{trajectories,replayed_paths,replicates:replicates.map(({trajectories}) => ({trajectories}))}};
  fixtures.apply = {dispatch:{...dispatch,phase:"qualify"},slice_fence:1,identity:input.identity,
    input:{...capture,snapshot},forecast:room_network!.forecast,context:contextBytes,qualified:await packOwnedPlanningValue(qualified)};
  return Object.fromEntries(
    CONNECTED_REPLICA_CPU_PHASES.map(
      (phase) => [
        phase,
        new TextEncoder().encode(
          JSON.stringify(
            {
              phase,
              saved: fixtures[phase]!,
              hypotheses: input.beliefs.map((b) => b.hypotheses),
            } satisfies ConnectedReplicaCpuFixture,
          ),
        ),
      ],
    ),
  ) as Record<ConnectedReplicaCpuPhase, Uint8Array<ArrayBuffer>>;
}
/** A timed worker may stop at any native continuation. Compare both partitions
 * after finishing the same outer draw, including its conditional reset stratum. */
function finishReplicaDraw(header: ReplicaHeader, hypotheses: NativeRoomNetworkHypothesis[][], replica: NativeRoomReplica,
  target: number, work?: NativeRoomNetworkReplicaWork) {
  const first = work?.statistics.trajectories ?? 0;
  const records = selectedReplicaRecords(header, hypotheses, replica, first, target - first);
  while (!work || work.statistics.trajectories < target) {
    const previousCursor = work?.cursor ?? 0;
    work = nativePlanner().roomNetworkReplicaAdvance({ ...header, replica, work, target_local_draws: target,
      max_work: 131072, selected_hypotheses: records }).work;
    assert(work.cursor > previousCursor, "reference reaches its complete draw without missing records");
  }
  assertEquals(work.statistics.trajectories, target);
  assertEquals(work.path, null);
  return work;
}

export function connectedReplicaCpuReplay(fixture: ConnectedReplicaCpuFixture, replica = 0) {
  let checkpoint: Record<string, unknown> | undefined,
    requestBytes = 0,
    responseBytes = 0;
  const db: ModelDatabase = {
    rpc(name, args) {
      requestBytes += JSON.stringify(args).length;
      let data: unknown;
      if (
        name === "claim_energy_forecast_replica" ||
        name === "load_energy_owned_planning_stage"
      ) data = fixture.saved;
      else if (name === "read_energy_forecast_records") {
        data = (args.p_records as Array<{ node: number; index: number }>).map((
          { node, index },
        ) => ({
          node,
          index,
          json: JSON.stringify(fixture.hypotheses[node][index]),
        }));
      } else if (
        name === "checkpoint_energy_forecast_replica" ||
        name === "checkpoint_energy_owned_planning_stage"
      ) {
        checkpoint = args;
        data = fixture.saved.dispatch;
      } else throw new Error(`Unexpected owned CPU RPC ${name}`);
      const raw = JSON.stringify(data);
      responseBytes += raw.length;
      return Promise.resolve({ data: JSON.parse(raw), error: null });
    },
  };
  return {
    db,
    continuation() {
      assert(checkpoint && typeof checkpoint.p_work === "string" && typeof checkpoint.p_next_cursor === "number");
      return { work: checkpoint.p_work, cursor: checkpoint.p_next_cursor };
    },
    async check(scaledResume = false) {
      assert(checkpoint, "actual worker checkpoints its bounded stage");
      if (fixture.phase === "initial" || fixture.phase === "resumed") {
        const work = await unpackOwnedPlanningValue<
          NativeRoomNetworkReplicaWork
        >(checkpoint.p_work as string);
        assertEquals(checkpoint.p_replica, replica);
        assertEquals(work.replica, replica);
        assertEquals(checkpoint.p_next_cursor, work.cursor);
        assertEquals(checkpoint.p_completed, work.statistics.trajectories);
        assert(work.cursor > Number(fixture.saved.cursor));
        const header = await unpackOwnedPlanningValue<ReplicaHeader>(fixture.saved.header as string);
        const previous = fixture.saved.work ? await unpackOwnedPlanningValue<NativeRoomNetworkReplicaWork>(fixture.saved.work as string) : undefined;
        const target = work.statistics.trajectories + (work.path == null ? 0 : 1);
        assert(target > 0 && target <= Number(fixture.saved.target_local_draws));
        assertEquals(finishReplicaDraw(header, fixture.hypotheses, work.replica, target, work),
          finishReplicaDraw(header, fixture.hypotheses, work.replica, target, previous));
        if (scaledResume) {
          assert(previous);
          const path = previous.path as { quarter_rates: number[][][] };
          assert(previous.pending && path, "resume both conditional reset strata");
          assert(header.node_headers.every(node => node.thermal_noise_c2_per_h > 0));
          const rates = path.quarter_rates.at(-1)!;
          const hours = header.network.hours[previous.slot], dt = hours / Math.ceil(hours * 60);
          const outgoing = rates.map(edges => edges.reduce((a, b) => a + b, 0));
          assert(header.network.nodes.some((node, i) => (node.outdoor_per_h + 2 * outgoing[i]) * dt > .25));
          assert(header.network.nodes.every((node, i) =>
            Math.max(node.outdoor_per_h + outgoing[i], node.lag_h > 0 ? 1 / node.lag_h : 0) * dt < 1));
        }
        const path = work.path as
          | { states: Array<{ temperatures: number[] }> }
          | null;
        assert(
          work.statistics.trajectories > 0 || path?.states.length === 3,
          "a bounded slice retains actual joint physical states",
        );
        if (path) {
          assert(path.states.every((state) =>
            state.temperatures.length > 0 &&
            state.temperatures.every(Number.isFinite)
          ));
        }
      } else if (fixture.phase === "prepare") {
        const update = checkpoint.p_update as {
          phase: string;
          payload?: string;
          context?: string;
        };
        const value = await unpackOwnedPlanningValue<
          { next_room?: number; progress?: { next_room: number } }
        >((update.phase === "catalog" ? update.context : update.payload)!);
        const action = (fixture.saved.dispatch as { cursor: number }).cursor;
        const expected = Math.min(action + 1, 8);
        assertEquals(value.next_room ?? value.progress?.next_room, expected);
        assertEquals(update.phase, action === 8 ? "catalog" : "prepare");
      } else if (fixture.phase === "catalog") {
        assertEquals(
          (checkpoint.p_update as { node: number }).node,
          0,
        );
      } else if (fixture.phase === "finish" || fixture.phase === "qualify") {
        const update = checkpoint.p_update as {phase:string;qualified:string};
        assertEquals(update.phase, "qualify");
        const result = await unpackOwnedPlanningValue<{counts:{trajectories:number}}>(update.qualified);
        assertEquals(result.counts.trajectories, 64);
      } else if (fixture.phase === "apply") {
        const update = checkpoint.p_update as {phase:string;forecast_counts:{trajectories:number}};
        assertEquals(update.phase, "solve");
        assertEquals(update.forecast_counts.trajectories, 64);
      } else assertEquals((checkpoint.p_update as {phase:string}).phase, "integrate");
      return { requestBytes, responseBytes };
    },
  };
}
