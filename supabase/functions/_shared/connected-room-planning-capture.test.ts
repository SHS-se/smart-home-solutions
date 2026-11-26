// Independent synthetic native means and planning scratch, never household data.
import { assert, assertEquals } from "@std/assert";
import { CONNECTED_CAPTURE_IMPLEMENTATION } from "./connected-room-planning-capture.ts";
import { syntheticConnectedResponse } from "./connected-exchange.fixture.ts";
import { encodeRoomResponseFitCapture, decodeRoomResponseFitCapture, ROOM_RESPONSE_CAPTURE_REVISION } from "./device-model-learning/room-band-fit-capture.ts";
import { compactCapture } from "./device-model-learning/room-evidence.fixture.ts";
import type { ThermalQuarterRow } from "./thermal-training.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import type { ModelDatabase } from "./device-model-store.ts";
import type { ConnectedPlanningOwner } from "./connected-room-planning-capture.ts";
import { RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";

const transport = { requests:0, request_bytes:0, response_bytes:0, db_request_bytes:0, db_response_bytes:0,
  checkpoint_bytes:0, max_request_bytes:0 };
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
async function advanceConnectedPlanningCapture(db: ModelDatabase, owner: ConnectedPlanningOwner,
  snapshot: CapturedRulesInput["snapshot"]) {
  const input = {model_version:RULES_MODEL_VERSION, snapshot} as CapturedRulesInput;
  const original = structuredClone(input);
  let completed: CapturedRulesInput | undefined;
  const dispatch = {phase:"capture",cursor:0,target:64,round:0,replicas:[]};
  const request = JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,stage:"owned",
    owner:{home_id:owner.home_id,job_id:owner.job_id,fence:owner.fence},action:{kind:"advance"}});
  transport.requests++;
  transport.request_bytes += bytes(request);
  transport.max_request_bytes = Math.max(transport.max_request_bytes,bytes(request));
  const response=await handleEnergyPlanningStep(new Request("https://synthetic-worker.test",{method:"POST",
    headers:{"x-shs-planning-secret":"synthetic-secret","x-request-id":"synthetic-capture"},body:request}),
    "synthetic-secret",()=>({async rpc(name,args){
      const sent=bytes({name,args});transport.db_request_bytes+=sent;
      if(name.startsWith("checkpoint_")||name.startsWith("save_energy_connected_inference"))transport.checkpoint_bytes+=sent;
      let result;
      if(name==="load_energy_owned_planning_stage") {
        assertEquals({home:args.p_home_id,job:args.p_job_id,fence:args.p_fence},{home:owner.home_id,job:owner.job_id,fence:owner.fence});
        result={data:{dispatch,slice_fence:1,customer_id:owner.customer_id,input:original},error:null};
      } else if(name==="checkpoint_energy_owned_planning_stage") {
        const update=args.p_update as {phase:string;input?:CapturedRulesInput};
        completed=update.input;
        result={data:{...dispatch,phase:update.phase,cursor:1},error:null};
      } else result=await db.rpc(name==="checkpoint_energy_owned_room_capture"?"checkpoint_energy_planning_room_capture":name,args);
      transport.db_response_bytes+=bytes(result);
      return JSON.parse(JSON.stringify(result));
    }}));
  const text=await response.text();transport.response_bytes+=bytes(text);
  assertEquals(response.status,200,text);
  assertEquals(JSON.parse(text).stage,"owned");
  assertEquals(input,original,"A remote capture cannot mutate the admitted input");
  return completed ? {pending:false,snapshot:completed.snapshot} : {pending:true};
}

