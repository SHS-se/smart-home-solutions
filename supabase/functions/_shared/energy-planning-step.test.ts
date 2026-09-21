import { replanReference } from "./replan-continuity.ts";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { snapshot, snapshotV8 } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import {
  generateOptimisationPlan,
  generateOptimisationPlanWithBatteryProjection,
  type OptimisationSnapshot,
} from "./energy-optimisation.ts";
import {
  assembleOptimisationPlan,
  energyPlanningStep,
  type PlanningBudget,
} from "./energy-planning-step.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";
import type { DispatchCheckpoint, DispatchResult } from "./dispatch-plan.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import {
  EnergyPlanningError,
  generateRemoteOptimisationPlan,
} from "./energy-planning-client.ts";
import type { FixedEnergyPlan } from "./fixed-energy-plan.ts";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const inputFor = (snapshot: OptimisationSnapshot): EnergyPlanningInput => ({
  snapshot,
  now: snapshot.captured_at,
  price_archive: [],
});

/** A worker call's budget that runs out after `checks` pause points. */
const countedBudget = (checks: number): () => PlanningBudget => () => {
  let used = 0;
  return { spent: () => ++used > checks, allowsAuction: () => used <= checks };
};

/**
 * Runs the chain over JSON as ingest does, one budget per call, and checks the
 * assembled plan against the synchronous planner. Returns how many calls it
 * took and how often a stage paused part-way.
 */
function assertStagesMatch(
  input: EnergyPlanningInput,
  budget?: () => PlanningBudget,
) {
  const original = wire(input);
  const expected = generateOptimisationPlan(
    input.snapshot,
    new Date(input.now),
    input.price_archive,
    input.resolved_price_outlook,
    input.fixed_plan,
  );
  const completed: DispatchResult[] = [];
  let checkpoint: DispatchCheckpoint | undefined;
  const seen = new Set<string>();
  const counts = { calls: 0, transfers: 0, refinement: 0 };
  for (let i = 0; i < 4096; i++) {
    counts.calls++;
    const step: EnergyPlanningStep = wire(
      energyPlanningStep(wire(input), wire({ completed, checkpoint }), budget?.()),
    );
    completed.push(...step.completed);
    checkpoint = step.checkpoint;
    if (step.done) {
      assertEquals(checkpoint, undefined);
      assertEquals(
        wire(assembleOptimisationPlan(wire(input), completed).plan),
        wire(expected),
      );
      assertEquals(input, original);
      if (!budget) assert(seen.has("transfers") && seen.has("refinement"));
      return counts;
    }
    if (checkpoint) seen.add(checkpoint.next);
    if (checkpoint?.transferred) counts.transfers++;
    if (checkpoint?.refinement) counts.refinement++;
  }
  throw new Error("Planning did not finish");
}

const seasonInput = (season: "sunny" | "dark") => {
  const input = inputFor(snapshot());
  if (season === "dark") {
    input.snapshot.slots = input.snapshot.slots.map((slot, i) => ({
      ...slot,
      pv_forecast_w: 0,
      import_price_sek_per_kwh: 1.5 + Math.sin(i * .15) * .7,
      export_price_sek_per_kwh: .2,
    }));
  }
  return input;
};

for (const season of ["sunny", "dark"] as const) {
  Deno.test(`distributed 288-quarter ${season} plan preserves every command and diagnostic`, () => {
    const counts = assertStagesMatch(seasonInput(season));
    assertEquals([counts.transfers, counts.refinement], [0, 0]);
  });

  Deno.test(`distributed ${season} plan survives transfer and refinement stages paused part-way`, () => {
    // A worker whose CPU budget is spent checkpoints between two transfers or
    // two refinement trials; the resumed stages must reach exactly the plan an
    // uninterrupted solve does.
    const counts = assertStagesMatch(seasonInput(season), countedBudget(25));
    assert(counts.transfers > 0 && counts.refinement > 0, JSON.stringify(counts));
  });

  Deno.test(`distributed ${season} plan crosses every boundary in memory when the budget allows`, () => {
    const counts = assertStagesMatch(seasonInput(season), () => ({
      spent: () => false,
      allowsAuction: () => true,
    }));
    assertEquals(counts.calls, 1);
  });
}

