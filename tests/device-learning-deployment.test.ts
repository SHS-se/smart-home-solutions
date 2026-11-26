import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { deployLearningRelease, learningDeploymentId } from "../scripts/configure-device-learning.ts";
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
  const expected = [prepare, "deploy", configure, probe, activate];
  for (const failure of ["", "stale", "deploy", "mismatch", "missing_runtime", "extra", "cas"]) {
    const events: string[] = [];
    const run = () => deployLearningRelease(deployment, base, (path, body) => {
      events.push(path);
      if (path === prepare) {
        const manifest = Object.fromEntries(Object.entries(worker).filter(([key]) => key !== "runtime"));
        assertEquals(body, { p_deployment: deployment, p_manifest: manifest });
        return Promise.resolve(failure !== "stale");
      }
      if (path === configure) {
        assertEquals(body, { p_project_url: base });
        return Promise.resolve(null);
      }
      if (path === probe) {
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
    const count = failure === "stale" ? 1 : failure === "deploy" ? 2 : ["mismatch", "missing_runtime", "extra"].includes(failure) ? 4 : 5;
    assertEquals(events, expected.slice(0, count));
  }
});
