import { connectedAdmissionCpuInput, runConnectedAdmissionCpu, checkConnectedAdmissionCpu, type ConnectedAdmissionCpuFixture } from "../tests/connected-room-admission-cpu.fixture.ts";
import { CONNECTED_REPLICA_CPU_PHASES, CONNECTED_REPLICA_CPU_OWNER, connectedReplicaCpuInputs, connectedDenseReplicaCpuInput, connectedReplicaCpuReplay, connectedPreparationCpuInputs, connectedStiffCpuInputs, type ConnectedReplicaCpuPhase, type ConnectedReplicaCpuFixture } from "../tests/connected-room-replica-cpu.fixture.ts";
import { CONNECTED_CAPTURE_PHASES, CONNECTED_CPU_OWNER, connectedCaptureCpuInputs, type ConnectedCapturePhase, connectedCaptureReplay, type ConnectedCpuCheckpoint } from "../tests/connected-room-capture-cpu.fixture.ts";

/** Run separately from parallel unit tests: measure the complete cold worker,
 * including Wasm compilation, hot-water refinement, materialization and JSON.
 * Process CPU is a local regression gate, not a hosted platform measurement.
 *
 * CI runners differ by almost 2× in speed while samples on one runner agree
 * within ~5%, so raw milliseconds would pass or fail by which machine a job
 * lands on. The gate therefore also times a fixed reference workload that
 * shares no planner code, and scales the planner's median CPU to the baseline
 * machine below. Samples run one after another in fresh processes: concurrent
 * samples would share CPU cores and caches and add the noise this removes.
 */
import { cpuUsage, memoryUsage, resourceUsage } from "node:process";
import { assert, assertEquals } from "@std/assert";
import {
  cpuBatteryRecoveryInput,
  cpuConnectedRoomPlanningSource,
  cpuMixedRoomPlanningSource,
  cpuPlanningInput,
  cpuPlanningSource,
  cpuVaryingRoomPlanningSource,
  cpuVaryingRoomTargetPlanningSource,
} from "../tests/planner-handler-cpu.fixture.ts";
import { ROOM_MEASURED_POLICY } from "../supabase/functions/_shared/planner/models/room/measured-evidence.ts";
import type { RoomPreparationProgress } from "../supabase/functions/_shared/rules-room-services.ts";
import type { PreparedRulesInput, SolvedRulesInput } from "../supabase/functions/_shared/rules-planner.ts";
import { captureRulesPlanningInput } from "../supabase/functions/_shared/rules-planning-capture.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { RULES_MODEL_VERSION } from "../supabase/functions/_shared/rules-planner-identity.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";

import { createDeviceLearningReplay } from "../supabase/functions/_shared/device-learning-replay.ts";
import { handleDeviceLearning } from "../supabase/functions/_shared/device-learning-worker.ts";
import { syntheticPoolLearningReplay } from "../tests/device-learning-cpu.fixture.ts";
import { replayRoomCapture, resumedRoomCheckpoint, ROOM_CAPTURE_NOW, syntheticFitTransitions, syntheticRoomArchive, type RoomNumericCheckpoint } from "../tests/room-capture-cpu.fixture.ts";
const RUNS = 3;
// Budget in baseline-machine milliseconds. Reserve at least 500 ms below the
// hosted two-second CPU ceiling for host differences and transport. The native
// work and projection tests also bound work deterministically.
const BUDGET_MS = 1500;
// Preserve the existing preparation budget after moving it into its own worker.
const PREPARATION_BUDGET_MS = 1000;
// Median reference CPU on the baseline machine (Apple M-series, 2026-10-14),
// where the cold worker used ≈1,000 ms. Re-measure only with the reference.
const BASELINE_REFERENCE_MS = 340;
const REFERENCE_ROUNDS = 400;

type Sample = { cpu_ms: number; elapsed_ms: number; wasm_memory_bytes?: number; max_rss_kib?: number; total_cpu_ms?: number; total_elapsed_ms?:number; requests?: number; trajectories?: number; replayed_paths?:number };

const measure = async (work: () => Promise<unknown> | unknown): Promise<Sample> => {
  const before = cpuUsage();
  const started = performance.now();
  await work();
  const used = cpuUsage(before);
  return { cpu_ms: (used.user + used.system) / 1000, elapsed_ms: performance.now() - started };
};

/** Plan once in this process, failing on an incomplete plan. */
async function planSample(recovery = false): Promise<Sample> {
  const input = recovery ? cpuBatteryRecoveryInput() : cpuPlanningInput();
  assert(input.problem.heater?.source && input.problem.initial.pool_source_depletion_kwh !== null, "CPU gate must exercise measured source recovery");
  let solved!: SolvedRulesInput;
  const call = (stage: string, input: PreparedRulesInput | SolvedRulesInput) =>
    handleEnergyPlanningStep(new Request("https://cpu.test/plan", {
      method: "POST", headers: { "x-shs-planning-secret": "cpu-test", "x-request-id": "cpu-regression" },
      body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage, input }),
    }), "cpu-test");
  const search = await measure(async () => {
    const response = await call("solve", input);
    const body = await response.json();
    assertEquals(response.status, 200, JSON.stringify(body));
    solved = body.solved;
  });
  const assembly = await measure(async () => {
    const response = await call("assemble", solved);
    const body = await response.json();
    assertEquals(response.status, 200, JSON.stringify(body));
    assertEquals(body.result.plan.status, "ready");
    assertEquals(body.result.plan.plans.priority.slots.length, 288);
    if (recovery) assert(body.result.plan.planning_warnings?.some((w: {code:string}) => w.code === 'battery_commitment_rescheduled'));
  });
  return search.cpu_ms >= assembly.cpu_ms ? search : assembly;
}