Deno.test("staged planning freezes bounded source blocks and completes through a long missing suffix without changing stable parameters", async () => {
  const through = 32 * 86400_000;
  const model = syntheticConnectedResponse(false);
  model.incoming = [{ kind: "constant", from: "peer", per_h: 0 }];
  model.basis.history_to = new Date(through).toISOString();
  const raw: ThermalQuarterRow[] = Array.from({ length: 21 * 24 }, (_, i) => ({ room_key: "receiver", room_name: "Synthetic receiver",
    active_power_w: null, start_ts: new Date(i * 3600_000).toISOString(), duration_s: 3600, cooling: null,
    room_temperature_c: 18 + .1 * Math.sin(i), outdoor_temperature_c: 5 + Math.cos(i / 2), house_temperature_c: null,
    solar_w_per_m2: null, heat_w: null, temperature_source_key: "receiver-probe", probe_evidence: [
      { source_key: "receiver-probe", area_key: "receiver", mean: 18 + .1 * Math.sin(i), cohort_key: null,
        unchanged: false, joint_unchanged: false, reported: true, unavailable: false },
      { source_key: "peer-probe", area_key: "peer", mean: 20 + Math.sin(i / 5), cohort_key: null,
        unchanged: false, joint_unchanged: false, reported: true, unavailable: false },
    ] }));
  const snapshot = dispatchedEvSnapshot();
  snapshot.captured_at = new Date(through).toISOString();
  snapshot.slots = snapshot.slots.slice(0, 4).map((slot, i) => ({ ...slot, start: new Date(through + i * 900_000).toISOString() }));
  const peerModel = structuredClone(model); peerModel.incoming = [];
  snapshot.room_network_capture = { rooms: [{ key: "receiver", name: "Synthetic receiver", device_keys: [], model: null,
    connected_exchange: model, rated_power_w: 0, maximum_power_w_by_slot: [] },
    { key: "peer", name: "Synthetic peer", device_keys: [], model: null, connected_exchange: peerModel,
      rated_power_w: 0, maximum_power_w_by_slot: [] }], observations: [] };
  let original = structuredClone(snapshot);
  let cursor = 0;
  let state: Record<string, unknown> | null = null;
  let numeric: unknown = null;
  const blocks: unknown[] = [];
  const phases: string[] = [];
  let readsThisStep = 0;
  const inference = new Map<number, Record<string, unknown>[]>();
  const starts: number[] = [];
  const db: ModelDatabase = { async rpc(name, args) {
    let data: unknown;
    switch (name) {
      case "load_energy_planning_room_capture": {
        let loadedNumeric = numeric;
        if (numeric) {
          const full = numeric as { capture: string; sha256: string; from_at: string };
          const rows = await decodeRoomResponseFitCapture(full.capture, full.from_at, full.sha256);
          const first = state?.phase === 'process' ? Number(state.row) : 0;
          const encoded = await encodeRoomResponseFitCapture(state?.phase === 'process' ? rows.slice(first, first + 2048) : rows, full.from_at);
          loadedNumeric = { capture: state?.phase === 'reuse' ? null : encoded.base64, sha256: encoded.sha256,
            full_sha256: full.sha256, from_at: full.from_at, row_from: first, total_rows: rows.length };
        }
        const delivered = structuredClone(state);
        if (delivered && ['reuse','process','filter'].includes(String(delivered.phase))) delete delivered.nodes;
        data = { cursor, state: delivered, blocks: blocks.filter(block => (block as {room:number}).room === (state?.room ?? 0)), numeric: loadedNumeric }; break;
      }
      case "freeze_energy_connected_planning_sources": {
        const from = Date.parse(String(state?.next_from_at ?? args.p_from));
        data = { graph: { owner: model.basis.graph_owner,
          revision: model.basis.graph_revision, topology_hash: model.basis.topology_hash }, binding: "synthetic", policy: model.basis.source_policy,
          source_revision: 1, next: from >= Date.parse(String(args.p_to)) ? null : {
            from_at: new Date(from).toISOString(), to_at: new Date(Math.min(Date.parse(String(args.p_to)), from + 10 * 86400_000)).toISOString() } }; break;
      }
      case "load_energy_connected_inference": {
        const cached = (inference.get(Number(args.p_room)) ?? []).filter(c => c.identity === args.p_identity);
        if (args.p_through_at) {
          const chosen = cached.find(c => c.through_at === args.p_through_at);
          const full = numeric as { capture: string; sha256: string; from_at: string };
          const rows = await decodeRoomResponseFitCapture(full.capture, full.from_at, full.sha256);
          data = chosen ? { ...chosen, current_prefix_sha256: (await encodeRoomResponseFitCapture(rows.slice(0, Number(chosen.row_count)), full.from_at)).sha256 } : null;
        } else data = cached.toSorted((a, b) => Date.parse(String(b.through_at)) - Date.parse(String(a.through_at)));
        break;
      }
      case "save_energy_connected_inference": {
        const room = Number(args.p_room), old = inference.get(room) ?? [];
        const full = numeric as { capture: string; sha256: string; from_at: string };
        const rows = await decodeRoomResponseFitCapture(full.capture, full.from_at, full.sha256);
        const digest = (await encodeRoomResponseFitCapture(rows.slice(0, Number(args.p_row_count)), full.from_at)).sha256;
        inference.set(room, [...old.filter(c => c.boundary && c.through_at !== args.p_through_at), { through_at: args.p_through_at, row_count: args.p_row_count,
          numeric_sha256: digest, belief: args.p_belief, boundary: args.p_block_boundary, identity: args.p_identity }]); data = true; break;
      }
      case "get_energy_room_operation_facts": data = []; break;
      case "get_energy_room_thermal_interval_capture": {
        readsThisStep++;
        data = compactCapture(raw.filter(row => Date.parse(row.start_ts) >= Date.parse(String(args.p_from)) &&
          Date.parse(row.start_ts) + (row.duration_s ?? 900) * 1000 <= Date.parse(String(args.p_to))).map(row => args.p_room_key === "peer"
            ? { ...row, room_key: "peer", temperature_source_key: "peer-probe", room_temperature_c: row.probe_evidence![1].mean } : row));
        break;
      }
      case "checkpoint_energy_planning_room_capture": {
        assertEquals(args.p_expected_cursor, cursor);
        cursor++;
        state = { ...(state?.nodes ? { nodes: state.nodes } : {}), ...structuredClone(args.p_state as Record<string, unknown>) };
        if (state.room === 0 && state.phase === 'process' && (args.p_numeric || phases.at(-1) === 'reuse')) starts.push(Number(state.row));
        phases.push(String(state.phase));
        const block = args.p_raw as { base64: string } | null;
        if (block) blocks.push({ ...block, capture: block.base64 });
        const capture = args.p_numeric as { base64: string } | null;
        if (capture) numeric = { ...capture, capture: capture.base64 };
        data = { state: "pending", pending: true }; break;
      }
      default: throw new Error(`Unexpected synthetic RPC ${name}`);
    }
    return Promise.resolve({ data: structuredClone(data), error: null });
  } };
  let passes = 0;
  for (let step = 0; step < 1000; step++) {
    readsThisStep = 0;
    const result = await advanceConnectedPlanningCapture(db, { home_id: "synthetic", customer_id: "synthetic", job_id: "synthetic", fence: step + 1 }, snapshot);
    assert(readsThisStep <= 2, "one bounded native source extent is acquired per receipt poll");
    if (!result.pending) {
      assert(result.snapshot);
      assertEquals(result.snapshot.room_network_capture, undefined);
      assert(phases.includes("source") && phases.includes("qualify") && phases.includes("process") && phases.includes("filter") && phases.includes("assemble"));
      assertEquals(snapshot, original, "derived preparation never changes the admitted input");
      assertEquals(result.snapshot.room_network?.nodes[0]?.model.thermal, model.thermal);
      assertEquals(result.snapshot.room_network?.nodes[0]?.posterior.through_ms, through);
      if (passes === 0) {
      assert(result.snapshot.room_network!.nodes[0].model.evidence.process_inference,
        JSON.stringify({ warnings: result.snapshot.planning_warnings, phases }));
      assert(!result.snapshot.planning_warnings?.some(warning => warning.message.includes("parameters could not be identified")),
        JSON.stringify(result.snapshot.planning_warnings));
      assertEquals(Math.max(...inference.get(0)!.map(c => Date.parse(String(c.through_at)))), 21 * 86400_000,
        'persisted posterior stops at received rows, not the long unobserved plan tail');
      }
      passes++;
      if (passes === 4) {
        assertEquals(starts, [0, 504, 240, 504], 'a newly accepted fit carries its qualified process prefix into the first plan');
        return;
      }
      if (passes === 3) {
        assertEquals(starts, [0, 504, 240], 'exact prefix resumes; a historical correction replays from a compatible origin');
        const fitted = inference.get(0)!.find(c => c.row_count === 504)!;
        model.process_belief = fitted.belief as NonNullable<typeof model.process_belief>;
        model.evidence = { ...model.evidence, process_source_prefix: { numeric_sha256: fitted.numeric_sha256,
          rows: 504, through_ms: 21 * 86400_000, from_at: model.basis.history_from,
          peer_keys: ['peer'], codec_revision: ROOM_RESPONSE_CAPTURE_REVISION } };
        original = structuredClone(snapshot);
      }
      if (passes === 2) {
        raw[15 * 24].room_temperature_c! += .2;
        raw[15 * 24].probe_evidence![0].mean! += .2;
      }
      cursor = 0; state = null; numeric = null; blocks.length = 0;
    }
  }
  throw new Error("Synthetic staged capture did not finish");
});

