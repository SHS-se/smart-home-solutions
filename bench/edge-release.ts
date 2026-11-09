// Package or restore an exact planner SHA for TEST. Never run a benchmark here.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitTree, plannerVersion, usesRulePlanner } from "./planner-version.ts";
import { loadPlanner } from "./adapter.ts";
import { bundleBenchFunction, BUNDLED_BENCH_FUNCTIONS } from "./edge-bundle.ts";
import { BENCH_PROJECT, BENCH_TOKEN_HEADER, BENCH_URL, type VersionIdentity } from "./edge-version.ts";
import { retainedCommit } from "./retention.ts";
import { sha256 } from "../src/lib/planner-bench/case.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bucket = "bench-executables";

async function command(program: string, args: string[], cwd = root): Promise<string> {
  const result = await new Deno.Command(program, { args, cwd, stderr: "piped" }).output();
  if (!result.success) throw new Error(`${program} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function replaceOnce(source: string, text: string, replacement: string): string {
  const at = source.indexOf(text);
  if (at < 0 || at !== source.lastIndexOf(text)) throw new Error("Unsupported historical planner loader");
  return source.slice(0, at) + replacement + source.slice(at + text.length);
}

function serviceKey(): string {
  const key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Set the TEST BENCH_SERVICE_ROLE_KEY");
  return key;
}

async function request(path: string, init: RequestInit = {}, allowed: number[] = []): Promise<Response> {
  const key = serviceKey();
  const response = await fetch(`${BENCH_URL}${path}`, { ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...init.headers } });
  if (!response.ok && !allowed.includes(response.status)) {
    throw new Error(`TEST release API ${init.method ?? "GET"} failed (${response.status})`);
  }
  return response;
}

type Artifact = VersionIdentity & { worker: string; bundle_hash: string; committed_at: string; subject: string };

async function deploy(work: string, worker: string, contents: string) {
  const directory = join(work, "supabase/functions", worker);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(join(directory, "index.ts"), contents);
  await command("supabase", ["functions", "deploy", worker, "--project-ref", BENCH_PROJECT,
    "--workdir", work, "--use-api", "--no-verify-jwt", "--yes"]);
}

async function packageVersion(work: string, sha: string, planner_version: string) {
  const archive = join(work, "commit.tar");
  await command("git", ["archive", "--format=tar", `--output=${archive}`, sha]);
  const tree = join(work, "source");
  await Deno.mkdir(tree);
  await command("tar", ["-xf", archive, "-C", tree]);
  await Deno.symlink(join(root, "node_modules"), join(tree, "node_modules"));
  // The historical loader verifies the original source manifest and Wasm before
  // substituting build-time bytes for its filesystem reads.
  const { generation } = await loadPlanner(tree);
  const wasm = join(tree, "supabase/functions/_shared/planner-wasm");
  const manifest = await Deno.readTextFile(join(wasm, "artifact.json"));
  const bytes = await Deno.readFile(join(wasm, "solver.wasm"));
  const base64 = bytes.toBase64();
  const candidateFile = join(tree, "bench/wasm-planner.ts");
  let candidate = await Deno.readTextFile(candidateFile);
  candidate = replaceOnce(candidate, 'import { sourceDigest } from "../scripts/build-planner-wasm.ts";',
    `const sourceDigest = (_root: string) => ${JSON.stringify(JSON.parse(manifest).source_sha256)};`);
  candidate = replaceOnce(candidate, 'await Deno.readTextFile(`${dir}/artifact.json`)', JSON.stringify(manifest));
  candidate = replaceOnce(candidate, 'await Deno.readFile(`${dir}/solver.wasm`)',
    `Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0))`);
  await Deno.writeTextFile(candidateFile, candidate);
  const entry = join(work, "entry.ts"), output = join(work, "entry.js");
  await Deno.writeTextFile(entry, `import * as candidate from ${JSON.stringify(candidateFile)};
import { adaptPlanner } from ${JSON.stringify(join(root, "bench/execution.ts"))};
import { serveBenchVersion } from ${JSON.stringify(join(root, "bench/edge-version.ts"))};
serveBenchVersion(${JSON.stringify({ sha, planner_version, generation })},
  async () => adaptPlanner(candidate, await candidate.loadWasmCandidate("")));