/** Full cold learning handler: paginated JSON, all fits, selection and publication. */
async function calibrationSample(): Promise<Sample> {
  const now = Math.floor(Date.now() / 900_000) * 900_000;
  const replay = createDeviceLearningReplay(syntheticPoolLearningReplay(now));
  const sample = await measure(async () => {
    const response = await handleDeviceLearning(new Request("https://cpu.test/learn", {
      method: "POST", headers: { "x-energy-learning-token": "synthetic" },
      body: JSON.stringify({ job_id: "synthetic-learning" }),
    }), replay.db, () => now);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { published: true });
  });
  assertEquals(replay.failures, []);
  assertEquals(replay.publications.length, 1);
  assertEquals(replay.reads.filter(read => read.from !== undefined).length, 12);
  const model = replay.publications[0].p_model as { thermal_dynamics: { recovery_evidence: unknown }; last_fit_attempt: { recovery_selection: { selected: string } } };
  assert(model.thermal_dynamics.recovery_evidence);
  assertEquals(model.last_fit_attempt.recovery_selection.selected, "recovering_source");
  return sample;
}

async function checkpointRoomWorker(replay: ReturnType<typeof replayRoomCapture>) {
  const response = await handleDeviceLearning(new Request("https://cpu.test/learn", {
    method: "POST", headers: { "x-energy-learning-token": "synthetic" },
    body: JSON.stringify({ job_id: "synthetic" }),
  }), replay, () => ROOM_CAPTURE_NOW);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { checkpointed: true });
  return replay.check();
}

/** Complete chronological capture through the production worker. The caller
 * supplies the serialized SQL archive from another process, outside its clock. */
async function roomCaptureSample(profileMemory = false) {
  const snapshot = () => {
    const { rss, heapUsed, external, arrayBuffers } = memoryUsage();
    return { rss, heapUsed, external, arrayBuffers, heapAndExternal: heapUsed + external };
  };
  const baseline = snapshot(), peaks = { ...baseline };
  const observe = () => {
    const usage = snapshot();
    for (const name of Object.keys(peaks) as (keyof typeof peaks)[]) peaks[name] = Math.max(peaks[name], usage[name]);
  };
  const replay = replayRoomCapture(await new Response(Deno.stdin.readable).arrayBuffer(), profileMemory ? observe : undefined);
  // Profiling is separate from gate samples. Timers observe async decode, and
  // the RPC adapter observes transport boundaries. Synchronous intermediate
  // allocations between observations can exceed these sampled peaks.
  const timer = profileMemory ? setInterval(observe, 5) : undefined;
  try {
    const sample = await measure(() => checkpointRoomWorker(replay));
    observe();
    return { ...sample, max_rss_kib: resourceUsage().maxRSS,
      ...(profileMemory ? { memory_bytes: { baseline, sampled_peak: peaks, post_capture: snapshot() } } : {}) };
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

const checkpointBytes = (value: RoomNumericCheckpoint) => new TextEncoder().encode(JSON.stringify(value));

/** Freeze real production checkpoints outside every measured child. First
 * admit the full 400-day archive. Then finish the exact candidate prefix and
 * stop before a weather-dependent finite/full candidate with nonzero lag. */
async function roomNumericalInputs() {
  const source = await syntheticRoomArchive(40, true);
  const first = await checkpointRoomWorker(replayRoomCapture(source.buffer));
  const completed = await resumedRoomCheckpoint(first, 108);
  const resumed = { ...completed, progress: { ...completed.progress, cells: completed.progress.cells.slice(0, 21), cursor: 21 } };
  return { initial: checkpointBytes(first), resumed: checkpointBytes(resumed), completed: checkpointBytes(completed) };
}

/** The full 30-day finalization request, including decode, both measured fits,
 * chronological holdout comparisons, ledger creation and publication JSON. */
async function roomFinalizeSample(): Promise<Sample> {
  const checkpoint: RoomNumericCheckpoint = await new Response(Deno.stdin.readable).json();
  assertEquals(checkpoint.progress.cursor, 108);
  const replay = replayRoomCapture(checkpoint);
  const sample = await measure(async () => {
    const response = await handleDeviceLearning(new Request("https://cpu.test/learn", {
      method: "POST", headers: { "x-energy-learning-token": "synthetic" },
      body: JSON.stringify({ job_id: "synthetic" }),
    }), replay, () => ROOM_CAPTURE_NOW);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { published: true });
    replay.checkPublished();
  });
  return { ...sample, max_rss_kib: resourceUsage().maxRSS };
}

async function roomNumericalSample(resetPolicy = false) {
  const checkpoint: RoomNumericCheckpoint = await new Response(Deno.stdin.readable).json();
  const started = checkpoint.progress.cursor;
  const partition = Math.floor(started / 6) % 2 === 0 ? "training" : "full";
  const expected = syntheticFitTransitions(partition);
  if (resetPolicy) delete checkpoint.progress.metadata.policy_fingerprint;
  const sample = await measure(async () => {
    const replay = replayRoomCapture(checkpoint);
    if (resetPolicy) {
      const response = await handleDeviceLearning(new Request("https://cpu.test/learn", {
        method: "POST", headers: { "x-energy-learning-token": "synthetic" },
        body: JSON.stringify({ job_id: "synthetic" }),
      }), replay, () => ROOM_CAPTURE_NOW);
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { superseded: true });
      replay.checkReset();
      return;
    }
    const next = await checkpointRoomWorker(replay);
    assert(next.progress.metadata.capture.implementation.includes(ROOM_MEASURED_POLICY));
    assertEquals(next.progress.metadata.heat_state, undefined);
    const cell = next.progress.cells[started];
    assert(cell);
    assertEquals(cell.fits.length, 2);
    assertEquals(cell.fits.map(fit => fit.solar), [false, true]);
    for (const fit of cell.fits) {
      assertEquals(fit.n, expected);
      assertEquals(fit.family, "finite");
      assertEquals(fit.weather, started > 0);
      assertEquals(fit.lag, started > 0 ? .5 : 0);
    }
  });
  return { ...sample, max_rss_kib: resourceUsage().maxRSS };
}