Deno.test("incompatible numerical continuation recaptures inside the same admitted attempt", async () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.room_network_capture = { rooms: [{ key: "receiver", name: "Synthetic receiver", device_keys: [], model: null,
    connected_exchange: syntheticConnectedResponse(false), rated_power_w: 0, maximum_power_w_by_slot: [] }], observations: [] };
  for (const incompatible of [{ version: 0 }, { version: 1, implementation: "previous", runtime: Deno.version.v8 },
    { version: 1, implementation: CONNECTED_CAPTURE_IMPLEMENTATION, runtime: "previous" }]) {
    let next: Record<string, unknown> | null = null;
    const db: ModelDatabase = { rpc(name, args) {
      if (name === "load_energy_planning_room_capture") return Promise.resolve({ data: { cursor: 37,
        state: { ...incompatible, room: 0, phase: "process", process: { incompatible: true }, nodes: [] } }, error: null });
      assertEquals(name, "checkpoint_energy_planning_room_capture");
      assertEquals(args.p_expected_cursor, 37);
      next = args.p_state as Record<string, unknown>;
      return Promise.resolve({ data: { pending: true }, error: null });
    } };
    const result = await advanceConnectedPlanningCapture(db, { home_id: "synthetic", customer_id: "synthetic", job_id: "synthetic", fence: 5 }, snapshot);
    assertEquals(result.pending, true);
    assert(next);
    assertEquals((next as Record<string, unknown>).phase, "source");
    assertEquals((next as Record<string, unknown>).process, undefined);
    assertEquals((next as Record<string, unknown>).runtime, Deno.version.v8);
    assert(snapshot.room_network_capture, "admitted inputs remain unchanged");
  }
});

