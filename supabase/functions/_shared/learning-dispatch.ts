import { roomLearningWorkerCapabilities } from "./room-learning-worker-capabilities.ts";

// One wave plus its upstream hops stays within the platform's 30-call trace.
export const LEARNING_DISPATCH_CALLS = 24;
export const LEARNING_DISPATCH_MS = 25_000;
interface DispatchDatabase {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
interface Delivery { job_id: string; delivery_id: string }

/** This driver imports no fitting kernels and never receives model/history bytes. */
export async function handleLearningDispatch(request: Request, db: DispatchDatabase,
  fetcher: typeof fetch = fetch, clock = () => performance.now()): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const token = request.headers.get("x-energy-learning-token") ?? "";
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await db.rpc(name, args);
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
    return result.data;
  };
  let fence: number | undefined;
  let calls = 0, terminated = 0;
  const started = clock();
  try {
    const raw = await request.text();
    if (raw.length > 1024) return Response.json({ error: "request_too_large" }, { status: 413 });
    const body = JSON.parse(raw);
    if (body.action === "capabilities") {
      if (await rpc("verify_energy_learning_token", { p_token: token }) !== true) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(roomLearningWorkerCapabilities());
    }
    if (!Number.isSafeInteger(body.run_fence) || body.run_fence < 1) return Response.json({ error: "invalid_dispatch" }, { status: 400 });
    const claim = await rpc("claim_energy_learning_dispatch", { p_run_fence: body.run_fence,
      p_worker: roomLearningWorkerCapabilities(), p_token: token });
    if (claim === false) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (claim === null) return Response.json({ claimed: false });
    if (!claim || typeof claim !== "object" || !("run_fence" in claim) || claim.run_fence !== body.run_fence ||
      !("worker_url" in claim) || typeof claim.worker_url !== "string" ||
      !/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/energy-device-learning$/.test(claim.worker_url)) throw new Error("Invalid learning dispatch claim");
    fence = body.run_fence;
    const url = claim.worker_url;
    while (calls < LEARNING_DISPATCH_CALLS && clock() - started < LEARNING_DISPATCH_MS) {
      const work = await rpc("take_energy_learning_dispatch_work", { p_run_fence: fence,
        p_limit: Math.min(2, LEARNING_DISPATCH_CALLS - calls) });
      if (work === null || Array.isArray(work) && work.length === 0) break;
      if (!Array.isArray(work) || work.length > 2 || work.some(d => !d || typeof d.job_id !== "string" || typeof d.delivery_id !== "string")) throw new Error("Invalid learning dispatch group");
      const group: Delivery[] = work;
      if (clock() - started >= LEARNING_DISPATCH_MS) {
        await rpc("return_unsent_energy_learning_work", { p_run_fence: fence, p_deliveries: group.map(d => d.delivery_id) });
        break;
      }
      calls += group.length;
      await Promise.all(group.map(async delivery => {
        let response: Response;
        try {
          response = await fetcher(url, { method: "POST", headers: {
            "content-type": "application/json", "x-energy-learning-token": token,
          }, body: JSON.stringify(delivery), redirect: "error", signal: AbortSignal.timeout(25_000) });
          // Drain only the compact receipt. A timeout is ambiguous and must not
          // revoke the child; a terminal 546 proves that its worker stopped.
          await response.arrayBuffer();
        } catch (error) {
          console.warn("[ENERGY-LEARNING-DISPATCH] delivery unresolved", String(error));
          return;
        }
        if (response.status === 546) {
          if (await rpc("recover_terminated_energy_learning_work", { p_run_fence: fence,
            p_delivery_id: delivery.delivery_id, p_status: response.status }) === true) terminated++;
        } else if (!response.ok) console.warn("[ENERGY-LEARNING-DISPATCH] child response", response.status);
      }));
    }
    return Response.json({ calls, recovered: terminated });
  } catch (error) {
    console.error("[ENERGY-LEARNING-DISPATCH] wave failed", String(error));
    return Response.json({ error: "dispatch_failed" }, { status: 500 });
  } finally {
    if (fence !== undefined) {
      try { await rpc("finish_energy_learning_dispatch", { p_run_fence: fence }); }
      catch (error) { console.error("[ENERGY-LEARNING-DISPATCH] release failed", String(error)); }
      console.info(JSON.stringify({ event: "energy_learning_dispatch", calls, recovered: terminated, elapsed_ms: Math.round(clock() - started) }));
    }
  }
}