/** Cold preparation handler, including transport encoding, with nine rooms. */
async function preparationSample(mode:
    | "household" | "mixed" | "varying" | "room-targets" | "varying-room-targets"
    | "connected"
    | "connected-wide"
    | "connected-stiff" = "household",
): Promise<Sample> {
  const mixed = mode === "mixed" || mode === "room-targets";
  const connected = mode === "connected" || mode === "connected-stiff" || mode === "connected-wide";
  const source = connected
    ? cpuConnectedRoomPlanningSource(mode === "connected-stiff", mode === "connected-wide")
    : mixed ? cpuMixedRoomPlanningSource()
    : mode === "varying-room-targets" ? cpuVaryingRoomTargetPlanningSource()
    : mode === "varying" ? cpuVaryingRoomPlanningSource() : cpuPlanningSource(true);
  if (mode === "room-targets") {
    source.snapshot.schema_version = 12;
    for (const model of source.snapshot.device_models) {
      if (model.category === "heating" && model.control_type === "switch_schedule") model.relay_on = false;
    }
  }
  const capture = captureRulesPlanningInput(source, null, resolveRulePolicy());
  let input!: PreparedRulesInput;
  let memory = 0;
  const originalInfo = console.info;
  console.info = (...messages: unknown[]) => {
    if (typeof messages[0] !== "string" || !messages[0].startsWith("{")) return;
    const event = JSON.parse(messages[0]);
    memory = Math.max(memory, event.wasm_memory_bytes ?? 0);
  };
  try {
    let progress: RoomPreparationProgress | undefined;
    let peak: Sample = { cpu_ms: 0, elapsed_ms: 0 };
    let calls = 0;
    let totalCpu = 0;
    const preparationStarted = performance.now();
    do {
      calls++;
      const sample = await measure(async () => {
        const response = await handleEnergyPlanningStep(new Request("https://cpu.test/plan", {
          method: "POST", headers: { "x-shs-planning-secret": "cpu-test", "x-request-id": "cpu-preparation",
            },
          body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "prepare", input: capture, room_progress: progress,
            }),
          }),
          "cpu-test",
        );
        const body = await response.json();
        assertEquals(response.status, 200, JSON.stringify(body));
        progress = body.room_progress;
        input = body.prepared;
      });
      if (sample.cpu_ms > peak.cpu_ms) peak = sample;
      totalCpu += sample.cpu_ms;
      if(connected && calls%25===0)console.log(JSON.stringify({preparation_progress:mode,
        requests:calls,total_cpu_ms:totalCpu,elapsed_ms:performance.now()-preparationStarted,
        cursor:progress?.network_work?.cursor,outer_draws:progress?.network_work?.replicas.reduce((n,r)=>n+(r?.statistics.trajectories??0),0),
      }));
    } while (progress);
    if (connected) {
      assert(calls > 8, "Connected preparation must finish its joint trajectory barrier");
      assert((input.rooms.network_forecast?.trajectories ?? 0) > 0);
    } else assertEquals(calls, mixed ? 1 : 9);
    assertEquals(Object.keys(input.rooms.commands).length,
      connected ? 8 : mixed ? 4 : 9,
    );
    if (connected) {
      assertEquals(
        Object.values(input.rooms.temperature).filter((series) =>
          series.every((value) => value !== null)
        ).length,
        8,
        "connected CPU gate must exercise native forecasts, not empirical continuity",
      );
    }
    if (mode === "room-targets" || mode === "varying-room-targets") {
      assert(Object.values(input.rooms.commands).some((commands) =>
          commands.some((command) => command.type === "room_relay")),
      );
    }
    if (mode === "varying-room-targets") {
      assertEquals(Object.values(input.rooms.temperature).filter((series) =>
          series.every((value) => value !== null)).length, 7,
      );
    }
    assertEquals(input.problem.slots.length, 288);
    assert(memory > 0 && memory < 128 * 1024 * 1024, `Native room memory exceeded the preparation budget: ${memory}`,
    );
    return { ...peak, wasm_memory_bytes: memory, total_cpu_ms: totalCpu,
      total_elapsed_ms:performance.now()-preparationStarted,requests: calls,
      trajectories: input.rooms.network_forecast?.trajectories,
      replayed_paths:input.rooms.network_forecast?.replayed_paths };
  } finally {
    console.info = originalInfo;
  }
}

