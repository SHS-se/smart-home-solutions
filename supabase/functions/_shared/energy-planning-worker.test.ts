import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { assert, assertEquals } from "@std/assert";
import { dispatchedEvSnapshot, mixedModeSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { generateRulesPlan } from "./rules-planner.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
import { RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";

type StageEvent = {
  event: string; request_id: string; sequence: number; stage: string;
  phase: "start" | "complete" | "failed"; elapsed_ms: number; duration_ms?: number; cold?: boolean;
};

async function captureWorker(body: string) {
  const messages: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { if (typeof args[0] === "string") messages.push(args[0]); };
  try {
    const response = await handleEnergyPlanningStep(new Request("https://worker.test/plan", {
      method: "POST", headers: { "x-shs-planning-secret": "secret", "x-request-id": "trace-request" }, body,
    }), "secret");
    const stages = messages.filter(message => message.startsWith("{"))
      .map(message => JSON.parse(message) as StageEvent).filter(event => event.event === "energy_planning_stage");
    return { response, stages, messages };
  } finally {
    console.info = original;
  }
}

Deno.test("worker traces cold and warm Rust solves separately from surrounding work without changing plans", async () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const input = rulesFixtureInput(snapshot);
  const body = JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "solve", input });
  const cold = await captureWorker(body);
  const warm = await captureWorker(body);
  const expected = JSON.parse(JSON.stringify(generateRulesPlan(input)));
  for (const search of [cold, warm]) {
    assertEquals(search.response.status, 200);
    const { solved } = await search.response.json();
    const assembly = await captureWorker(JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "assemble", input: solved }));
    assertEquals(assembly.response.status, 200);
    assertEquals(await assembly.response.json(), { protocol: RULES_PLANNING_PROTOCOL, stage: "assemble", request_id: "trace-request", result: expected });
    for (const { stages, messages } of [search, assembly]) {
      const active: string[] = [];
      for (const [i, event] of stages.entries()) {
        assertEquals(event.request_id, "trace-request");
        assertEquals(event.sequence, i + 1);
        assert(event.elapsed_ms >= 0);
        if (event.phase === "start") active.push(event.stage);
        else {
          assertEquals(event.phase, "complete");
          assertEquals(active.pop(), event.stage);
          assert(event.duration_ms! >= 0);
        }
      }
      assertEquals(active, []);
      assert(messages.every(message => !message.includes("secret") && !message.includes("Contract EV") && !message.includes("source_entity_ids")));
    }
    const searchStarts = search.stages.filter(event => event.phase === "start").map(event => event.stage);
    for (const stage of ["request_read", "request_parse", "plan_search", "wasm_initialise", "solve",
      "wasm_instantiate", "wasm_input_encode", "wasm_input_allocate", "wasm_execute", "wasm_output_decode", "response_encode"]) {
      assert(searchStarts.includes(stage), `Missing ${stage}`);
    }
    const assemblyStarts = assembly.stages.filter(event => event.phase === "start").map(event => event.stage);
    for (const stage of ["plan_generation", "hot_water_refinement", "selected_plan_materialize", "baseline_projection", "plan_assemble", "response_encode"]) {
      assert(assemblyStarts.includes(stage), `Missing ${stage}`);
    }
    assertEquals(searchStarts.filter(stage => stage === "wasm_execute").length, 1);
    assert(!assemblyStarts.includes("solve"), "Assembly cannot rerun native search");
  }
  assertEquals(cold.stages.find(event => event.stage === "wasm_initialise")?.cold, true);
  assert(cold.stages.some(event => event.stage === "wasm_compile"));
  assertEquals(warm.stages.find(event => event.stage === "wasm_initialise")?.cold, false);
  assert(!warm.stages.some(event => event.stage === "wasm_compile"));
});

Deno.test("worker records the active failing stage and preserves its error response", async () => {
  const malformed = await captureWorker("{");
  assertEquals(malformed.response.status, 400);
  assertEquals((await malformed.response.json()).error, "invalid_snapshot");
  assertEquals(malformed.stages.at(-1)?.phase, "failed");
  assertEquals(malformed.stages.at(-1)?.stage, "request_parse");

  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const input = { ...rulesFixtureInput(snapshot), model_version: "obsolete" };
  const rejected = await captureWorker(JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "solve", input }));
  assertEquals(rejected.response.status, 409);
  assertEquals((await rejected.response.json()).detail, "Prepared rules planner version changed");
  assertEquals(rejected.stages.at(-1)?.stage, "request");
  assertEquals(rejected.stages.at(-1)?.phase, "failed");
  assert(!rejected.stages.some(event => event.stage === "wasm_execute"));
});

Deno.test("unknown worker failures remain retriable internal failures instead of blaming the snapshot", async () => {
  const request = new Request("https://worker.test/plan", {method: "POST", headers: {"x-shs-planning-secret": "secret"}});
  request.text = () => Promise.reject(new Error("synthetic stream interruption"));
  const response = await handleEnergyPlanningStep(request, "secret");
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error, "planning_internal_error");
});

