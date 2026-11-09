import { join } from "node:path";

export const BUNDLED_BENCH_FUNCTIONS: readonly string[] = ["planner-bench-score", "planner-bench-edge"];

export async function bundleBenchFunction(root: string, input: string, output: string): Promise<void> {
  const result = await new Deno.Command(join(root, "node_modules/.bin/esbuild"), {
    cwd: root,
    args: [input, "--bundle", "--platform=node", "--format=esm", "--minify",
      "--legal-comments=none", "--external:https://*", `--outfile=${output}`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(`esbuild failed: ${new TextDecoder().decode(result.stderr).trim()}`);
}
