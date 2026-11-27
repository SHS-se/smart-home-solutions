import { cpuConnectedRoomPlanningSource, cpuMixedRoomPlanningSource, cpuVaryingRoomTargetPlanningSource } from "../../../tests/planner-handler-cpu.fixture.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { solveRulesPlan, type PreparedRulesInput } from "./rules-planner.ts";
import { prepareCapturedRulesInput, executeRulesPlanning } from "./rules-planning-execution.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { completedRemoteCapture, EnergyPlanningError, generateRemoteRulesPlan, validRoomPreparationAdvance, RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";
import { ROOM_NETWORK_WORK_REVISION } from "./room-network-contract.ts";
import type { RoomPreparationProgress } from "./rules-room-services.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { MAX_PLANNING_BODY_BYTES } from "./planning-transport-limits.ts";
import { createPlannerProbe } from "./planner-wasm/probe.ts";
import { SOLVER_BASE64 } from "./planner-wasm/solver-bytes.ts";
import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };

const connection = { url: "https://planner.test", planningSecret: "private", requestId: "test-request" };
Deno.test("native preparation resolves only replay path counts without replacing captured seed or physical inputs", () => {
  const capture = captureRulesPlanningInput(cpuConnectedRoomPlanningSource(), null, resolveRulePolicy());
  const original = structuredClone(capture);
  const prepared = { snapshot: structuredClone(capture.snapshot) } as PreparedRulesInput;
  Object.assign(prepared.snapshot.room_network!.forecast, { trajectories: 128, replayed_paths: 256, replicate_trajectories: [32, 32, 32, 32] });
  const completed = completedRemoteCapture(capture, prepared);
  assertEquals(capture, original, 'admission is not changed');
  const expected = structuredClone(original);
  Object.assign(expected.snapshot.room_network!.forecast, { trajectories: 128, replayed_paths: 256, replicate_trajectories: [32, 32, 32, 32] });
  assertEquals(completed, expected);
  assertEquals(completedRemoteCapture(completed, prepared), completed, 'repeated preparation is idempotent');
  for (const replayed_paths of [undefined, 127, 256.5, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = structuredClone(prepared);
    Object.assign(malformed.snapshot.room_network!.forecast, { replayed_paths });
    assertThrows(() => completedRemoteCapture(capture, malformed), EnergyPlanningError, 'numerical identity');
  }
  const changedPaths = structuredClone(prepared);
  changedPaths.snapshot.room_network!.forecast.replayed_paths = 257;
  assertThrows(() => completedRemoteCapture(completed, changedPaths), EnergyPlanningError, 'numerical identity');
  for (const field of ['seed', 'runtime', 'wasm_sha256', 'accuracy_revision'] as const) {
    const changed = structuredClone(prepared);
    Object.assign(changed.snapshot.room_network!.forecast, { [field]: field === 'seed' ? [1, 2] : 'different' });
    assertThrows(() => completedRemoteCapture(capture, changed), EnergyPlanningError, 'numerical identity');
  }
  const changed = structuredClone(prepared);
  changed.snapshot.room_network!.forecast.trajectories = 256;
  changed.snapshot.room_network!.forecast.replicate_trajectories = [64, 64, 64, 64];
  assertThrows(() => completedRemoteCapture(completed, changed), EnergyPlanningError, 'numerical identity');
});
Deno.test("joint replay progress keeps its final room index while strictly advancing native work", () => {
  const source = cpuVaryingRoomTargetPlanningSource();
  source.snapshot.thermal_zones = source.snapshot.thermal_zones!.slice(0, 2);
  const capture = captureRulesPlanningInput(source, null, resolveRulePolicy());
  const progress: RoomPreparationProgress = { snapshot_id: capture.snapshot.snapshot_id, next_room: 1,
    services: { commands: {}, power: {}, room_power: {}, temperature: {}, unplanned_temperature: {}, unplanned_power: {}, warnings: [] } };
  const pending: RoomPreparationProgress = { ...progress, next_room: 2, forecast_pending: true };
  const barrier: RoomPreparationProgress = { ...progress, next_room: 2,
    network_work: { revision: ROOM_NETWORK_WORK_REVISION, cursor: 1, target_trajectories: 128,
      replicas: [null, null, null, null] } };
  assertEquals(validRoomPreparationAdvance(capture, null, progress), true);
  assertEquals(validRoomPreparationAdvance(capture, progress, pending), true);
  assertEquals(validRoomPreparationAdvance(capture, pending, barrier), true);
  assertEquals(validRoomPreparationAdvance(capture, progress, barrier), false, "compile follows a durable final-proposal boundary");
  assertEquals(validRoomPreparationAdvance(capture, pending, pending), false, "pending compilation cannot repeat without progress");
  assertEquals(validRoomPreparationAdvance(capture, null, pending), false, "pending compilation cannot skip ordered proposals");
  assertEquals(validRoomPreparationAdvance(capture, progress, { ...pending, next_room: 1 }), false);
  assertEquals(validRoomPreparationAdvance(capture, pending, { ...barrier, forecast_pending: true }), false);
  assertEquals(validRoomPreparationAdvance(capture, barrier, pending), false, "native work cannot rewind to compile");
  assertEquals(validRoomPreparationAdvance(capture, barrier, { ...barrier, network_work: { ...barrier.network_work!, cursor: 2 } }), true);
  for (const invalid of [barrier, { ...barrier, next_room: 1 }, { ...barrier, snapshot_id: 'different' },
    { ...barrier, network_work: { ...barrier.network_work!, cursor: 0 } },
    { ...barrier, network_work: { ...barrier.network_work!, cursor: NaN } },
    { ...barrier, network_work: { ...barrier.network_work!, revision: 'other' } }]) {
    assertEquals(validRoomPreparationAdvance(capture, barrier, invalid as RoomPreparationProgress), false);
  }
  assertEquals(validRoomPreparationAdvance(capture, null, barrier), false, 'cannot skip ordered room proposals');
});
function input() {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.captured_at = snapshot.slots[0].start;
  return captureRulesPlanningInput({ snapshot, now: snapshot.captured_at,
    resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1,
      level_sek_per_kwh: 1, shadow_import_sek_per_kwh: snapshot.slots.map(() => 1) } }, null, resolveRulePolicy());
}
Deno.test("transport prepares, solves and assembles the same capture in separate authenticated worker calls", async () => {
  let calls = 0;
  const fetcher: typeof fetch = (url, init) => {
    calls++;
    assertEquals(new Headers(init?.headers).get("x-shs-planning-secret"), connection.planningSecret);
    return handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  const prepared = input();
  const result = await generateRemoteRulesPlan(prepared, connection, fetcher);
  assertEquals(calls, 3);
  assertEquals(result, JSON.parse(JSON.stringify(executeRulesPlanning(prepared))));
  assertEquals(result.plan.snapshot_id, prepared.snapshot.snapshot_id);
  assertEquals(result.plan.plans.priority.slots.length, 8);
});
Deno.test("one-shot transport refuses mismatched protocol or request identity without replay", async () => {
  for (const response of [{ protocol: 8, request_id: connection.requestId },
    { protocol: RULES_PLANNING_PROTOCOL, request_id: "wrong-request" }]) {
    let calls = 0;
    await assertRejects(() => generateRemoteRulesPlan(input(), connection, () => {
      calls++; return Promise.resolve(Response.json(response));
    }), Error, "mismatch");
    assertEquals(calls, 1);
  }
});
Deno.test("one-shot transport fails once on an unreachable worker and expired deadline", async () => {
  let calls = 0;
  const offline: typeof fetch = () => { calls++; return Promise.reject(new Error("offline")); };
  await assertRejects(() => generateRemoteRulesPlan(input(), connection, offline), Error, "could not be reached");
  assertEquals(calls, 1);
  await assertRejects(() => generateRemoteRulesPlan(input(), { ...connection, deadline: -1 }, offline), Error, "deadline");
  assertEquals(calls, 1);
});
Deno.test("one-shot worker requires its private secret and rejects auction protocol", async () => {
  const call = (protocol: number, secret: string) => handleEnergyPlanningStep(new Request(`${connection.url}/solve`, {
    method: "POST", headers: { "x-shs-planning-secret": secret }, body: JSON.stringify({ protocol, input: input() }),
  }), connection.planningSecret);
  assertEquals((await call(RULES_PLANNING_PROTOCOL, "wrong")).status, 401);
  assertEquals((await call(8, connection.planningSecret)).status, 409);
});

Deno.test("private TEST probe executes the complete handler and returns an output digest", async () => {
  const probe = createPlannerProbe(SOLVER_BASE64, artifact, runtime.recipe, "private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const solved = solveRulesPlan(prepareCapturedRulesInput(input()));
  const response = await probe(new Request("https://probe.test", { method: "POST",
    headers: { authorization: "Bearer private" },
    body: JSON.stringify({ mode: "handler", stage: "assemble", protocol: RULES_PLANNING_PROTOCOL, input: solved }) }));
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.slots, 8);
  assertEquals(result.build, artifact);
  const local = await handleEnergyPlanningStep(new Request("https://probe.test/plan", { method: "POST",
    headers: { "x-shs-planning-secret": "private", "x-request-id": "handler-probe" },
    body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "assemble", input: solved }) }), "private");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify((await local.json()).result)));
  assertEquals(result.result_sha256, Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""));
});