Deno.test("distributed planning preserves discrete EV alternatives", () => {
  assertStagesMatch(inputFor(dispatchedEvSnapshot()));
});

for (const from of [0, 4]) {
  Deno.test(`distributed fixed plan at slot ${from} preserves prefix and resumed suffix`, () => {
    const input = inputFor(dispatchedEvSnapshot());
    const base = generateOptimisationPlan(input.snapshot, new Date(input.now));
    const slots = base.plans.priority.slots.slice(from, from + 4);
    const fixed: FixedEnergyPlan = {
      id: "fixed",
      source_snapshot_id: input.snapshot.snapshot_id,
      starts_at: slots[0].start,
      ends_at: new Date(Date.parse(slots.at(-1)!.start) + 900_000)
        .toISOString(),
      slots: slots.map((slot) => ({
        start: slot.start,
        power_w: { ev: 0 },
        discharge_w: { ev: 0 },
        targets: slot,
        allow_export: false,
      })),
    };
    input.fixed_plan = fixed;
    assertStagesMatch(input);
  });
}

const connection = {
  url: "https://planner.test",
  planningSecret: "test-planning-secret",
  requestId: "test-request",
};
const request = (authorization: string, body: object) =>
  new Request(`${connection.url}/functions/v1/energy-optimisation-plan-step`, {
    method: "POST",
    headers: { authorization, "x-request-id": connection.requestId },
    body: JSON.stringify(body),
  });

Deno.test("planning endpoint refuses device and ordinary user credentials", async () => {
  for (const authorization of ["", "Bearer shs_device", "Bearer user-jwt"]) {
    const response = await handleEnergyPlanningStep(
      request(authorization, {}),
      connection.planningSecret,
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
  }
});

Deno.test("planning endpoint fails closed when its service credential is missing", async () => {
  const response = await handleEnergyPlanningStep(request("Bearer ", {}), "");
  assertEquals(response.status, 503);
  await response.body?.cancel();
});

Deno.test("ingest client completes real planning over serialized stage requests", async () => {
  const input = inputFor(dispatchedEvSnapshot());
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assertEquals(
      new URL(String(url)).pathname,
      "/functions/v1/energy-optimisation-plan-step",
    );
    return await handleEnergyPlanningStep(
      new Request(url, init),
      connection.planningSecret,
    );
  };
  const result = await generateRemoteOptimisationPlan(
    input,
    connection,
    fetcher,
  );
  assert(calls >= 1);
  assertEquals(
    result,
    wire(generateOptimisationPlanWithBatteryProjection(input.snapshot, new Date(input.now))),
  );
});

Deno.test("ingest client accumulates each call's auctions and checkpoint across many calls", async () => {
  // A worker with almost no budget: every call pauses or ends at a boundary,
  // so the client must carry the continuation exactly, call after call.
  const input = inputFor(snapshot());
  let calls = 0;
  let resumed = 0;
  const fetcher: typeof fetch = (_url, init) => {
    calls++;
    const body = JSON.parse(String(init!.body));
    assertEquals(body.protocol, ENERGY_PLANNING_PROTOCOL);
    if (body.continuation.checkpoint) resumed++;
    const step = energyPlanningStep(
      body.input,
      body.continuation,
      countedBudget(40)(),
    );
    return Promise.resolve(Response.json({
      protocol: ENERGY_PLANNING_PROTOCOL,
      request_id: connection.requestId,
      ...step,
    }));
  };
  const result = await generateRemoteOptimisationPlan(
    input,
    connection,
    fetcher,
  );
  assert(calls > 3 && resumed > 0, JSON.stringify({ calls, resumed }));
  assertEquals(
    result,
    wire(generateOptimisationPlanWithBatteryProjection(input.snapshot, new Date(input.now))),
  );
});

