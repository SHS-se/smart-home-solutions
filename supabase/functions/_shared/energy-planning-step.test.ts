import { replanReference } from "./replan-continuity.ts";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { snapshot, snapshotV8 } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import {
  generateOptimisationPlan,
  generateOptimisationPlanWithBatteryProjection,
  type OptimisationSnapshot,
} from "./energy-optimisation.ts";
import { energyPlanningStep } from "./energy-planning-step.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningContinuation,
  type EnergyPlanningInput,
} from "./energy-planning-protocol.ts";
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

/** Returns how many times the transfer and refinement stages paused part-way. */
function assertStagesMatch(
  input: EnergyPlanningInput,
  budgetSpent?: () => boolean,
): { transfers: number; refinement: number } {
  const original = wire(input);
  const expected = generateOptimisationPlan(
    input.snapshot,
    new Date(input.now),
    input.price_archive,
    input.resolved_price_outlook,
    input.fixed_plan,
  );
  let continuation: EnergyPlanningContinuation | undefined;
  const seen = new Set<string>();
  const paused = { transfers: 0, refinement: 0 };
  for (let i = 0; i < 512; i++) {
    const step = energyPlanningStep(wire(input), continuation, budgetSpent);
    if (step.done === true) {
      assertEquals(wire(step.plan), wire(expected));
      assertEquals(input, original);
      assert(seen.has("transfers") && seen.has("refinement"));
      return paused;
    }
    continuation = wire(step.continuation);
    if (continuation.checkpoint) seen.add(continuation.checkpoint.next);
    if (continuation.checkpoint?.transferred) paused.transfers++;
    if (continuation.checkpoint?.refinement) paused.refinement++;
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
    assertEquals(assertStagesMatch(seasonInput(season)), {
      transfers: 0,
      refinement: 0,
    });
  });

  Deno.test(`distributed ${season} plan survives transfer and refinement stages paused part-way`, () => {
    // A worker whose CPU budget is spent checkpoints between two transfers or
    // two refinement trials; the resumed stages must reach exactly the plan an
    // uninterrupted solve does.
    let checks = 0;
    const paused = assertStagesMatch(
      seasonInput(season),
      () => ++checks % 25 === 0,
    );
    assert(paused.transfers > 0 && paused.refinement > 0, JSON.stringify(paused));
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
  assert(calls >= 4);
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
        plan: { snapshot_id: "wrong" },
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

Deno.test("worker cannot drop or substitute the exact battery projection", async () => {
  const input = inputFor(dispatchedEvSnapshot());
  const plan = generateOptimisationPlan(input.snapshot, new Date(input.now));
  for (const projection of [undefined, { status: "ready" },
    { status: "ready", provenance: { snapshot_id: "wrong", issued_at: plan.issued_at } },
    { status: "ready", provenance: { snapshot_id: plan.snapshot_id, issued_at: "wrong" } }]) {
    await assertRejects(() => generateRemoteOptimisationPlan(input, connection, () => Promise.resolve(
      Response.json({ protocol: ENERGY_PLANNING_PROTOCOL, request_id: connection.requestId,
        done: true, plan, battery_projection: projection }),
    )), EnergyPlanningError, "missing or mismatched battery projection");
  }
});