/** Actual owner-only HTTP worker, including compressed catalog/header/checkpoint
 * JSON and native selected-posterior replay on the15-node72-hour household. */
/** Accepted bundle parsing, every hypothesis validation, current state/routine
 * capture, detached input cloning and the actual admission RPC serialization.
 * Only generation and loading of raw synthetic response strings is untimed. */
async function connectedAdmissionSample():Promise<Sample> {
  const fixture=await new Response(Deno.stdin.readable).json() as ConnectedAdmissionCpuFixture;
  let result!:Awaited<ReturnType<typeof runConnectedAdmissionCpu>>;
  const sample=await measure(async()=>{result=await runConnectedAdmissionCpu(fixture);});
  return {...sample,...checkConnectedAdmissionCpu(result),max_rss_kib:resourceUsage().maxRSS};
}

async function connectedReplicaSample():Promise<Sample> {
  const fixture:ConnectedReplicaCpuFixture=await new Response(Deno.stdin.readable).json();
  const requests = fixture.subsequent
    ? [fixture, {...fixture, phase: "resumed" as const, saved: fixture.subsequent}]
    : [fixture];
  const actions = requests.map(request => ({request, replay: connectedReplicaCpuReplay(request)}));
  const sample=await measure(async()=>{
    for (const { request, replay } of actions) {
      const action = request.phase === "initial" || request.phase === "resumed" ? {kind:"replica",replica:0} : {kind:"advance"};
      const response=await handleEnergyPlanningStep(new Request("https://cpu.test/plan",{method:"POST",
        headers:{"x-shs-planning-secret":"cpu-test"},body:JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,stage:"owned",owner:CONNECTED_REPLICA_CPU_OWNER,action})}),"cpu-test",()=>replay.db);
      assertEquals(response.status,200,await response.clone().text());
      assert((await response.json()).dispatch);
    }
  });
  for (const {replay} of actions) await replay.check();
  return sample;
}

/** Actual durable stage, including RPC JSON, gzip/numeric decode, qualification,
 * bounded process/filter advancement, missing-state assembly and checkpoint JSON. */
async function connectedCaptureSample(
  phase: ConnectedCapturePhase,
): Promise<Sample> {
  const fixture: ConnectedCpuCheckpoint = await new Response(
    Deno.stdin.readable,
  ).json();
  const sample = await measure(async () => {
    const snapshot = JSON.parse(JSON.stringify(fixture.snapshot));
    const replay = connectedCaptureReplay(fixture);
    const dispatch={phase:"capture",cursor:0,target:64,round:0,replicas:[]};
    const response = await handleEnergyPlanningStep(new Request("https://cpu.test/plan", {
      method:"POST", headers:{"x-shs-planning-secret":"cpu-test-secret", "x-request-id":"capture-cpu"},
      body:JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,stage:"owned",owner:CONNECTED_CPU_OWNER,action:{kind:"advance"}}),
    }), "cpu-test-secret", () => ({rpc(name,args) {
      if(name==="load_energy_owned_planning_stage")return Promise.resolve({data:JSON.parse(JSON.stringify({dispatch,slice_fence:1,customer_id:CONNECTED_CPU_OWNER.customer_id,input:{model_version:RULES_MODEL_VERSION,snapshot}})),error:null});
      if(name==="checkpoint_energy_owned_planning_stage")return Promise.resolve({data:dispatch,error:null});
      return replay.db.rpc(name==="checkpoint_energy_owned_room_capture"?"checkpoint_energy_planning_room_capture":name,args);
    }}));
    assertEquals(response.status,200,await response.clone().text());
    const result=await response.json();
    assert(result.dispatch);
    replay.check();
    const next = replay.checkpoint();
    if (phase === "qualify") assertEquals(next.numeric?.row_count, 400 * 96);
    if (phase === "filter") assert(Number(next.state?.row) > 0);
    if (phase === "assemble") {
      assertEquals((next.state?.nodes as unknown[]).length, 1);
    }
  });
  return { ...sample, max_rss_kib: resourceUsage().maxRSS };
}

/** Fixed single-threaded JIT work (allocation, sorting, JSON, float loops). */
function reference(rounds: number): number {
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let total = 0;
  for (let round = 0; round < rounds; round++) {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ value: random(), weight: Math.sin(i) }),
    );
    rows.sort((a, b) => a.value - b.value);
    const copy: typeof rows = JSON.parse(JSON.stringify(rows));
    const series = new Float64Array(4096);
    for (let k = 0; k < series.length; k++) {
      series[k] = Math.exp(-k / 512) * copy[k % copy.length].weight;
    }
    for (let k = 1; k < series.length; k++) series[k] += series[k - 1] * .5;
    total += copy.reduce((sum, row) => sum + row.value * row.weight, 0) + series[series.length - 1];
  }
  return total;
}

async function referenceSample(): Promise<Sample> {
  let total = 0;
  const sample = await measure(() => { total = reference(REFERENCE_ROUNDS); });
  assert(Number.isFinite(total));
  return sample;
}

