/** Run today's contracts AND the previously accepted contracts against today's code.
 * Expectations are source-controlled assertions, never generated planner snapshots.
 */
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { specifiers } from "./module-graph.ts";

export const CONTRACTS = "tests/planner-contracts";
/** Historical helpers stay historical; production imports resolve to the candidate checkout. */
export function bindCandidateImports(source: string, file: string, repository: string): string {
  for (const specifier of specifiers(source, { types: true })) {
    if (!specifier.startsWith(".")) continue;
    const target = resolve(repository, dirname(file), specifier);
    const local = relative(repository, target).replaceAll("\\", "/");
    if (local.startsWith(CONTRACTS + "/")) continue;
    const url = pathToFileURL(target).href;
    source = source.replaceAll(`"${specifier}"`, `"${url}"`).replaceAll(`'${specifier}'`, `'${url}'`);
  }
  return source;
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", { cwd: repository, args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trimEnd();
}
async function test(repository: string, directory: string): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), { cwd: repository,
    args: ["test", "--config", join(repository, "deno.json"), "--no-check", "--sloppy-imports", "--allow-read", directory],
    stdout: "piped", stderr: "piped" }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  if (!result.success) throw new Error(`Planner behavioral contracts failed (${directory})\n${decode(result.stdout)}\n${decode(result.stderr)}`);
  console.log(decode(result.stdout).trim());
}

export async function checkPlannerContracts(repository: string, base: string): Promise<void> {
  if (!base.trim()) throw new Error("An accepted git revision is required");
  // Fail if the old revision cannot be read; do not quietly substitute current tests.
  const revision = await git(repository, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  await test(repository, join(repository, CONTRACTS));
  const names = (await git(repository, ["ls-tree", "-r", "--name-only", revision, "--", CONTRACTS])).split("\n").filter(Boolean);
  if (!names.length) {
    console.log(`Contract bootstrap: ${revision} predates this suite. Historical protection starts with its first accepted commit.`);
    return;
  }
  if (!names.some(name => name.endsWith(".test.ts"))) throw new Error("Historical contract suite contains no tests");
  const temporary = await Deno.makeTempDir({ prefix: "shs-accepted-planner-contracts-" });
  try {
    for (const name of names) {
      const contents = await git(repository, ["show", `${revision}:${name}`]);
      const target = join(temporary, name);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeTextFile(target, name.endsWith(".ts") ? bindCandidateImports(contents, name, repository) : contents);
    }
    console.log(`Running accepted contracts from ${revision} against ${repository}`);
    await test(repository, join(temporary, CONTRACTS));
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}
if (import.meta.main) {
  if (Deno.args.length && (Deno.args.length !== 2 || Deno.args[0] !== "--base")) throw new Error("Usage: --base <accepted git revision>");
  await checkPlannerContracts(new URL("..", import.meta.url).pathname, Deno.args.length ? Deno.args[1] : "HEAD");
}