Deno.test("private TEST probe accepts worker-sized captures and bounds the streamed body", async () => {
  const probe = createPlannerProbe(SOLVER_BASE64, artifact, runtime.recipe, "private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const body = JSON.stringify({ mode: "handler", stage: "solve", protocol: RULES_PLANNING_PROTOCOL,
    input: prepareCapturedRulesInput(input()) });
  const request = (value: string) => new Request("https://probe.test", { method: "POST",
    headers: { authorization: "Bearer private" }, body: value });
  // JSON whitespace tests transport size independently of planner complexity.
  const response = await probe(request(body + " ".repeat(600_000)));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).slots, 8);
  const oversized = await probe(request(" ".repeat(MAX_PLANNING_BODY_BYTES + 1)));
  assertEquals(oversized.status, 413);
  assertEquals(await oversized.json(), { error: "probe_payload_too_large" });
});

Deno.test("transport rejects crossed stage responses and never solves a different capture", async () => {
  for (const corrupt of ["stage", "snapshot", "model"] as const) {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      const response = await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
      const body = await response.json();
      if (corrupt === "stage") body.stage = "solve";
      else if (corrupt === "snapshot") body.prepared.snapshot.snapshot_id = "other";
      else body.prepared.model_version = "other";
      return Response.json(body);
    };
    await assertRejects(() => generateRemoteRulesPlan(input(), connection, fetcher), Error,
      corrupt === "stage" ? "mismatch" : "invalid prepared input");
    assertEquals(calls, 1);
  }
});

