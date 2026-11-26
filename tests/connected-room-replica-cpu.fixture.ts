/** Independently synthetic15-node/72-hour runtime fixtures. No household data. */
import { assert, assertEquals } from "@std/assert";
import { cpuConnectedRoomPlanningSource } from "./planner-handler-cpu.fixture.ts";
import { captureRulesPlanningInput } from "../supabase/functions/_shared/rules-planning-capture.ts";
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
  NativeRoomNetworkReplicaWork,
  NativeRoomReplica,
} from "../supabase/functions/_shared/room-network-contract.ts";
export const CONNECTED_REPLICA_CPU_PHASES = [
  "catalog",
  "initial",
  "resumed",
  "qualify",
  "finish",
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
  hypotheses: NativeRoomNetworkHypothesis[][];
}
/** All ordered prepare stages, encoded before the measured cold workers. */
async function preparationFixtures(stiff: boolean, wide: boolean) {
  const capture = captureRulesPlanningInput(
    cpuConnectedRoomPlanningSource(stiff, wide),
    null,
    resolveRulePolicy(),
  );
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
              input: capture,
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
  const prepared = await preparationFixtures(true, false),
    input = prepared.next.forecast!.nativeInput,
    planner = nativePlanner();
  const node_headers = input.beliefs.map((belief) =>
    planner.roomNetworkHeader({ belief })
  );
  const header = {
    network: input.network,
    node_headers,
    seed: input.seed,
    identity: input.identity,
  };
  const selections = planner.roomNetworkSelect({
    ...header,
    replica: 0,
    local_draws: [0, 1],
  });
  const records = [
    ...new Map(
      selections.flatMap((draw) =>
        draw.hypothesis_indexes.flatMap((index, node) =>
          index === null ? [] : [
            [`${node}:${index}`, {
              node,
              index,
              json: JSON.stringify(input.beliefs[node].hypotheses[index]),
            }] as const,
          ]
        )
      ),
    ).values(),
  ];
  const partial = planner.roomNetworkReplicaAdvance({
    ...header,
    replica: 0,
    target_local_draws: 16,
    max_work: 24576,
    selected_hypotheses: records,
  }).work;
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
  const encode = (
    phase: "initial" | "resumed",
    state: Record<string, unknown>,
  ) =>
    new TextEncoder().encode(
      JSON.stringify(
        {
          phase,
          saved: state,
          hypotheses: input.beliefs.map((b) => b.hypotheses),
        } satisfies ConnectedReplicaCpuFixture,
      ),
    );
  return {
    preparations: prepared.fixtures,
    initial: encode("initial", saved),
    resumed: encode("resumed", {
      ...saved,
      cursor: partial.cursor,
      work: await packOwnedPlanningValue(partial),
    }),
  };
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
  const records = (
    replica: NativeRoomReplica,
    first: number,
    count: number,
  ) => {
    const selections = planner.roomNetworkSelect({
      node_headers,
      seed: input.seed,
      replica,
      local_draws: Array.from({ length: count }, (_, i) => first + i),
    });
    return [
      ...new Map(
        selections.flatMap((draw) =>
          draw.hypothesis_indexes.flatMap((index, node) =>
            index === null ? [] : [
              [`${node}:${index}`, {
                node,
                index,
                json: JSON.stringify(input.beliefs[node].hypotheses[index]),
              }] as const,
            ]
          )
        ),
      ).values(),
    ];
  };
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
      node: await packOwnedPlanningValue(input.beliefs[0]),
    },
    qualify: {
      dispatch: { ...dispatch, phase: "qualify" },
      slice_fence: 1,
      identity: input.identity,
      input: capture,
      header,
      context: contextBytes,
      replicas: await Promise.all(
        complete.map(async (work, replica) => ({
          replica,
          work: await packOwnedPlanningValue(work),
        })),
      ),
    },
  };
  // Archived fixed-count replay exercises finalization without changing the
  // numerical convergence policy used by the ordinary qualification fixture.
  fixtures.finish = {
    ...fixtures.qualify,
    header: await packOwnedPlanningValue({
      network: input.network,
      node_headers,
      seed: input.seed,
      identity: input.identity,
      captured_target: 64,
    }),
  };
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
export function connectedReplicaCpuReplay(fixture: ConnectedReplicaCpuFixture) {
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
    async check() {
      assert(checkpoint, "actual worker checkpoints its bounded stage");
      if (fixture.phase === "initial" || fixture.phase === "resumed") {
        const work = await unpackOwnedPlanningValue<
          NativeRoomNetworkReplicaWork
        >(checkpoint.p_work as string);
        assert(work.cursor > Number(fixture.saved.cursor));
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
      } else {assertEquals(
          (checkpoint.p_update as { phase: string }).phase,
          fixture.phase === "finish" ? "solve" : "integrate",
        );}
      return { requestBytes, responseBytes };
    },
  };
}