Deno.test("a malformed process continuation retains the accepted response and advances with a visible estimate", async () => {
  const { encodeRoomResponseFitCapture } = await import("./device-model-learning/room-band-fit-capture.ts");
  const model = syntheticConnectedResponse(false);
  const snapshot = dispatchedEvSnapshot();
  snapshot.room_network_capture = { rooms: [{ key: "receiver", name: "Synthetic receiver", device_keys: [], model: null,
    connected_exchange: model, rated_power_w: 0, maximum_power_w_by_slot: [] }], observations: [] };
  const numeric = await encodeRoomResponseFitCapture([{ start_ms: 0, duration_s: 3600, room_c: 20, outdoor_c: 5,
    heat_w: null, solar_w_per_m2: null, house_c: null, cooling: null, peer_c: { peer: 22 } }], model.basis.history_from);
  const saved = { version: 1, implementation: CONNECTED_CAPTURE_IMPLEMENTATION,
    runtime: Deno.version.v8, room: 0, phase: "process", from_at: model.basis.history_from,
    next_from_at: snapshot.captured_at, policy: model.basis.source_policy, row: 0, nodes: [], warnings: [],
    process: { stage: "full", malformed: true } };
  let checkpoint: Record<string, unknown> | null = null;
  const db: ModelDatabase = { rpc(name, args) {
    if (name === "load_energy_planning_room_capture") return Promise.resolve({ error: null,
      data: { cursor: 9, state: saved, numeric: { ...numeric, capture: numeric.base64, from_at: model.basis.history_from, row_from: 0, total_rows: 1, full_sha256: numeric.sha256 } } });
    assertEquals(name, "checkpoint_energy_planning_room_capture");
    checkpoint = args.p_state as Record<string, unknown>;
    return Promise.resolve({ data: { pending: true }, error: null });
  } };
  assertEquals((await advanceConnectedPlanningCapture(db, { job_id: "synthetic", home_id: "synthetic", customer_id: "synthetic", fence: 1 }, snapshot)).pending, true);
  assert(checkpoint);
  const next = checkpoint as Record<string, unknown>;
  assertEquals(next.phase, "filter");
  assertEquals(next.process, undefined);
  assertEquals(next.process_response, undefined);
  assertEquals((next.warnings as { code: string }[]).map(warning => warning.code), ["room_state_boundary_estimate"]);
  assertEquals(snapshot.room_network_capture.rooms[0].connected_exchange, model);
});

Deno.test("source worker transport keeps accepted models out of receipt requests", () => {
  assert(transport.requests > 0);
  assert(transport.max_request_bytes < 1024, "Capture requests contain identity only, never the accepted belief");
  console.info("[SYNTHETIC-CONNECTED-CAPTURE-TRANSPORT]", transport);
});