Deno.test("transport shares its deadline across preparation and solve without publishing partial work", async () => {
  let calls = 0;
  const deadline = performance.now() + 30;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const response = await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
    // A valid but delayed prepare reply cannot renew the request's deadline.
    await new Promise(resolve => setTimeout(resolve, 40));
    return response;
  };
  await assertRejects(() => generateRemoteRulesPlan(input(), { ...connection, deadline }, fetcher), Error, "deadline");
  assertEquals(calls, 1);
});

Deno.test("separate worker stages preserve mixed-room, household and hot-water ordering exactly", async () => {
  const source = cpuMixedRoomPlanningSource();
  const capture = captureRulesPlanningInput(source, null, resolveRulePolicy());
  const before = structuredClone(capture);
  const expected = executeRulesPlanning(capture);
  const phases: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const submitted = JSON.parse(String(init?.body));
    phases.push(submitted.stage);
    if (submitted.stage === "prepare") {
      assertEquals("problem" in submitted.input, false);
      assertEquals("rooms" in submitted.input, false);
    } else {
      const prepared = submitted.stage === "solve" ? submitted.input : submitted.input.input;
      assertEquals(Object.keys(prepared.rooms.commands).length, 4);
    }
    return await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  const result = await generateRemoteRulesPlan(capture, connection, fetcher);
  assertEquals(phases, ["prepare", "solve", "assemble"]);
  assertEquals(result, JSON.parse(JSON.stringify(expected)));
  assertEquals(capture, before);
});

