import { diskTree, reach } from "../../../scripts/module-graph.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dispatchedEvSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { executeRulesPlanning, prepareCapturedRulesInput, prepareCapturedRoomProposals, prepareOwnedRulesProposals, applyCapturedConnectedForecast } from "./rules-planning-execution.ts";
import { generateRulesPlan, prepareRulesPlanningInput } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { connectedRoomSnapshot, projectedPlanningNetwork } from "./room-network.fixture.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import { resolvedRemoteForecastCounts, resolvedForecastCounts } from "./rules-planning-client.ts";
import { advanceOwnedPlanningWorker } from "./owned-planning-worker.ts";
import { packOwnedPlanningValue } from "./owned-planning-codec.ts";
import { sha256Hex } from "./ha-device-auth.ts";
import type { NativeRoomNetworkAdvanceInput } from "./room-network-contract.ts";
import type { RoomPreparationProgress } from "./rules-room-services.ts";
import type { RulesPlanningSource } from "./rules-planning-capture.ts";

function freeze(value: unknown) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
}

Deno.test("preparation owns every caller object without copying its derived schedules", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const source: RulesPlanningSource = { snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(snapshot).price_outlook };
  const policy = resolveRulePolicy();
  const initial = generateRulesPlan(prepareRulesPlanningInput(source, null, policy));
  const slots = initial.plan.plans.priority.slots;
  const reference = { plan_id: "synthetic-retained", slots };
  source.fixed_plan = { id: "synthetic-booking", starts_at: slots[6].start,
    ends_at: slots[7].start, source_snapshot_id: snapshot.snapshot_id,
    slots: [{ start: slots[6].start, targets: slots[6], power_w: {}, discharge_w: {}, allow_export: false }] };
  const callers = { source, reference, policy };
  const before = structuredClone(callers);
  freeze(callers);
  const prepared = prepareRulesPlanningInput(source, reference, policy);
  const expected = structuredClone(prepared);
  prepared.snapshot.slots[0].base_load_forecast_w += 100;
  prepared.price_outlook.shadow_import_sek_per_kwh[0] += 1;
  prepared.problem.rules.length = 0;
  prepared.held_reference[0].device_commands = {};
  prepared.fixed_slots[6].device_commands = {};
  assertEquals(callers, before);
  assertEquals(prepareRulesPlanningInput(source, reference, policy), expected);
});

Deno.test("capture stores detached source facts and policy without prepared search state", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const source = { snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(snapshot).price_outlook };
  const policy = resolveRulePolicy();
  const reference = { plan_id: "accepted", slots: [] };
  const capture = captureRulesPlanningInput(source, reference, policy);
  const before = structuredClone(capture);
  snapshot.slots[0].base_load_forecast_w += 2000;
  reference.plan_id = "changed";
  policy.rules.length = 0;
  source.resolved_price_outlook!.shadow_import_sek_per_kwh[0] = 100;
  assertEquals(capture, before);
  assertEquals("problem" in capture, false);
  assertEquals("rooms" in capture, false);
  assertEquals(capture.execution_replan, null);
});

Deno.test("captured complete execution preserves existing ordered preparation and solve exactly", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const source = { snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(snapshot).price_outlook };
  const policy = resolveRulePolicy();
  const capture = captureRulesPlanningInput(source, null, policy);
  const expected = generateRulesPlan(prepareRulesPlanningInput(source, null, policy));
  assertEquals(executeRulesPlanning(capture), expected);
  assertEquals(executeRulesPlanning(capture), expected);
  assertThrows(() => prepareCapturedRulesInput({ ...capture, model_version: "obsolete" }), Error,
    "Captured rules planner version changed");
});

Deno.test("admission identity, captures and durable transport cannot load search kernels", () => {
  const shared = "supabase/functions/_shared/";
  const root = new URL("../../../", import.meta.url).pathname;
  const graph = reach(diskTree(root), ["rules-planning-capture.ts", "rules-planner-identity.ts",
    "rules-planning-client.ts", "energy-planning-jobs.ts"].map(file => shared + file));
  assertEquals([...graph].filter(path => /(?:rules-planner\.ts|rules-room-services\.ts|room-heating-schedule\.ts|planner-wasm\/(?:runtime|core|solver-bytes)\.ts)$/.test(path)), []);
});

