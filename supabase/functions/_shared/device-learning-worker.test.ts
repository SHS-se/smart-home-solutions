import { ROOM_LEARNER_VERSION } from "./room-learner-version.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { handleDeviceLearning } from "./device-learning-worker.ts";
const request = () => new Request("https://synthetic.test/learning", { method: "POST",
  headers: { "x-energy-learning-token": "synthetic-token" }, body: JSON.stringify({ job_id: "synthetic-job" }) });
Deno.test("learning endpoint authenticates before claiming or fitting", async () => {
  const calls: string[] = [];
  const response = await handleDeviceLearning(request(), { rpc(name: string) {
    calls.push(name); return Promise.resolve({ data: false, error: null });
  } });
  assertEquals(response.status, 401);
  assertEquals(calls, ["verify_energy_learning_token"]);
});
Deno.test("a duplicate wake does not start another fit", async () => {
  const calls: string[] = [];
  const response = await handleDeviceLearning(request(), { rpc(name: string) {
    calls.push(name); return Promise.resolve({ data: name === "verify_energy_learning_token" ? true : null, error: null });
  } });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { claimed: false });
  assertEquals(calls, ["verify_energy_learning_token", "claim_energy_learning_work"]);
});
Deno.test("read failures remain retriable failures, never statistical rejections or model writes", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const response = await handleDeviceLearning(request(), { rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
    if (name === "claim_energy_learning_work") return Promise.resolve({ error: null, data: {
      id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
      owner_kind: "room", room_history_to: "2026-01-01T00:00:00Z", owner_key: "synthetic-room", generation: 2, fence: 7, work_class: "source" as const, input: { learner_version: ROOM_LEARNER_VERSION },
    } });
    if (name === "capture_energy_device_models") return Promise.resolve({ data: null, error: { message: "synthetic read outage" } });
    return Promise.resolve({ data: null, error: null });
  } });
  assertEquals(response.status, 500);
  assertEquals(calls.map(c => c.name), ["verify_energy_learning_token", "claim_energy_learning_work", "capture_energy_device_models", "fail_energy_device_learning", "release_energy_learning_work"]);
  assertEquals(calls.at(-2)!.args, { p_job_id: "synthetic-job", p_generation: 2, p_fence: 7,
    p_error: "Model capture failed: synthetic read outage" });
  assertEquals(calls.at(-1)!.args, { p_job_id: "synthetic-job", p_generation: 2, p_fence: 7 });
});

Deno.test("room admission is released even when failure persistence itself loses its reply", async () => {
  const calls: string[] = [];
  await assertRejects(() => handleDeviceLearning(request(), { rpc(name: string) {
    calls.push(name);
    if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
    if (name === "claim_energy_learning_work") return Promise.resolve({ data: {
      id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
      owner_kind: "room", room_history_to: "2026-01-01T00:00:00Z", owner_key: "synthetic-room", generation: 2, fence: 7, work_class: "source" as const, input: { learner_version: ROOM_LEARNER_VERSION },
    }, error: null });
    if (name === "capture_energy_device_models") return Promise.resolve({ data: null, error: { message: "synthetic read outage" } });
    if (name === "fail_energy_device_learning") throw new Error("synthetic lost failure reply");
    return Promise.resolve({ data: true, error: null });
  } }), Error, "synthetic lost failure reply");
  assertEquals(calls.at(-1), "release_energy_learning_work");
});

Deno.test("room admission does not change independent pool and device failure handling", async () => {
  for (const kind of ["pool", "device"]) {
    const calls: string[] = [];
    const response = await handleDeviceLearning(request(), { rpc(name: string) {
      calls.push(name);
      if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
      if (name === "claim_energy_learning_work") return Promise.resolve({ data: {
        id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
        owner_kind: kind, owner_key: "synthetic-owner", generation: 2, fence: 7, work_class: "device", input: {},
      }, error: null });
      if (name === "capture_energy_device_models") return Promise.resolve({ data: null, error: { message: "synthetic read outage" } });
      return Promise.resolve({ data: true, error: null });
    } });
    assertEquals(response.status, 500);
    assertEquals(calls.at(-1), "fail_energy_device_learning");
    assertEquals(calls.includes("release_energy_learning_work"), false);
  }
});

