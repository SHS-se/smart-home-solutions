// Independent synthetic deliveries and responses; no measured inputs.
import { assertEquals } from "@std/assert";
import { handleLearningDispatch, LEARNING_DISPATCH_CALLS, LEARNING_DISPATCH_MS } from "./learning-dispatch.ts";
const request = (body: unknown = { run_fence: 7 }) => new Request("https://synthetic.invalid", {
  method: "POST", headers: { "x-energy-learning-token": "synthetic" }, body: JSON.stringify(body) });
function fixture(options: { reject?: boolean; duplicate?: boolean; late?: boolean } = {}) {
  let now = 0, serial = 0;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = { rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    let data: unknown = true;
    if (name === "claim_energy_learning_dispatch") data = options.reject ? false : options.duplicate ? null :
      { run_fence: 7, worker_url: "https://synthetic.supabase.co/functions/v1/energy-device-learning" };
    if (name === "take_energy_learning_dispatch_work") {
      if (options.late) now = LEARNING_DISPATCH_MS;
      data = [0, 1].map(() => ({ job_id: `job-${++serial}`, delivery_id: `delivery-${serial}` }));
    }
    return Promise.resolve({ data, error: null });
  } };
  return { db, calls, clock: () => now, advance: () => { now += LEARNING_DISPATCH_MS; } };
}
Deno.test("dispatcher bounds each wave to 24 children and two concurrent deliveries", async () => {
  const f = fixture(); let active = 0, maximum = 0, count = 0;
  const response = await handleLearningDispatch(request(), f.db, async (_url, init) => {
    assertEquals(new Headers(init?.headers).get("x-energy-learning-token"), "synthetic");
    maximum = Math.max(maximum, ++active); count++;
    await Promise.resolve(); active--;
    return Response.json({ checkpointed: true });
  }, f.clock);
  assertEquals(await response.json(), { calls: LEARNING_DISPATCH_CALLS, recovered: 0 });
  assertEquals([count, maximum], [24, 2]);
  assertEquals(f.calls.at(-1)?.name, "finish_energy_learning_dispatch");
});
Deno.test("dispatcher returns only known unsent work when its start window closes", async () => {
  const f = fixture({ late: true }); let sent = 0;
  const response = await handleLearningDispatch(request(), f.db, () => { sent++; throw new Error("must not send"); }, f.clock);
  assertEquals(await response.json(), { calls: 0, recovered: 0 });
  assertEquals(sent, 0);
  assertEquals(f.calls.at(-2), { name: "return_unsent_energy_learning_work", args: { p_run_fence: 7, p_deliveries: ["delivery-1", "delivery-2"] } });
});
Deno.test("dispatcher recovers terminal 546 only; an ambiguous timeout retains ownership", async () => {
  const f = fixture(); let n = 0;
  const response = await handleLearningDispatch(request(), f.db, () => {
    f.advance();
    if (++n === 1) return Promise.resolve(new Response("terminated", { status: 546 }));
    throw new DOMException("ambiguous", "TimeoutError");
  }, f.clock);
  assertEquals(await response.json(), { calls: 2, recovered: 1 });
  assertEquals(f.calls.filter(c => c.name === "recover_terminated_energy_learning_work"), [{
    name: "recover_terminated_energy_learning_work", args: { p_run_fence: 7, p_delivery_id: "delivery-1", p_status: 546 },
  }]);
});
Deno.test("unauthorized and duplicate roots never send or finish another root", async () => {
  for (const options of [{ reject: true }, { duplicate: true }]) {
    const f = fixture(options);
    const response = await handleLearningDispatch(request(), f.db, () => { throw new Error("must not send"); });
    assertEquals(response.status, options.reject ? 401 : 200);
    assertEquals(f.calls.map(c => c.name), ["claim_energy_learning_dispatch"]);
  }
});