Deno.test("projected proposals, ordered catalogue bytes and convergence counts reproduce full captured execution", async () => {
  const snapshot = connectedRoomSnapshot();
  const [zone] = snapshot.thermal_zones!, [device] = snapshot.device_models;
  snapshot.thermal_zones!.push({ ...zone, key: "independent", device_keys: ["independent-heater"] });
  snapshot.device_models.push({ ...device, key: "independent-heater" });
  snapshot.operating_scope = { modes: { $battery: "controlling", $ev: "controlling", $pool: "controlling",
    "synthetic-a": "controlling", independent: "controlling" },
    device_owners: { "synthetic-a-heater": "synthetic-a", "independent-heater": "independent" }, external_demands: {} };
  const capture = captureRulesPlanningInput({ snapshot, now: snapshot.captured_at,
    resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1,
      shadow_import_sek_per_kwh: snapshot.slots.map(() => 1) } }, null, resolveRulePolicy());
  const { room_network, ...inputSnapshot } = capture.snapshot;
  const input = { ...capture, snapshot: inputSnapshot }, proposal_network = projectedPlanningNetwork(room_network!);
  const original = JSON.stringify(capture);
  freeze(capture); freeze(input); freeze(proposal_network);
  const scope = { home_id: "synthetic", job_id: "synthetic", fence: 3 };
  const runStage = async (phase: string, fields: Record<string, unknown>) => {
    let update: Record<string, unknown> | undefined;
    await advanceOwnedPlanningWorker({async rpc(name, args) {
      if (name === "load_energy_owned_planning_stage") {
        assertEquals(args.p_project_rooms, true);
        return {data: {dispatch: {phase,cursor:7,target:64,round:0,replicas:[]}, slice_fence:3, ...fields}, error:null};
      }
      assertEquals(name, "checkpoint_energy_owned_planning_stage");
      assertEquals(args.p_cursor, 7);
      update = args.p_update as Record<string, unknown>;
      return {data:{phase:update.phase}, error:null};
    }}, scope, {kind:"advance"});
    assert(update);
    return update;
  };
  let progress: RoomPreparationProgress | null = null;
  for (;;) {
    const expected = prepareCapturedRoomProposals(capture, structuredClone(progress));
    const owned = prepareOwnedRulesProposals(input, proposal_network, structuredClone(progress));
    assert(owned.progress && expected.room_progress);
    assertEquals(JSON.stringify(owned.progress), JSON.stringify(expected.room_progress));
    if (!owned.catalog) { progress = owned.progress; continue; }
    assert(expected.forecast);
    const { context, nativeInput } = expected.forecast;
    assertEquals(owned.catalog.network, nativeInput.network);
    const start = await runStage("prepare", {input,proposal_network,payload:await packOwnedPlanningValue(progress)});
    assertEquals(start.phase,"catalog");
    const keys = start.node_keys as string[];
    assert(keys.includes("independent"), "an identified scalar room has an empty native catalogue");
    let header = start.header;
    const beliefs: string[] = [];
    for (const [index,key] of keys.entries()) {
      const node = room_network!.nodes.find(node => node.key === key) ?? null;
      const write = await runStage("catalog", {header,catalog_next:index,node_count:keys.length,catalog_source:{key,node}});
      header = write.header;
      const records: string[] = [];
      for (const page of write.pages as {bytes:string;offsets:number[]}[]) {
        const bytes = Uint8Array.from(atob(page.bytes), char => char.charCodeAt(0));
        for(let i=1;i<page.offsets.length;i++) records.push(new TextDecoder().decode(bytes.subarray(page.offsets[i-1],page.offsets[i])));
      }
      const json = String(write.identity_before_records) + records.join(",") + String(write.identity_after_records);
      assertEquals(json, JSON.stringify(nativeInput.beliefs[index]));
      beliefs.push(json);
    }
    assertEquals(await sha256Hex(String(start.identity_prefix) + beliefs.join(",") + "]}"), nativeInput.identity);
    const planner = nativePlanner();
    const request: NativeRoomNetworkAdvanceInput = { ...nativeInput, target_trajectories: 64, max_minute_steps: 8192 };
    for (;;) {
      const advanced = planner.roomNetworkAdvance(request);
      if (!advanced.reached_target) { request.work = advanced.work; continue; }
      const output = planner.roomNetworkFinalize({ network: request.network, work: advanced.work });
      const counts = advanced.work.statistics;
      const caller = applyCapturedConnectedForecast(capture, expected.room_progress, context, output, counts);
      const worker = applyCapturedConnectedForecast(input, owned.progress, owned.catalog.context, output, counts);
      assertEquals(worker.snapshot.room_network, undefined);
      assertEquals(resolvedForecastCounts(proposal_network.forecast, worker.rooms.network_forecast), resolvedRemoteForecastCounts(capture, caller));
      assertEquals(worker.rooms.network_forecast?.replayed_paths, counts.replayed_paths);
      const {room_network:_archive,...callerSnapshot} = caller.snapshot;
      assertEquals(JSON.stringify(worker), JSON.stringify({...caller,snapshot:callerSnapshot}));
      assertEquals(generateRulesPlan(worker), generateRulesPlan(caller));
      assertEquals(JSON.stringify(capture), original);
      return;
    }
  }
});