Deno.test("pure domain input validation maps to a terminal worker response at the transport boundary", async () => {
  const snapshot = {...mixedModeSnapshot(), operating_scope: undefined};
  const capture = captureRulesPlanningInput({snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(mixedModeSnapshot()).price_outlook}, null, resolveRulePolicy());
  const result = await captureWorker(JSON.stringify({protocol: RULES_PLANNING_PROTOCOL, stage: "prepare", input: capture}));
  assertEquals(result.response.status, 400);
  const body = await result.response.json();
  assertEquals(body.error, "invalid_snapshot");
  assert(body.detail.includes("operating_scope"));
});

Deno.test("owned capture authenticates and loads its fenced immutable attempt before source work", async () => {
  const owner={home_id:"synthetic-home",job_id:"synthetic-job",fence:7};
  const snapshot=dispatchedEvSnapshot();
  const input={model_version:RULES_MODEL_VERSION,snapshot};
  const body={protocol:RULES_PLANNING_PROTOCOL,stage:"owned",owner,action:{kind:"advance"}};
  const dispatch={phase:"capture",cursor:0,target:64,round:0,replicas:[]};
  const calls:string[]=[];
  let checkpoint:unknown;
  const db={rpc(name:string,args:Record<string,unknown>){
    calls.push(name);
    assertEquals({home:args.p_home_id,job:args.p_job_id,fence:args.p_fence},{home:owner.home_id,job:owner.job_id,fence:7});
    if(name==="load_energy_owned_planning_stage") return Promise.resolve({data:{dispatch,slice_fence:1,customer_id:"synthetic-customer",input},error:null});
    assertEquals(name,"checkpoint_energy_owned_planning_stage");checkpoint=args.p_update;
    return Promise.resolve({data:{...dispatch,phase:"prepare",cursor:1},error:null});
  }};
  const request=(secret="secret",value:unknown=body)=>new Request("https://synthetic-worker.test",{
    method:"POST",headers:{"x-shs-planning-secret":secret},body:JSON.stringify(value)});
  assertEquals((await handleEnergyPlanningStep(request("wrong"),"secret",()=>db)).status,401);
  assertEquals(calls,[]);
  const response=await handleEnergyPlanningStep(request(),"secret",()=>db);
  assertEquals(response.status,200);assertEquals((await response.json()).dispatch.phase,"prepare");
  assertEquals(calls,["load_energy_owned_planning_stage","checkpoint_energy_owned_planning_stage"]);
  assertEquals(checkpoint,{phase:"prepare",input,payload:null},"completion is stored directly, not returned over HTTP");
  for(const invalid of [{...body,owner:{...owner,fence:0}},{...body,action:{kind:"replica",replica:4}}]) {
    assertEquals((await handleEnergyPlanningStep(request("secret",invalid),"secret",()=>db)).status,400);
  }
  assertEquals(calls.length,2,"invalid owners/actions never read private state");
  const stale=await handleEnergyPlanningStep(request(),"secret",()=>({rpc(){return Promise.resolve({data:null,error:null});}}));
  assertEquals((await stale.json()).dispatch,null);
});

Deno.test("owned worker repairs only unreadable derived artifacts under the captured cursor and identity", async () => {
  const calls: Array<{name:string;args:Record<string,unknown>}> = [];
  const db = { async rpc(name:string,args:Record<string,unknown>) {
    calls.push({name,args});
    if(name==='claim_energy_forecast_replica') return {data:{dispatch:{phase:'integrate',cursor:7,target:64,round:1,replicas:[0,1,2,3]},
      slice_fence:2,cursor:0,identity:'synthetic-frozen-identity',round:1,target_local_draws:16,header:'not-gzip',work:null},error:null};
    if(name==='reset_energy_owned_planning_runtime') return {data:true,error:null};
    throw new Error(`Unexpected synthetic RPC ${name}`);
  }};
  const response=await handleEnergyPlanningStep(new Request('https://synthetic.test/step',{method:'POST',
    headers:{'x-shs-planning-secret':'synthetic','x-request-id':'synthetic'},body:JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,
      stage:'owned',owner:{home_id:'synthetic-home',job_id:'synthetic-job',fence:3},action:{kind:'replica',replica:0}})}),'synthetic',()=>db);
  assertEquals(response.status,200);assertEquals((await response.json()).dispatch,null);
  assertEquals(calls.map(call=>call.name),['claim_energy_forecast_replica','reset_energy_owned_planning_runtime']);
  assertEquals(calls[1].args,{p_home_id:'synthetic-home',p_job_id:'synthetic-job',p_fence:3,
    p_cursor:7,p_identity:'synthetic-frozen-identity',p_phase:'integrate'});
});
