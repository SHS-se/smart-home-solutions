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
  assertEquals(calls, ["verify_energy_learning_token", "claim_energy_device_learning"]);
});
Deno.test("read failures remain retriable failures, never statistical rejections or model writes", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const response = await handleDeviceLearning(request(), { rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
    if (name === "claim_energy_device_learning") return Promise.resolve({ error: null, data: {
      id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
      owner_kind: "room", owner_key: "synthetic-room", generation: 2, fence: 7, input: {},
    } });
    if (name === "capture_energy_device_models") return Promise.resolve({ data: null, error: { message: "synthetic read outage" } });
    return Promise.resolve({ data: null, error: null });
  } });
  assertEquals(response.status, 500);
  assertEquals(calls.map(c => c.name), ["verify_energy_learning_token", "claim_energy_device_learning", "capture_energy_device_models", "fail_energy_device_learning", "release_energy_room_learning_lane"]);
  assertEquals(calls.at(-2)!.args, { p_job_id: "synthetic-job", p_generation: 2, p_fence: 7,
    p_error: "Model capture failed: synthetic read outage" });
  assertEquals(calls.at(-1)!.args, { p_job_id: "synthetic-job", p_generation: 2, p_fence: 7 });
});

Deno.test("room admission is released even when failure persistence itself loses its reply", async () => {
  const calls: string[] = [];
  await assertRejects(() => handleDeviceLearning(request(), { rpc(name: string) {
    calls.push(name);
    if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
    if (name === "claim_energy_device_learning") return Promise.resolve({ data: {
      id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
      owner_kind: "room", owner_key: "synthetic-room", generation: 2, fence: 7, input: {},
    }, error: null });
    if (name === "capture_energy_device_models") return Promise.resolve({ data: null, error: { message: "synthetic read outage" } });
    if (name === "fail_energy_device_learning") throw new Error("synthetic lost failure reply");
    return Promise.resolve({ data: true, error: null });
  } }), Error, "synthetic lost failure reply");
  assertEquals(calls.at(-1), "release_energy_room_learning_lane");
});

Deno.test("room admission does not change independent pool and device failure handling", async () => {
  for (const kind of ["pool", "device"]) {
    const calls: string[] = [];
    const response = await handleDeviceLearning(request(), { rpc(name: string) {
      calls.push(name);
      if (name === "verify_energy_learning_token") return Promise.resolve({ data: true, error: null });
      if (name === "claim_energy_device_learning") return Promise.resolve({ data: {
        id: "synthetic-job", home_id: "synthetic-home", customer_id: "synthetic-customer",
        owner_kind: kind, owner_key: "synthetic-owner", generation: 2, fence: 7, input: {},
      }, error: null });
      if (name === "capture_energy_device_models") return Promise.resolve({ data: null, error: { message: "synthetic read outage" } });
      return Promise.resolve({ data: true, error: null });
    } });
    assertEquals(response.status, 500);
    assertEquals(calls.at(-1), "fail_energy_device_learning");
    assertEquals(calls.includes("release_energy_room_learning_lane"), false);
  }
});
