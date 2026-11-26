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

type Post = (path: string, body: Record<string, unknown>) => Promise<unknown>;

export async function deployLearningRelease(deployment: string, projectUrl: string, post: Post, deploy: () => Promise<void>) {
  const { runtime: _localRuntime, ...manifest } = roomLearningWorkerCapabilities();
  const prepared = await post("/rest/v1/rpc/prepare_energy_learning_release", { p_deployment: deployment, p_manifest: manifest });
  if (prepared !== true) throw new Error("Learning release preparation refused the deployment");
  await deploy();
  await post("/rest/v1/rpc/configure_energy_device_learning", { p_project_url: projectUrl });
  const worker = await post("/functions/v1/energy-device-learning", { action: "capabilities" });
  if (typeof worker !== "object" || !worker || !("runtime" in worker) ||
    typeof worker.runtime !== "string" || !worker.runtime.trim() ||
    Object.keys(worker).length !== Object.keys(manifest).length + 1 ||
    Object.entries(manifest).some(([key, value]) => Reflect.get(worker, key) !== value)) {
    throw new Error("Deployed learning worker capabilities differ from the prepared release");
  }
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
  const post: Post = async (path, body) => {
    const response = await fetch(url + path, {
      method: "POST", redirect: "error", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Learning release request to ${path} failed (${response.status})`);
    const data = await response.text();
    return data ? JSON.parse(data) : null;
  };
  await deployLearningRelease(deployment, url, post, async () => {
    const status = await new Deno.Command("supabase", {
      args: ["functions", "deploy", "energy-device-learning", "--project-ref", project, "--use-api", "--yes"],
      stdout: "inherit", stderr: "inherit",
    }).spawn().status;
    if (!status.success) throw new Error("Learning worker deployment failed");
  });
  console.log(`Activated learning deployment ${deployment} for ${project}`);
}
