/** Configure the deployed project's database-owned wake endpoint; never expose its token. */
const project = Deno.args[0];
if (!project || !/^[a-z0-9]+$/.test(project)) throw new Error("Supply an explicit Supabase project ref");
const result = await new Deno.Command("supabase", { args: ["projects", "api-keys", "--project-ref", project, "--reveal", "--output", "json"],
  stdout: "piped", stderr: "null" }).output();
if (!result.success) throw new Error("Could not read deployment credentials");
const keys = JSON.parse(new TextDecoder().decode(result.stdout));
const key = keys.find((row: { name: string }) => row.name === "service_role")?.api_key;
if (!key) throw new Error("Service credential unavailable");
const url = `https://${project}.supabase.co`;
const response = await fetch(`${url}/rest/v1/rpc/configure_energy_device_learning`, {
  method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ p_project_url: url }),
});
if (!response.ok) throw new Error(`Learning endpoint configuration failed (${response.status})`);
await response.body?.cancel();
console.log(`Configured device learning for ${project}`);
