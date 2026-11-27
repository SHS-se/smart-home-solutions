import { nativeForecastTotals } from "./planner-wasm/core.ts";
import { z } from "zod";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import { advanceOwnedPlanningWorker } from "./owned-planning-worker.ts";
import { packOwnedPlanningValue, unpackOwnedPlanningValue } from "./owned-planning-codec.ts";
import { PlanningTrace } from "./planning-trace.ts";
import { syntheticJointRoomForecast } from "./room-network-forecast.fixture.ts";
import type {
  NativeRoomNetworkAdvanceInput,
  NativeRoomNetworkReplicaWork,
  NativeRoomReplica,
} from "./room-network-contract.ts";

/** Independent synthetic data, including two parameter modes and rare resets. */
function fixture(scenario: "ordinary" | "resets" | "stiff" = "ordinary") {
  const input = syntheticJointRoomForecast(2, .3, .5, .01);
  input.target_trajectories = 16;
  for (const [node, belief] of input.beliefs.entries()) {
    const h = belief.hypotheses[0];
    h.posterior.log_centers = [Math.log(.2)];
    h.posterior.covariance = [[.04, 0, .01, -.02], [0, 4, 0, 0], [
      .01,
      0,
      .03,
      0,
    ], [-.02, 0, 0, .04]];
    const other = structuredClone(h);
    other.log_weight = -.7;
    other.posterior.temperature_c += .4;
    belief.hypotheses.push(other);
    if (scenario === "stiff") {
      for (const h of belief.hypotheses) {
        h.posterior.log_rates = [Math.log(1100)];
        h.posterior.log_centers = [Math.log(1000)];
        for (const edge of h.incoming) {
          if (edge.kind === "log_ou") edge.mean_log_per_h = Math.log(1000);
        }
      }
    }
    if (scenario === "resets") {
      belief.reset_priors = [{
        from: 1 - node,
        center_mean: Math.log(.3),
        center_variance: .2,
        log_reversion_mean: -.5,
        log_reversion_sd: .6,
        stationary_variance_scale: .5,
        constant_probability: .5,
      }];
      belief.hypotheses.forEach((h) =>
        h.hazards = [{ shape: .5, rate_h: 9600 }]
      );
    }
  }
  return input;
}
function replicas(
  input: NativeRoomNetworkAdvanceInput,
  maxWork: number,
  order: NativeRoomReplica[],
) {
  const planner = nativePlanner(),
    headers = input.beliefs.map((belief) =>
      planner.roomNetworkHeader({ belief })
    );
  const result: NativeRoomNetworkReplicaWork[] = [];
  for (const replica of order) {
    let work: NativeRoomNetworkReplicaWork | undefined;
    for (let calls = 0;; calls++) {
      assert(calls < 1000, "synthetic replay completes");
      const start = work?.statistics.trajectories ?? 0;
      const picks = planner.roomNetworkSelect({
        node_headers: headers,
        seed: input.seed,
        replica,
        local_draws: [start, start + 1],
      });
      const records = new Map(
        picks.flatMap((p) =>
          p.hypothesis_indexes.flatMap((index, node) =>
            index === null ? [] : [
              [`${node}:${index}`, {
                node,
                index,
                json: JSON.stringify(input.beliefs[node].hypotheses[index]),
              }] as const,
            ]
          )
        ),
      );
      // A partial trajectory resumes without re-reading any selected population.
      const selected_hypotheses = calls % 2 === 1 && work?.slot !== 0
        ? []
        : [...records.values()];
      const next = planner.roomNetworkReplicaAdvance({
        network: input.network,
        node_headers: headers,
        seed: input.seed,
        identity: input.identity,
        replica,
        target_local_draws: headers.every((h) => h.deterministic)
          ? 1
          : input.target_trajectories / 4,
        max_work: maxWork,
        work,
        selected_hypotheses,
      });
      work = JSON.parse(JSON.stringify(next.work));
      if (next.reached_target) {
        result.push(work!);
        break;
      }
    }
  }
  return result;
}
for (const scenario of ["ordinary", "resets", "stiff"] as const) {
  const resets = scenario === "resets";
  Deno.test(`indexed replicas complete and preserve full-population paths through shuffled JSON resumes (${scenario})`, () => {
    const input = fixture(scenario), planner = nativePlanner();
    const full = planner.roomNetworkAdvance({
      ...input,
      max_minute_steps: 100000,
    });
    assert(full.reached_target);
    const workers = replicas(input, 17, [2, 0, 3, 1]);
    for (const worker of workers) {
      assertEquals(
        worker.statistics.total,
        full.work.statistics.replicates[worker.replica].total,
      );
    }
    const merged = planner.roomNetworkMerge({
      network: input.network,
      identity: input.identity,
      seed: input.seed,
      replicas: workers,
    });
    const unpartitioned = planner.roomNetworkMerge({
      network: input.network,
      identity: input.identity,
      seed: input.seed,
      replicas: replicas(input, 100000, [0, 1, 2, 3]),
    });
    assertEquals(merged, unpartitioned);
    assertEquals(merged.statistics.trajectories, 16);
    assertEquals(merged.statistics.replayed_paths, resets ? 32 : 16);
    assertEquals(
      planner.roomNetworkFinalize({
        network: input.network,
        work: merged.work,
      }),
      planner.roomNetworkFinalize({
        network: input.network,
        work: unpartitioned.work,
      }),
    );
    assertThrows(() =>
      planner.roomNetworkMerge({
        network: input.network,
        identity: "other",
        seed: input.seed,
        replicas: workers,
      })
    );
    assertThrows(() =>
      planner.roomNetworkMerge({
        network: input.network,
        identity: input.identity,
        seed: input.seed,
        replicas: [workers[0], ...workers.slice(0, 3)],
      })
    );
  });

  Deno.test(`owned replica reads its catalog only at a draw boundary (${scenario})`, async () => {
    const planner = nativePlanner(), { network, seed, identity, beliefs } = fixture(scenario);
    const node_headers = beliefs.map((belief) => planner.roomNetworkHeader({ belief }));
    const header = await packOwnedPlanningValue({ network, seed, node_headers });
    const records = beliefs.flatMap((belief, node) => belief.hypotheses.map((h, index) => ({ node, index, json: JSON.stringify(h) })));
    const target = 5, replica = 0 as const;
    const input = { network, seed, identity, node_headers, replica, target_local_draws: target, selected_hypotheses: records };
    const expected = planner.roomNetworkReplicaAdvance({ ...input, max_work: 131072 });
    assert(expected.reached_target);
    let stored = planner.roomNetworkReplicaAdvance({ ...input, max_work: 1 }).work;
    assert(stored.path != null);
    const partialCursor = stored.cursor;
    const owner = { job_id: "synthetic-job", home_id: "synthetic-home", fence: 1 };
    const dispatch = { phase: "integrate" as const, cursor: 1, round: 1, target: target * 4, replicas: [replica] };
    let sliceFence = 0;

    async function step(acceptCheckpoint: boolean) {
      const rpcCalls: string[] = [], nativeCalls: string[] = [];
      const trace = new PlanningTrace("synthetic", message => {
        const event = JSON.parse(message);
        if (event.stage === "wasm_execute" && event.phase === "start") nativeCalls.push(event.export);
      });
      const response = await advanceOwnedPlanningWorker({ async rpc(name, args) {
        rpcCalls.push(name);
        assertEquals(args.p_fence, owner.fence);
        if (name === "claim_energy_forecast_replica") return { error: null, data: { dispatch,
          cursor: stored.cursor, work: await packOwnedPlanningValue(stored), header, identity,
          round: 1, slice_fence: ++sliceFence, target_local_draws: target } };
        assertEquals(args.p_slice_fence, sliceFence);
        if (name === "read_energy_forecast_records") {
          const requested = args.p_records as Array<{node: number; index: number}>;
          return { error: null, data: requested.map(({node, index}) => records.find(r => r.node === node && r.index === index)) };
        }
        assertEquals(name, "checkpoint_energy_forecast_replica");
        assertEquals(args.p_cursor, stored.cursor);
        if (!acceptCheckpoint) return { error: null, data: null };
        stored = await unpackOwnedPlanningValue<NativeRoomNetworkReplicaWork>(args.p_work as string);
        assertEquals(args.p_next_cursor, stored.cursor);
        assertEquals(args.p_completed, stored.statistics.trajectories);
        return { error: null, data: dispatch };
      } }, owner, { kind: "replica", replica }, trace);
      assertEquals(response.dispatch, acceptCheckpoint ? dispatch : null);
      return { rpcCalls, nativeCalls };
    }
    const resume = { rpcCalls: ["claim_energy_forecast_replica", "checkpoint_energy_forecast_replica"],
      nativeCalls: ["planner_room_network_replica"] };
    assertEquals(await step(false), resume);
    assertEquals(stored.cursor, partialCursor);
    owner.fence++;
    assertEquals(await step(true), resume);
    assertEquals(stored.statistics.trajectories, 1);
    assertEquals(stored.path, null);
    assertEquals(await step(true), {
      rpcCalls: ["claim_energy_forecast_replica", "read_energy_forecast_records", "checkpoint_energy_forecast_replica"],
      nativeCalls: ["planner_room_network_select", "planner_room_network_replica"],
    });
    assertEquals(stored, expected.work);
  });
}
Deno.test("deterministic catalog uses one exact replica and rejects duplicate execution", () => {
  const input = syntheticJointRoomForecast(2, 0, .25),
    planner = nativePlanner();
  const workers = replicas(input, 100000, [0]);
  const merged = planner.roomNetworkMerge({
    network: input.network,
    identity: input.identity,
    seed: input.seed,
    replicas: workers,
  });
  assertEquals(merged.statistics.trajectories, 1);
  assertEquals(merged.statistics.replayed_paths, 1);
  assertEquals(merged.work.deterministic, true);
  assertEquals(merged.statistics.replicates.map((r) => r.trajectories), [
    1,
    0,
    0,
    0,
  ]);
  const headers = input.beliefs.map((belief) =>
    planner.roomNetworkHeader({ belief })
  );
  assertThrows(() =>
    planner.roomNetworkReplicaAdvance({
      network: input.network,
      node_headers: headers,
      seed: input.seed,
      identity: input.identity,
      replica: 1,
      target_local_draws: 1,
      max_work: 1,
      selected_hypotheses: [],
    })
  );
});
Deno.test("catalog selection preserves antithetic global addresses and missing records request bounded reads", () => {
  const input = fixture(),
    planner = nativePlanner(),
    headers = input.beliefs.map((belief) =>
      planner.roomNetworkHeader({ belief })
    );
  assertEquals(
    planner.roomNetworkSelect({
      node_headers: headers,
      seed: input.seed,
      replica: 2,
      local_draws: [0, 1, 2, 3],
    }).map((x) => x.global_draw),
    [4, 5, 12, 13],
  );
  const next = planner.roomNetworkReplicaAdvance({
    network: input.network,
    node_headers: headers,
    seed: input.seed,
    identity: input.identity,
    replica: 2,
    target_local_draws: 4,
    max_work: 17,
    selected_hypotheses: [],
  });
  assertEquals(next.needs_global_draw, 4);
  assertEquals(next.work.cursor, 0);
  const h = structuredClone(input.beliefs[0]);
  h.hypotheses[0].posterior.covariance[0][2] = 1;
  assertThrows(() => planner.roomNetworkHeader({ belief: h }));
});


Deno.test("native totals validate every index and preserve the privately decoded number vector", () => {
  const previous = z.number().finite().array();
  const sparse = Array<number>(2); sparse[1] = 1;
  const values = [[], [1, -0, -2.5, Number.MAX_VALUE, Number.MIN_VALUE], [null], ["0"], [true], [undefined],
    [NaN], [Infinity], [-Infinity], [Object(4)], new Array(1), sparse, new Uint8Array([1]), {0: 1, length: 1}, null, 3];
  for (const value of values) assertEquals(nativeForecastTotals.safeParse(value).success, previous.safeParse(value).success);
  const wire = "[-0,1.25,3]";
  const first = JSON.parse(wire), second = JSON.parse(wire);
  const checked = nativeForecastTotals.parse(first);
  assert(checked === first);
  assert(Object.is(checked[0], -0));
  checked[1] = 2;
  assertEquals(second[1], 1.25);
});