Deno.test("room preparation crosses request boundaries with exactly the same allocation and plan", async () => {
  const source = cpuVaryingRoomTargetPlanningSource();
  source.snapshot.thermal_zones = source.snapshot.thermal_zones!.slice(0, 2);
  const capture = captureRulesPlanningInput(source, null, resolveRulePolicy());
  const before = structuredClone(capture);
  const calls: [string, number | null][] = [];
  const fetcher: typeof fetch = (url, init) => {
    const submitted = JSON.parse(String(init?.body));
    calls.push([submitted.stage, submitted.room_progress?.next_room ?? null]);
    return handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  const remote = await generateRemoteRulesPlan(capture, connection, fetcher);
  assertEquals(calls, [["prepare", null], ["prepare", 1], ["solve", null], ["assemble", null]]);
  assertEquals(remote, JSON.parse(JSON.stringify(executeRulesPlanning(capture))));
  assertEquals(capture, before);

  const corrupt: typeof fetch = async (url, init) => {
    const response = await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
    const body = await response.json();
    body.room_progress.snapshot_id = "a different capture";
    return Response.json(body);
  };
  await assertRejects(() => generateRemoteRulesPlan(capture, connection, corrupt), Error, "invalid room progress");
});

Deno.test("worker failures preserve retry, recapture and terminal disposition across HTTP", async () => {
  for (const [status, code, disposition] of [[429, "busy", "retry"], [546, "cpu_limit", "retry"],
    [400, "invalid_snapshot", "terminal"], [401, "unauthorized", "terminal"],
    [503, "planner_not_configured", "terminal"], [409, "planner_upgraded", "recapture"]] as const) {
    const error = await assertRejects(() => generateRemoteRulesPlan(input(), connection,
      () => Promise.resolve(Response.json({error: code}, {status}))), EnergyPlanningError);
    assertEquals(error.code, code);
    assertEquals(error.disposition, disposition);
  }
});


Deno.test("owned dispatch awaits a failed writer's sibling before leaving unstarted replicas for the next exchange", async () => {
  const { advanceOwnedPlanning } = await import('./rules-planning-client.ts');
  const owner = { home_id:'synthetic-home',job_id:'synthetic-job',fence:1 };
  const done: number[] = []; let active=0,maxActive=0,requests=0;
  await assertRejects(()=>advanceOwnedPlanning(owner,connection,async(_url,init)=>{
    requests++; const body=JSON.parse(String(init?.body));
    assertEquals(body.input,undefined); assertEquals(body.owner,owner);
    if(body.action.kind==='advance') return Response.json({protocol:RULES_PLANNING_PROTOCOL,request_id:connection.requestId,stage:'owned',
      dispatch:{phase:'integrate',cursor:8,target:64,round:1,replicas:[0,1,2,3]}});
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,body.action.replica===0?1:5));
    active--;done.push(body.action.replica);
    if(body.action.replica===0) return Response.json({error:'synthetic_retry'},{status:503});
    return Response.json({protocol:RULES_PLANNING_PROTOCOL,request_id:connection.requestId,stage:'owned',
      dispatch:{phase:'integrate',cursor:8,target:64,round:1,replicas:[]}});
  }),EnergyPlanningError,'synthetic_retry');
  assertEquals(maxActive,2);assertEquals(active,0);assertEquals(done.sort(),[0,1]);assertEquals(requests,3);
});

Deno.test("owned dispatch stops launching waves near the shared deadline and rejects malformed replica lists", async () => {
  const { advanceOwnedPlanning } = await import('./rules-planning-client.ts');
  const owner={home_id:'synthetic-home',job_id:'synthetic-job',fence:1};let requests=0;
  const reply=(replicas:number[])=>Response.json({protocol:RULES_PLANNING_PROTOCOL,request_id:connection.requestId,stage:'owned',
    dispatch:{phase:'integrate',cursor:8,target:64,round:1,replicas}});
  assertEquals((await advanceOwnedPlanning(owner,{...connection,deadline:performance.now()+500},()=>{
    requests++;return Promise.resolve(reply([0,1,2,3]));
  })).dispatch?.phase,'integrate');
  assertEquals(requests,1);
  for(const invalid of [[0,0],[4],[-1],[.5]]) {
    await assertRejects(()=>advanceOwnedPlanning(owner,connection,()=>Promise.resolve(reply(invalid))),EnergyPlanningError,'Invalid owned planning dispatch');
  }
});

