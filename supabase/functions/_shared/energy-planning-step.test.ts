import { wire, inputFor, countedBudget, assertStagesMatch, seasonInput } from "./energy-planning-step.fixture.ts";
import { solvedPlan } from "./planner/solved-plan.fixture.ts";
import { replanReference } from "./planner/replan-continuity.ts";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { snapshot, snapshotV8 } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateOptimisationPlan } from "./planner/energy-optimisation.ts";
import { createPlanningBudget, energyPlanningStep } from "./energy-planning-step.ts";
import { ENERGY_PLANNING_PROTOCOL } from "./energy-planning-protocol.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import {
  EnergyPlanningError,
  generateRemoteOptimisationPlan,
} from "./energy-planning-client.ts";
import type { FixedEnergyPlan } from "./planner/fixed-energy-plan.ts";

Deno.test("worker slices stop on elapsed time instead of an unrelated operation count", () => {
  const original = performance.now;
  let elapsed = 0;
  performance.now = () => elapsed;
  try {
    const budget = createPlanningBudget();
    let paused = false;
    for (let count = 0; count < 2_000_001; count += 1) paused ||= budget.spent();
    assertEquals(paused, false);
    assertEquals(budget.allowsAuction(), true);
    elapsed = 900;
    assertEquals(budget.spent(), true);
    assertEquals(budget.allowsAuction(), false);
    const counted = createPlanningBudget(900, 2);
    assertEquals(counted.spent(), false);
    assertEquals(counted.spent(), false);
    assertEquals(counted.spent(), true);
  } finally {
    performance.now = original;
  }
});

Deno.test("a slice prepares the household once while completing multiple auctions", () => {
  const input = inputFor(snapshot());
  const captured = input.snapshot;
  let preparations = 0;
  Object.defineProperty(input, "snapshot", {
    get: () => {
      preparations += 1;
      return captured;
    },
  });
  const step = energyPlanningStep(input, undefined, createPlanningBudget(60_000));
  assertEquals(step.done, true);
  assert(step.completed.length > 1);
  assertEquals(preparations, 1);
});

Deno.test("a spent slice saves a finished auction before doing its caller's next work", () => {
  const captured = snapshot();
  captured.pool = null;
  captured.capabilities.pool = false;
  const input = inputFor(captured);
  const step = energyPlanningStep(input, undefined, {
    spent: () => false,
    allowsAuction: () => false,
  });
  assertEquals(step.done, false);
  assertEquals(step.completed.length, 1);
  assertEquals(step.checkpoint, undefined);
  const resumed = energyPlanningStep(input, {
    completed: step.completed,
    rankings: step.rankings,
  }, createPlanningBudget(60_000));
  assertEquals(resumed.done, true);
});

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
    wire(solvedPlan(input.snapshot, new Date(input.now))),
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
      countedBudget(250_000)(),
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
    wire(solvedPlan(input.snapshot, new Date(input.now))),
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
          rankings: [],
        }));
      }),
    EnergyPlanningError,
    "do not assemble into a plan",
  );
  assertEquals(calls, 1);
});

Deno.test("response rankings pause before an auction and survive JSON reconstruction", () => {
  const input = seasonInput("sunny");
  input.snapshot.slots = input.snapshot.slots.slice(0, 12);
  const counts = assertStagesMatch(input, () => {
    const budget = countedBudget(2)();
    return {...budget, allowsAuction: () => false};
  });
  assert(counts.rankings > 0);
  assert(counts.rankingOnly > 0);
});

Deno.test("the household deadline is not reset by a successful stage response", async () => {
  const input = inputFor(dispatchedEvSnapshot());
  const error = await assertRejects(() => generateRemoteOptimisationPlan(input, {
    ...connection, deadline: performance.now()+10,
  }, async () => {
    await new Promise(resolve => setTimeout(resolve,25));
    return Response.json({ protocol: ENERGY_PLANNING_PROTOCOL, request_id: connection.requestId,
      done: false, completed: [], rankings: [] });
  }), EnergyPlanningError, "request deadline");
  assertEquals(error.code,"planning_deadline_exceeded");
});