/** A fresh process, so every sample pays module loading and compilation. */
async function coldSample(kind:
    | "plan" | "recovery" | "reference" | "preparation" | "mixed-room" | "varying-rooms" | "room-targets" | "varying-room-targets" | "calibration" | "room-capture" | "room-numerical" | "room-policy-reset" | "room-finalize"
    | "connected"
    | "connected-wide"
    | "connected-stiff"
    | "connected-dense-pair"
    | "connected-admission"
    | `connected-capture-${ConnectedCapturePhase}`
    | `connected-replica-${ConnectedReplicaCpuPhase | "prepare"}`,
  input?: Uint8Array<ArrayBuffer>,
): Promise<Sample> {
  const child = new Deno.Command(Deno.execPath(), {
    // No V8 code cache: a later sample must not reuse an earlier one's compilation.
    args: ["run", "--no-check", "--sloppy-imports", "--allow-read", "--no-code-cache", import.meta.filename!, `--${kind}`,
    ],
    stdin: input ? "piped" : "null", stdout: "piped", stderr: "inherit",
  }).spawn();
  if (input) {
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const { code, stdout } = await child.output();
  const lines = new TextDecoder().decode(stdout).trim().split("\n");
  assertEquals(code, 0, lines.join("\n"));
  return JSON.parse(lines.at(-1)!);
}

async function cpuModel(): Promise<string> {
  // Through a subprocess: --allow-read alone does not open /proc in Deno 2.
  const run = async (command: string, args: string[]) => {
    try {
      const { success, stdout } = await new Deno.Command(command, { args, stdout: "piped", stderr: "null",
      }).output();
      return success ? new TextDecoder().decode(stdout) : "";
    } catch {
      return "";
    }
  };
  const info = await run("cat", ["/proc/cpuinfo"]);
  const model = /^model name\s*:\s*(.+)$/m.exec(info)?.[1];
  if (model) {
    return `${model.trim()} × ${info.match(/^processor\s*:/gm)?.length ?? "?"}`;
  }
  return (await run("sysctl", ["-n", "machdep.cpu.brand_string"])).trim() || "unknown";
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if(Deno.args.includes("--connected-admission-fixture")) {
  await new Blob([connectedAdmissionCpuInput()]).stream().pipeTo(Deno.stdout.writable);
} else if(Deno.args.includes("--connected-admission")) {
  console.log(JSON.stringify(await connectedAdmissionSample()));
} else if(Deno.args.includes("--connected-dense-fixture")) {
  await new Blob([await connectedDenseReplicaCpuInput()]).stream().pipeTo(Deno.stdout.writable);
} else if(Deno.args.includes("--connected-dense-pair")) {
  console.log(JSON.stringify(await connectedReplicaSample()));
} else if(Deno.args.includes("--connected-replica-fixture")) {
  const inputs=await connectedReplicaCpuInputs(),phase=(Deno.args[1]??"initial") as ConnectedReplicaCpuPhase;
  await new Blob([inputs[phase]]).stream().pipeTo(Deno.stdout.writable);
} else if(Deno.args.some(arg=>arg.startsWith("--connected-replica-"))) {
  console.log(JSON.stringify(await connectedReplicaSample()));
} else if (Deno.args.includes("--connected-capture-fixture")) {
  const inputs = await connectedCaptureCpuInputs(),
    phase = (Deno.args[1] ?? "source") as ConnectedCapturePhase;
  await new Blob([inputs[phase]]).stream().pipeTo(Deno.stdout.writable);
} else if (Deno.args.some((arg) => arg.startsWith("--connected-capture-"))) {
  const phase = Deno.args.find((arg) => arg.startsWith("--connected-capture-"))!
    .slice("--connected-capture-".length) as ConnectedCapturePhase;
  console.log(JSON.stringify(await connectedCaptureSample(phase)));
} else if (Deno.args.includes("--room-capture-fixture")) {
  const bytes = await syntheticRoomArchive(Number(Deno.args[1]));
  await new Blob([bytes]).stream().pipeTo(Deno.stdout.writable);
} else if (Deno.args.includes("--room-numerical-fixture")) {
  const inputs = await roomNumericalInputs();
  await new Blob([inputs[Deno.args.includes("--completed") ? "completed" : Deno.args.includes("--resumed") ? "resumed" : "initial"],
  ]).stream().pipeTo(Deno.stdout.writable);
} else if (Deno.args.includes("--room-finalize")) {
  console.log(JSON.stringify(await roomFinalizeSample()));
} else if (Deno.args.includes("--room-numerical") || Deno.args.includes("--room-policy-reset")) {
  console.log(JSON.stringify(await roomNumericalSample(Deno.args.includes("--room-policy-reset")),
    ),
  );
} else if (Deno.args.includes("--room-capture")) {
  console.log(JSON.stringify(await roomCaptureSample(Deno.args.includes("--profile-memory")),
    ),
  );
} else if (Deno.args.includes("--plan")) {
  console.log(JSON.stringify(await planSample()));
} else if (Deno.args.includes("--recovery")) {
  console.log(JSON.stringify(await planSample(true)));
} else if (Deno.args.includes("--reference")) {
  console.log(JSON.stringify(await referenceSample()));
} else if (Deno.args.includes("--preparation")) {
  console.log(JSON.stringify(await preparationSample()));
} else if (Deno.args.includes("--mixed-room")) {
  console.log(JSON.stringify(await preparationSample("mixed")));
} else if (Deno.args.includes("--varying-rooms")) {
  console.log(JSON.stringify(await preparationSample("varying")));
} else if (Deno.args.includes("--room-targets")) {
  console.log(JSON.stringify(await preparationSample("room-targets")));
} else if (Deno.args.includes("--varying-room-targets")) {
  console.log(JSON.stringify(await preparationSample("varying-room-targets")));
} else if (Deno.args.includes("--connected") || Deno.args.includes("--connected-stiff") || Deno.args.includes("--connected-wide")
) {
  console.log(
    JSON.stringify(
      await preparationSample(
        Deno.args.includes("--connected-wide") ? "connected-wide" : Deno.args.includes("--connected-stiff")
          ? "connected-stiff"
          : "connected",
      ),
    ),
  );
} else if (Deno.args.includes("--calibration")) {
  console.log(JSON.stringify(await calibrationSample()));
} else {
  console.log(JSON.stringify({ cpu_model: await cpuModel() }));
  const plans: number[] = [], references: number[] = [], preparations: number[] = [], mixedRooms: number[] = [], varyingRooms: number[] = [], roomTargets: number[] = [], calibrations: number[] = [];
  const connectedSamples: number[] = [], stiffSamples: number[] = [], admissionSamples: number[] = [];
  const admissionInput=connectedAdmissionCpuInput();
  const recoveries: number[] = [], varyingRoomTargets: number[] = [], roomCaptures: number[] = [];
  // An hour per source block exercises the cost of 9,600 independent digests
  // and gzip frames across 400 days. Fixture bytes are never generated in a measured worker.
  const archive = await syntheticRoomArchive(9600);
  const numericInputs = await roomNumericalInputs();
  const connectedInputs = await connectedCaptureCpuInputs();
  const connectedPreparationInputs=await connectedPreparationCpuInputs(),stiffInputs=await connectedStiffCpuInputs();
  const connectedCaptureSamples = Object.fromEntries(
    CONNECTED_CAPTURE_PHASES.map((phase) => [phase, [] as number[]]),
  ) as Record<ConnectedCapturePhase, number[]>;
  const initialRoomFits: number[] = [], resumedRoomFits: number[] = [], roomPolicyResets: number[] = [], roomFinalizations: number[] = [];
  // Interleave so a drifting machine affects both measurements alike.
  for (let run = 1; run <= RUNS; run++) {
    const ref = await coldSample("reference");
    const admission=await coldSample("connected-admission",admissionInput);
    admissionSamples.push(admission.cpu_ms);
    const plan = await coldSample("plan");
    const recovery = await coldSample("recovery");
    recoveries.push(recovery.cpu_ms);
    const preparation = await coldSample("preparation");
    const mixed = await coldSample("mixed-room");
    const varying = await coldSample("varying-rooms");
    const roomTarget = await coldSample("room-targets");
    const varyingRoomTarget = await coldSample("varying-room-targets");
    // Every ordered proposal is measured in its own cold actual owned worker.
    // Keep full72-hour convergence diagnostics explicit (--connected[-stiff]);
    // repeating them here would measure a whole job instead of request CPU.
    const connectedStages:Sample[]=[],stiffStages:Sample[]=[];
    for(const fixture of connectedPreparationInputs)connectedStages.push(await coldSample("connected-replica-prepare",fixture));
    for(const fixture of stiffInputs.preparations)stiffStages.push(await coldSample("connected-replica-prepare",fixture));
    stiffStages.push(await coldSample("connected-replica-initial",stiffInputs.initial),await coldSample("connected-replica-resumed",stiffInputs.resumed));
    const maximum=(samples:Sample[])=>samples.reduce((a,b)=>a.cpu_ms>=b.cpu_ms?a:b);
    const connectedSample=maximum(connectedStages),stiffSample=maximum(stiffStages);
    console.log(JSON.stringify({run,scope:"actual-owned-cold-slices",wide_prepare_cpu_ms:connectedStages.map(s=>s.cpu_ms),stiff_prepare_initial_resumed_cpu_ms:stiffStages.map(s=>s.cpu_ms)}));
    connectedSamples.push(connectedSample.cpu_ms);
    stiffSamples.push(stiffSample.cpu_ms);
    const calibration = await coldSample("calibration");
    const connectedCaptureRun: Record<string, number> = {};
    for (const phase of CONNECTED_CAPTURE_PHASES) {
      const sample = await coldSample(
        `connected-capture-${phase}`,
        connectedInputs[phase],
      );
      connectedCaptureSamples[phase].push(sample.cpu_ms);
      connectedCaptureRun[phase] = sample.cpu_ms;
    }
    const roomCapture = await coldSample("room-capture", archive);
    roomCaptures.push(roomCapture.cpu_ms);
    const initialFit = await coldSample("room-numerical", numericInputs.initial,
    );
    const resumedFit = await coldSample("room-numerical", numericInputs.resumed,
    );
    const policyReset = await coldSample("room-policy-reset", numericInputs.resumed,
    );
    const finalized = await coldSample("room-finalize", numericInputs.completed,
    );
    roomFinalizations.push(finalized.cpu_ms);
    roomPolicyResets.push(policyReset.cpu_ms);
    initialRoomFits.push(initialFit.cpu_ms);
    resumedRoomFits.push(resumedFit.cpu_ms);
    calibrations.push(calibration.cpu_ms);
    references.push(ref.cpu_ms);
    plans.push(plan.cpu_ms);
    preparations.push(preparation.cpu_ms);
    mixedRooms.push(mixed.cpu_ms);
    varyingRooms.push(varying.cpu_ms);
    roomTargets.push(roomTarget.cpu_ms);
    varyingRoomTargets.push(varyingRoomTarget.cpu_ms);
    console.log(JSON.stringify({ run,
      connected_admission:admission,
      connected_capture_cpu_ms: connectedCaptureRun,
      connected_room_cpu_ms: connectedSample.cpu_ms,
      stiff_connected_room_cpu_ms: stiffSample.cpu_ms, room_initial_fit_cpu_ms: initialFit.cpu_ms, room_resumed_fit_cpu_ms: resumedFit.cpu_ms, room_policy_reset_cpu_ms: policyReset.cpu_ms, room_finalize_cpu_ms: finalized.cpu_ms,
      room_initial_fit_rss_kib: initialFit.max_rss_kib, room_resumed_fit_rss_kib: resumedFit.max_rss_kib,
      room_capture_cpu_ms: roomCapture.cpu_ms, room_capture_rss_kib: roomCapture.max_rss_kib,
      reference_cpu_ms: ref.cpu_ms, plan_cpu_ms: plan.cpu_ms, recovery_cpu_ms: recovery.cpu_ms, plan_elapsed_ms: plan.elapsed_ms,
      preparation_cpu_ms: preparation.cpu_ms, preparation_elapsed_ms: preparation.elapsed_ms,
      mixed_room_cpu_ms: mixed.cpu_ms, varying_rooms_cpu_ms: varying.cpu_ms, room_targets_cpu_ms: roomTarget.cpu_ms, varying_room_targets_cpu_ms: varyingRoomTarget.cpu_ms,
      preparation_wasm_memory_bytes: preparation.wasm_memory_bytes, mixed_room_wasm_memory_bytes: mixed.wasm_memory_bytes,
      varying_rooms_wasm_memory_bytes: varying.wasm_memory_bytes,
    }));
  }
  const speed = BASELINE_REFERENCE_MS / median(references);
  const denseInput=await connectedDenseReplicaCpuInput(),denseSamples:number[]=[];
  for(let run=0;run<RUNS;run++)denseSamples.push((await coldSample("connected-dense-pair",denseInput)).cpu_ms);
  const denseCpu=median(denseSamples)*speed;
  console.log(JSON.stringify({stage:"connected-dense-cold-and-warm",baseline_cpu_ms:denseCpu}));
  assert(denseCpu<PREPARATION_BUDGET_MS,`Dense connected cold and warm actions used ${denseCpu.toFixed(1)} baseline ms; budget is ${PREPARATION_BUDGET_MS} ms`);
  const replicaInputs=await connectedReplicaCpuInputs();
  const replicaSamples=Object.fromEntries(CONNECTED_REPLICA_CPU_PHASES.map(phase=>[phase,[] as number[]])) as Record<ConnectedReplicaCpuPhase,number[]>;
  for(let run=0;run<RUNS;run++)for(const phase of CONNECTED_REPLICA_CPU_PHASES) {
    const sample=await coldSample(`connected-replica-${phase}`,replicaInputs[phase]);
    replicaSamples[phase].push(sample.cpu_ms);
    console.log(JSON.stringify({run,stage:`connected-replica-${phase}`,...sample}));
  }
  const admission=median(admissionSamples)*speed;
  console.log(JSON.stringify({median_connected_admission_cpu_ms:median(admissionSamples),baseline_connected_admission_cpu_ms:admission}));
  assert(admission<PREPARATION_BUDGET_MS,`Cold accepted connected-model admission used ${admission.toFixed(1)} baseline ms; budget is ${PREPARATION_BUDGET_MS} ms`);
  for(const phase of CONNECTED_REPLICA_CPU_PHASES) {
    const scaled=median(replicaSamples[phase])*speed;
    console.log(JSON.stringify({stage:`connected-replica-${phase}`,baseline_cpu_ms:scaled}));
    assert(scaled<PREPARATION_BUDGET_MS,`Owned connected ${phase} used ${scaled.toFixed(1)} baseline ms; budget is ${PREPARATION_BUDGET_MS} ms`);
  }
  const scaled = median(plans) * speed;
  console.log(JSON.stringify({ median_plan_cpu_ms: median(plans), median_reference_cpu_ms: median(references), speed_vs_baseline: speed, baseline_plan_cpu_ms: scaled,
    }),
  );
  assert(scaled < BUDGET_MS,
    `Complete cold planning worker used ${
      scaled.toFixed(1)
    } baseline ms CPU (median ${median(plans).toFixed(1)} ms on this machine, ${
      speed.toFixed(2)
    }× baseline speed); budget is ${BUDGET_MS} ms`,
  );
  const recovery = median(recoveries) * speed;
  console.log(JSON.stringify({median_recovery_cpu_ms: median(recoveries), baseline_recovery_cpu_ms: recovery,
    }),
  );
  assert(recovery < BUDGET_MS,
    `Battery commitment recovery used ${
      recovery.toFixed(1)
    } baseline ms CPU; budget is ${BUDGET_MS} ms`,
  );
  const calibration = median(calibrations) * speed;
  console.log(JSON.stringify({ median_calibration_cpu_ms: median(calibrations), baseline_calibration_cpu_ms: calibration,
    }),
  );
  assert(calibration < PREPARATION_BUDGET_MS,
    `Held-out pool calibration used ${
      calibration.toFixed(1)
    } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
  );
  const roomCapture = median(roomCaptures) * speed;
  console.log(JSON.stringify({ median_room_capture_cpu_ms: median(roomCaptures), baseline_room_capture_cpu_ms: roomCapture,
    }),
  );
  assert(roomCapture < BUDGET_MS,
    `Cold chronological room capture used ${
      roomCapture.toFixed(1)
    } baseline ms CPU; budget is ${BUDGET_MS} ms`,
  );
  const initialRoomFit = median(initialRoomFits) * speed, resumedRoomFit = median(resumedRoomFits) * speed;
  console.log(JSON.stringify({ median_room_initial_fit_cpu_ms: median(initialRoomFits), baseline_room_initial_fit_cpu_ms: initialRoomFit,
    median_room_resumed_fit_cpu_ms: median(resumedRoomFits), baseline_room_resumed_fit_cpu_ms: resumedRoomFit,
    }),
  );
  assert(Math.max(initialRoomFit, resumedRoomFit) < BUDGET_MS,
    `Cold numerical room worker used ${initialRoomFit.toFixed(1)} initial / ${
      resumedRoomFit.toFixed(1)
    } resumed baseline ms CPU; budget is ${BUDGET_MS} ms`,
  );
  const roomPolicyReset = median(roomPolicyResets) * speed;
  console.log(JSON.stringify({ median_room_policy_reset_cpu_ms: median(roomPolicyResets), baseline_room_policy_reset_cpu_ms: roomPolicyReset,
    }),
  );
  assert(roomPolicyReset < BUDGET_MS,
    `Cold room policy reset used ${
      roomPolicyReset.toFixed(1)
    } baseline ms CPU; budget is ${BUDGET_MS} ms`,
  );
  const roomFinalized = median(roomFinalizations) * speed;
  console.log(JSON.stringify({ median_room_finalize_cpu_ms: median(roomFinalizations), baseline_room_finalize_cpu_ms: roomFinalized,
    }),
  );
  assert(roomFinalized < BUDGET_MS,
    `Cold room finalization used ${
      roomFinalized.toFixed(1)
    } baseline ms CPU; budget is ${BUDGET_MS} ms`,
  );
  const prepared = median(preparations) * speed;
  console.log(JSON.stringify({ median_preparation_cpu_ms: median(preparations), baseline_preparation_cpu_ms: prepared,
    }),
  );
  assert(prepared < PREPARATION_BUDGET_MS,
    `Cold nine-room admission preparation used ${
      prepared.toFixed(1)
    } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
  );
  const mixed = median(mixedRooms) * speed;
  console.log(JSON.stringify({ median_mixed_room_cpu_ms: median(mixedRooms), baseline_mixed_room_cpu_ms: mixed,
    }),
  );
  assert(mixed < PREPARATION_BUDGET_MS,
    `Cold mixed-device room admission preparation used ${
      mixed.toFixed(1)
    } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
  );
  const roomTarget = median(roomTargets) * speed;
  console.log(JSON.stringify({ median_room_targets_cpu_ms: median(roomTargets), baseline_room_targets_cpu_ms: roomTarget,
    }),
  );
  assert(roomTarget < PREPARATION_BUDGET_MS,
    `Cold shared-room target preparation used ${
      roomTarget.toFixed(1)
    } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
  );
  const varyingRoomTarget = median(varyingRoomTargets) * speed;
  console.log(JSON.stringify({ median_varying_room_targets_cpu_ms: median(varyingRoomTargets), baseline_varying_room_targets_cpu_ms: varyingRoomTarget,
    }),
  );
  assert(varyingRoomTarget < PREPARATION_BUDGET_MS,
    `Cold full-house room target preparation used ${
      varyingRoomTarget.toFixed(1)
    } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
  );
  for (const phase of CONNECTED_CAPTURE_PHASES) {
    const value = median(connectedCaptureSamples[phase]) * speed;
    console.log(JSON.stringify({
      stage: `connected-capture-${phase}`,
      median_cpu_ms: median(connectedCaptureSamples[phase]),
      baseline_cpu_ms: value,
      history_days: 400,
      native_rows: 38400,
      source_blocks: 40,
    }));
    assert(
      value < BUDGET_MS,
      `Cold connected ${phase} stage used ${
        value.toFixed(1)
      } baseline ms CPU; budget is ${BUDGET_MS} ms`,
    );
  }
  for (
    const [name, values] of [["connected", connectedSamples], [
      "connected-stiff",
      stiffSamples,
    ]] as const
  ) {
    const scaled = median(values) * speed;
    console.log(
      JSON.stringify({
        stage: name,
        median_cpu_ms: median(values),
        baseline_cpu_ms: scaled,
      }),
    );
    assert(
      scaled < PREPARATION_BUDGET_MS,
      `${name} native preparation used ${
        scaled.toFixed(1)
      } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
    );
  }
  const varying = median(varyingRooms) * speed;
  console.log(JSON.stringify({ median_varying_rooms_cpu_ms: median(varyingRooms), baseline_varying_rooms_cpu_ms: varying,
    }),
  );
  assert(varying < PREPARATION_BUDGET_MS,
    `Cold varying-physics room admission preparation used ${
      varying.toFixed(1)
    } baseline ms CPU; budget is ${PREPARATION_BUDGET_MS} ms`,
  );
}