Deno.test("owned exchange shares its hosted call allowance across fan-out and barriers", async () => {
  const { advanceOwnedPlanning, OWNED_WORKER_CALLS_PER_EXCHANGE } = await import('./rules-planning-client.ts');
  let calls=0,replicaCalls=0;
  const result=await advanceOwnedPlanning({home_id:'synthetic',job_id:'synthetic',fence:1},connection,(_url,init)=>{
    calls++;if(JSON.parse(String(init?.body)).action.kind==='replica')replicaCalls++;
    return Promise.resolve(Response.json({protocol:RULES_PLANNING_PROTOCOL,request_id:connection.requestId,stage:'owned',
      dispatch:{phase:'integrate',cursor:8,target:1024,round:1,replicas:[0,1,2,3]}}));
  });
  assertEquals(result.dispatch?.phase,'integrate');
  assertEquals(replicaCalls%4,0);assertEquals(calls,21);assertEquals(calls<=OWNED_WORKER_CALLS_PER_EXCHANGE,true);
  assertEquals(OWNED_WORKER_CALLS_PER_EXCHANGE<30,true);
});
Deno.test("owned dispatch gives each listed replica one turn and reads the barrier after the last pair", async () => {
  const { advanceOwnedPlanning } = await import('./rules-planning-client.ts');
  const replicas = [3, 0, 2, 1];
  const started: number[] = [], finished: number[] = [];
  let advances = 0, active = 0, peak = 0;
  const reply = (phase: string) => Response.json({ protocol: RULES_PLANNING_PROTOCOL, request_id: connection.requestId, stage: 'owned',
    dispatch: { phase, cursor: 8, target: 64, round: 1, replicas: phase === 'ready' ? [] : replicas } });
  const result = await advanceOwnedPlanning({home_id:'synthetic',job_id:'synthetic',fence:1},connection,async(_url,init)=>{
    const { action } = JSON.parse(String(init?.body));
    if (action.kind === 'advance') {
      assertEquals(active, 0);
      if (++advances === 1) return reply('integrate');
      assertEquals(finished, replicas);
      return reply('ready');
    }
    if (started.length === 2) assertEquals(finished, replicas.slice(0, 2));
    started.push(action.replica);
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    finished.push(action.replica);
    return reply('integrate');
  });
  assertEquals(result.dispatch?.phase, 'ready');
  assertEquals(started, replicas);
  assertEquals(peak, 2);
  assertEquals(advances, 2);
});

Deno.test("owned dispatch leaves the next pair unclaimed when the current pair uses the exchange deadline", async () => {
  const { advanceOwnedPlanning } = await import('./rules-planning-client.ts');
  const started: number[] = [];
  let now = 0, advances = 0;
  const original = performance.now;
  try {
    performance.now = () => now;
    const result = await advanceOwnedPlanning({home_id:'synthetic',job_id:'synthetic',fence:1},{...connection,deadline:25_000},async(_url,init)=>{
      const { action } = JSON.parse(String(init?.body));
      if (action.kind === 'advance') advances++;
      else {
        started.push(action.replica);
        await Promise.resolve();
        now = 24_000;
      }
      return Response.json({ protocol: RULES_PLANNING_PROTOCOL, request_id: connection.requestId, stage: 'owned',
        dispatch:{phase:'integrate',cursor:8,target:64,round:1,replicas:[0,1,2,3]} });
    });
    assertEquals(result.dispatch?.phase, 'integrate');
    assertEquals(started, [0,1]);
    assertEquals(advances, 1);
  } finally { performance.now = original; }
});
Deno.test("hosted fetch RateLimitError retains retryAfterMs without an HTTP response", async () => {
  const { advanceOwnedPlanning } = await import('./rules-planning-client.ts');
  const limited=Object.assign(new Error('Synthetic provider limit'),{name:'RateLimitError',retryAfterMs:43_210});
  const error=await assertRejects(()=>advanceOwnedPlanning({home_id:'synthetic',job_id:'synthetic',fence:1},connection,
    ()=>Promise.reject(limited)),EnergyPlanningError);
  assertEquals(error.disposition,'retry');assertEquals(error.retryAfterMs,43_210);assertEquals(error.code,'planning_worker_rate_limited');
});
