import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { deploymentPost, deployLearningRelease, learningDeploymentId } from "../scripts/configure-device-learning.ts";
import { roomLearningWorkerCapabilities } from "../supabase/functions/_shared/room-learning-worker-capabilities.ts";

Deno.test("ordered room deployments preserve run priority and bigint precision", () => {
  assertEquals(learningDeploymentId("90071992548", "11"), "9007199254800011");
  assertEquals(BigInt(learningDeploymentId("90071992549", "1")) > BigInt(learningDeploymentId("90071992548", "99999")), true);
  for (const [run, attempt] of [["", "1"], ["1", "0"], ["1", "100000"], ["-1", "1"], ["9223372036854775807", "1"]]) {
    assertThrows(() => learningDeploymentId(run, attempt));
  }
});

Deno.test("room deployment prepares before deploy and activates only verified hosted capabilities", async () => {
  const worker = { ...roomLearningWorkerCapabilities(), runtime: "synthetic-hosted-runtime" };
  const base = "https://synthetic.invalid";
  const deployment = "12345678900001";
  const prepare = "/rest/v1/rpc/prepare_energy_learning_release", configure = "/rest/v1/rpc/configure_energy_device_learning";
  const probe = "/functions/v1/energy-device-learning", activate = "/rest/v1/rpc/activate_energy_learning_release";
  const tokenPath = "/rest/v1/rpc/get_energy_learning_worker_token";
  const dispatch = "/functions/v1/energy-learning-dispatch";
  const expected = [prepare, "deploy", configure, tokenPath, probe, dispatch, activate];
  for (const failure of ["", "stale", "deploy", "missing_token", "mismatch", "missing_runtime", "extra", "dispatcher", "cas"]) {
    const events: string[] = [];
    const run = () => deployLearningRelease(deployment, base, (path, body, token) => {
      events.push(path);
      assertEquals(token, [probe, dispatch].includes(path) ? "synthetic-learner" : undefined);
      if (path === prepare) {
        const manifest = Object.fromEntries(Object.entries(worker).filter(([key]) => key !== "runtime"));
        assertEquals(body, { p_deployment: deployment, p_manifest: manifest });
        return Promise.resolve(failure !== "stale");
      }
      if (path === configure) {
        assertEquals(body, { p_project_url: base });
        return Promise.resolve(null);
      }
      if (path === tokenPath) {
        assertEquals(body, {});
        return Promise.resolve(failure === "missing_token" ? null : "synthetic-learner");
      }
      if (path === probe || path === dispatch) {
        if (path === dispatch && failure === "dispatcher") return Promise.resolve({ ...worker, runtime: "wrong" });
        assertEquals(body, { action: "capabilities" });
        if (failure === "mismatch") return Promise.resolve({ ...worker, semantic_digest: "synthetic-wrong" });
        if (failure === "missing_runtime") return Promise.resolve({ ...worker, runtime: "" });
        if (failure === "extra") return Promise.resolve({ ...worker, extra: true });
        return Promise.resolve(worker);
      }
      assertEquals(path, activate);
      assertEquals(body, { p_deployment: deployment, p_worker: worker });
      return Promise.resolve(failure !== "cas");
    }, () => {
      events.push("deploy");
      if (failure === "deploy") throw new Error("Synthetic deploy failed");
      return Promise.resolve();
    });
    if (failure) await assertRejects(run);
    else await run();
    const count = failure === "stale" ? 1 : failure === "deploy" ? 2 : failure === "missing_token" ? 4 :
      ["mismatch", "missing_runtime", "extra"].includes(failure) ? 5 : failure === "dispatcher" ? 6 : 7;
    assertEquals(events, expected.slice(0, count));
  }
});

Deno.test("deployment sends the worker wake credential only to the capability probe", async () => {
  const headers: Headers[] = [];
  const post = deploymentPost("https://synthetic.invalid", "synthetic-admin", (_url, init) => {
    headers.push(new Headers(init?.headers));
    assertEquals(init?.redirect, "error");
    return Promise.resolve(Response.json(true));
  });
  await post("/rest/v1/rpc/get_energy_learning_worker_token", {});
  await post("/functions/v1/energy-device-learning", { action: "capabilities" }, "synthetic-wake");
  assertEquals(headers[0].get("authorization"), "Bearer synthetic-admin");
  assertEquals(headers[0].get("apikey"), "synthetic-admin");
  assertEquals(headers[0].get("x-energy-learning-token"), null);
  assertEquals(headers[1].get("authorization"), null);
  assertEquals(headers[1].get("apikey"), null);
  assertEquals(headers[1].get("x-energy-learning-token"), "synthetic-wake");
});
