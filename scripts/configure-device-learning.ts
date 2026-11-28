import { roomLearningWorkerCapabilities } from "../supabase/functions/_shared/room-learning-worker-capabilities.ts";

/** A rerun follows its original run; it can never supersede a later run. */
export function learningDeploymentId(run: string, attempt: string): string {
  if (!/^[1-9]\d*$/.test(run) || !/^[1-9]\d{0,4}$/.test(attempt)) {
    throw new Error("Learning worker deployment requires the GitHub run ID and run attempt");
  }
  const id = BigInt(run) * 100000n + BigInt(attempt);
  if (id > 9223372036854775807n) throw new Error("Learning deployment ID exceeds the database bigint range");
  return id.toString();
}

type Post = (path: string, body: Record<string, unknown>, learningToken?: string) => Promise<unknown>;

export function deploymentPost(url: string, key: string, request: typeof fetch = fetch): Post {
  return async (path, body, learningToken) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (learningToken) headers.set("x-energy-learning-token", learningToken);
    else {
      headers.set("apikey", key);
      headers.set("authorization", `Bearer ${key}`);
    }
    const response = await request(url + path, { method: "POST", redirect: "error", headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Learning release request to ${path} failed (${response.status})`);
    const data = await response.text();
    return data ? JSON.parse(data) : null;
  };
}

export async function deployLearningRelease(deployment: string, projectUrl: string, post: Post, deploy: (functions: readonly string[]) => Promise<void>) {
  const { runtime: _localRuntime, ...manifest } = roomLearningWorkerCapabilities();
  const prepared = await post("/rest/v1/rpc/prepare_energy_learning_release", { p_deployment: deployment, p_manifest: manifest });
  if (prepared !== true) throw new Error("Learning release preparation refused the deployment");
  await deploy(["energy-device-learning", "energy-device-learning-peer"]);
  await post("/rest/v1/rpc/configure_energy_device_learning", { p_project_url: projectUrl });
  const token = await post("/rest/v1/rpc/get_energy_learning_worker_token", {});
  if (typeof token !== "string" || !token) throw new Error("Learning worker credential unavailable");
  const worker = await post("/functions/v1/energy-device-learning", { action: "capabilities" }, token);
  if (typeof worker !== "object" || !worker || !("runtime" in worker) ||
    typeof worker.runtime !== "string" || !worker.runtime.trim() ||
    Object.keys(worker).length !== Object.keys(manifest).length + 1 ||
    Object.entries(manifest).some(([key, value]) => Reflect.get(worker, key) !== value)) {
    throw new Error("Deployed learning worker capabilities differ from the prepared release");
  }
  const verifyExecutor = async (endpoint: string) => {
    const observed = await post(`/functions/v1/${endpoint}`, { action: "capabilities" }, token);
    if (!observed || typeof observed !== "object" || Object.keys(observed).length !== Object.keys(worker).length ||
      Object.entries(worker).some(([key, value]) => Reflect.get(observed, key) !== value)) {
      throw new Error(`Deployed ${endpoint} capabilities differ from the primary learning worker`);
    }
  };
  await verifyExecutor("energy-device-learning-peer");
  // Install the caller only after both destinations are deployed and verified.
  await deploy(["energy-learning-dispatch"]);
  await verifyExecutor("energy-learning-dispatch");
  const active = await post("/rest/v1/rpc/activate_energy_learning_release", { p_deployment: deployment, p_worker: worker });
  if (active !== true) throw new Error("Learning release activation refused the deployment");
}

if (import.meta.main) {
  const [project, run, attempt] = Deno.args;
  if (!/^[a-z0-9]{20}$/.test(project ?? "")) throw new Error("Supply an explicit Supabase project ref");
  const deployment = learningDeploymentId(run, attempt);
  const result = await new Deno.Command("supabase", {
    args: ["projects", "api-keys", "--project-ref", project, "--reveal", "--output", "json"], stdout: "piped", stderr: "null",
  }).output();
  if (!result.success) throw new Error("Could not read deployment credentials");
  const keys = JSON.parse(new TextDecoder().decode(result.stdout));
  const key = keys.find((row: { name: string }) => row.name === "service_role")?.api_key;
  if (typeof key !== "string" || !key) throw new Error("Service credential unavailable");
  const url = `https://${project}.supabase.co`;
  await deployLearningRelease(deployment, url, deploymentPost(url, key), async (functions) => {
    const status = await new Deno.Command("supabase", {
      args: ["functions", "deploy", ...functions, "--project-ref", project, "--use-api", "--yes"],
      stdout: "inherit", stderr: "inherit",
    }).spawn().status;
    if (!status.success) throw new Error("Learning worker deployment failed");
  });
  console.log(`Activated learning deployment ${deployment} for ${project}`);
}