Deno.test("worker CPU termination becomes a planning error without retrying or solving inline", async () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return Promise.resolve(
      Response.json({ code: "WORKER_RESOURCE_LIMIT" }, { status: 546 }),
    );
  };
  await assertRejects(
    () =>
      generateRemoteOptimisationPlan(
        inputFor(dispatchedEvSnapshot()),
        connection,
        fetcher,
      ),
    EnergyPlanningError,
    "HTTP 546",
  );
  assertEquals(calls, 1);
});

Deno.test("worker contract errors and malformed responses fail explicitly", async () => {
  const input = inputFor(dispatchedEvSnapshot());
  for (
    const body of [
      { protocol: 999, request_id: connection.requestId, done: false },
      { protocol: ENERGY_PLANNING_PROTOCOL, request_id: "wrong", done: false },
      {
        protocol: ENERGY_PLANNING_PROTOCOL,
        request_id: connection.requestId,
        done: false,
      },
      {
        protocol: ENERGY_PLANNING_PROTOCOL,
        request_id: connection.requestId,
        done: true,
        completed: [],
        checkpoint: {},
      },
      {
        protocol: ENERGY_PLANNING_PROTOCOL,
        request_id: connection.requestId,
        done: "yes",
        completed: [],
      },
    ]
  ) {
    await assertRejects(
      () =>
        generateRemoteOptimisationPlan(
          input,
          connection,
          () => Promise.resolve(Response.json(body)),
        ),
      EnergyPlanningError,
    );
  }
  await assertRejects(
    () =>
      generateRemoteOptimisationPlan(
        input,
        connection,
        () => Promise.resolve(new Response("not json", { status: 502 })),
      ),
    EnergyPlanningError,
    "without a planning response",
  );
});

Deno.test("invalid snapshot remains a caller error across the worker boundary", async () => {
  const input = inputFor(dispatchedEvSnapshot());
  input.snapshot.slots = [];
  const error = await assertRejects(
    () =>
      generateRemoteOptimisationPlan(
        input,
        connection,
        (url, init) =>
          handleEnergyPlanningStep(
            new Request(url, init),
            connection.planningSecret,
          ),
      ),
    EnergyPlanningError,
  );
  assertEquals(error.status, 400);
});

Deno.test("distributed planning preserves continuity candidates and selection", () => {
  const input = inputFor(snapshotV8());
  input.snapshot.slots.forEach(s => {
    if (s.import_price_sek_per_kwh !== null) s.import_price_sek_per_kwh *= .1;
    if (s.export_price_sek_per_kwh !== null) s.export_price_sek_per_kwh *= .1;
  });
  const previous = generateOptimisationPlan(input.snapshot, new Date(input.now));
  input.snapshot.snapshot_id = "00000000-0000-4000-8000-000000000002";
  input.snapshot.replan_reference = replanReference(previous, input.snapshot, new Date(input.now));
  input.snapshot.replan_reference!.battery!.discharge_w -= 10;
  assertStagesMatch(input);
});

Deno.test("distributed planning preserves the remaining horizon across a quarter boundary", () => {
  const input = inputFor(snapshot());
  const boundary = Date.parse(input.snapshot.slots[1].start);
  input.snapshot.captured_at = new Date(boundary - 5_000).toISOString();
  input.now = new Date(boundary + 20_000).toISOString();
  assertStagesMatch(input);
});

Deno.test("a worker cannot finish a plan it has not solved", async () => {
  // Ingest assembles the plan by replaying the worker's auctions and never
  // searches itself: a missing auction is a planning failure, not work to do.
  const input = inputFor(dispatchedEvSnapshot());
  let calls = 0;
  await assertRejects(
    () =>
      generateRemoteOptimisationPlan(input, connection, () => {
        calls++;
        return Promise.resolve(Response.json({
          protocol: ENERGY_PLANNING_PROTOCOL,
          request_id: connection.requestId,
          done: true,
          completed: [],
        }));
      }),
    EnergyPlanningError,
    "do not assemble into a plan",
  );
  assertEquals(calls, 1);
});