`);
  await bundleBenchFunction(root, entry, output);
  return { generation, contents: await Deno.readTextFile(output) };
}

export async function releaseVersion(ref: string, restore = false): Promise<Artifact> {
  const sha = await command("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const [committed_at, subject] = (await command("git", ["show", "-s", "--format=%cI%n%s", sha])).split("\n");
  if (!retainedCommit(committed_at) || !usesRulePlanner(commitTree(sha, root))) {
    throw new Error(`${sha} is outside supported native benchmark history`);
  }
  const worker = `bench-${sha}`;
  const object = `${bucket}/v1/${sha}.js`;
  const archive = `/storage/v1/object/${object}`;
  const [registered] = await (await request(`/rest/v1/bench_edge_artifacts?sha=eq.${sha}`)).json() as Artifact[];
  if (registered && !restore) return registered;
  const work = await Deno.makeTempDir({ prefix: "bench-edge-release-" });
  try {
    if (registered) {
      const contents = await (await request(`/storage/v1/object/authenticated/${object}`)).text();
      if (await sha256(contents) !== registered.bundle_hash) throw new Error("Archived benchmark executable digest differs");
      await deploy(work, registered.worker, contents);
      return registered;
    }
    const planner_version = await plannerVersion(commitTree(sha, root));
    const { contents, generation } = await packageVersion(work, sha, planner_version);
    const bundle_hash = await sha256(contents);
    const artifact: Artifact = { sha, worker, planner_version, generation, bundle_hash, committed_at, subject };
    const uploaded = await request(archive, { method: "POST", headers: { "content-type": "application/javascript", "x-upsert": "false" }, body: contents }, [400, 409]);
    if (!uploaded.ok) {
      const stored = await (await request(`/storage/v1/object/authenticated/${object}`)).text();
      if (await sha256(stored) !== bundle_hash) throw new Error("Existing benchmark executable differs");
    }
    await deploy(work, worker, contents);
    await request("/rest/v1/bench_edge_artifacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(artifact) });
    return artifact;
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

async function releaseCoordinator() {
  const work = await Deno.makeTempDir({ prefix: "bench-edge-coordinator-" });
  try {
    for (const worker of BUNDLED_BENCH_FUNCTIONS) {
      const output = join(work, "entry.js");
      await bundleBenchFunction(root, join(root, "supabase/functions", worker, "index.ts"), output);
      await deploy(work, worker, await Deno.readTextFile(output));
    }
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

async function refresh(ref: string, branch: string) {
  if (branch !== "main" && branch !== "dev") throw new Error("Bench refresh requires main or dev");
  const active = await (await request("/rest/v1/rpc/bench_edge_active", { method: "POST" })).json();
  if (active !== true) return;
  const artifact = await releaseVersion(ref);
  const token = await (await request("/rest/v1/rpc/bench_edge_token", { method: "POST" })).json();
  if (typeof token !== "string" || !token) throw new Error("TEST bench worker token is not configured");
  const response = await request("/functions/v1/planner-bench-edge", { method: "POST", headers: {
    [BENCH_TOKEN_HEADER]: token, "content-type": "application/json",
  }, body: JSON.stringify({ action: "deployment", sha: artifact.sha, environment: branch === "main" ? "production" : "test" }) });
  const { id } = await response.json();
  if (id === null) throw new Error("TEST bench did not enqueue the deployed version");
  console.log(`Queued TEST bench job ${id}`);
}

if (import.meta.main) {
  const [operation, ...refs] = Deno.args;
  if (operation === "coordinator" && !refs.length) {
    await releaseCoordinator();
  } else if (operation === "refresh" && refs.length === 2) {
    await refresh(refs[0], refs[1]);
  } else {
    if ((operation !== "register" && operation !== "restore") || !refs.length) {
      throw new Error("Usage: edge-release.ts coordinator | register|restore <sha>... | refresh <sha> <branch>");
    }
    for (const ref of refs) {
      const artifact = await releaseVersion(ref, operation === "restore");
      console.log(`${artifact.sha.slice(0, 12)} ${artifact.planner_version} archived and available in TEST`);
    }
  }
}