Deno.test("a room without a heating context uses its generation horizon and current audit clock", async () => {
  const cutoff = Date.UTC(2026, 0, 1), wallNow = cutoff + 4 * 86_400_000;
  const history: Record<string, unknown>[] = [], published: Record<string, unknown>[] = [];
  const response = await handleDeviceLearning(request(), {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "get_energy_thermal_training_quarters") {
        history.push(args);
        return { eq() { return this; }, range() { return Promise.resolve({ data: [], error: null }); } };
      }
      if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
      if (name === "claim_energy_learning_work") return Promise.resolve({ data: {
        id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
        owner_kind: "room", owner_key: "synthetic-room", generation: 2, fence: 7,
        room_history_to: new Date(cutoff).toISOString(), work_class: "source" as const, input: { learner_version: ROOM_LEARNER_VERSION },
      }, error: null });
      if (name === "capture_energy_device_models") return Promise.resolve({ data: {
        rooms: [], devices: [], pool: null, room_heating: {},
      }, error: null });
      if (name === "publish_energy_device_learning") {
        published.push(args.p_model as Record<string, unknown>);
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "release_energy_learning_work") return Promise.resolve({ data: true, error: null });
      throw new Error(`Unexpected synthetic RPC ${name}`);
    },
    from() {
      return { select() { return this; }, eq() { return this; }, is() { return this; },
        limit() { return Promise.resolve({ data: [{ mapping_summary: { room_name: "Synthetic room" } }], error: null }); } };
    },
  }, () => wallNow);
  assertEquals(response.status, 200);
  assertEquals(history.map(row => row.p_to), [new Date(cutoff).toISOString()]);
  assertEquals(history.map(row => row.p_from), [new Date(cutoff - 21 * 86_400_000).toISOString()]);
  assertEquals(published[0].last_attempted_at, new Date(wallNow).toISOString());
});

Deno.test("service role reads worker capabilities and cannot claim through the capability credential", async () => {
  const probe = (body: unknown) => new Request("https://synthetic.test/learning", { method: "POST",
    headers: { authorization: "Bearer synthetic-service" }, body: JSON.stringify(body) });
  const db = { rpc() { throw new Error("Capability probe touched job database"); } };
  const read = await handleDeviceLearning(probe({ action: "capabilities" }), db, Date.now, "synthetic-service");
  const result = await read.json();
  assertEquals([read.status, result.protocol, result.learner_version, result.runtime], [200, 2, ROOM_LEARNER_VERSION, Deno.version.v8]);
  assertEquals((await handleDeviceLearning(probe({ job_id: "job" }), db, Date.now, "synthetic-service")).status, 403);
});

Deno.test("incompatible and missing numerical checkpoints yield before discovery or reset", async () => {
  for (const incompatible of [false, true]) {
    const calls: string[] = [];
    const response = await handleDeviceLearning(request(), { rpc(name: string) {
      calls.push(name);
      if (name === "claim_energy_learning_work") return { data: {
        id: "job", home_id: "home", customer_id: "customer", owner_key: "room", owner_kind: "room", generation: 2, fence: 7,
        room_history_to: "2026-01-01T00:00:00Z", work_class: "numerical",
        input: { learner_version: incompatible ? "future" : ROOM_LEARNER_VERSION },
        room_fit_progress: incompatible ? { cursor: 1, base_revision: 0, metadata: {} } : null }, error: null };
      return { data: true, error: null };
    } });
    assertEquals(await response.json(), incompatible ? { incompatible: true } : { superseded: true });
    assertEquals(calls, ["verify_energy_learning_token", "claim_energy_learning_work", "release_energy_learning_work"]);
  }
});

Deno.test("slice timing preserves the database's queue delay on a handled numerical claim", async () => {
  let event: { queue_ms: number; outcome: string } | undefined;
  const log = console.info;
  try {
    console.info = (message: string) => { event = JSON.parse(message); };
    await handleDeviceLearning(request(), { rpc(name: string) {
      return { data: name === "claim_energy_learning_work" ? { id: "job", home_id: "home", customer_id: "customer",
        owner_key: "room", owner_kind: "room", generation: 1, fence: 2, room_history_to: "2026-01-01T00:00:00Z",
        work_class: "numerical", queue_ms: 417, input: { learner_version: ROOM_LEARNER_VERSION } } : true, error: null };
    } });
  } finally { console.info = log; }
  assertEquals(event?.queue_ms, 417);
  assertEquals(event?.outcome, "superseded");
});
