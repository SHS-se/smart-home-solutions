import { assert, assertEquals } from "@std/assert";

const workflow = Deno.readTextFileSync(new URL("../.github/workflows/ci-deploy.yml", import.meta.url));
const gate = workflow.split("\n  ci:\n")[1].split("\n  migrate:\n")[0];
const script = gate.split("        run: |\n")[1]
  .split("\n").filter(line => line.trim()).map(line => line.slice(10)).join("\n");

Deno.test("CI deployment gate waits for quality, every unit shard, Rust and every browser shard", () => {
  assert(gate.includes("needs: [changes, quality, unit, planner-rust, planner-contracts, frontend]"));
  assert(gate.includes("!cancelled()"));
  assert(workflow.includes("fail-fast: false"));
  assert(workflow.includes("run: deno task test --shard ${{ matrix.shard }}/4"));
  assert(workflow.includes("node scripts/e2e-shard.mjs ${{ matrix.shard }}/3"));
  assert(workflow.includes("npm run test:e2e:local -- --test-list"));
  assert(workflow.includes("needs: [changes, ci]"));
});

Deno.test("the actual CI gate rejects failed, cancelled or unexpectedly skipped checks", async () => {
  const success = { QUALITY_RESULT: "success", UNIT_RESULT: "success", PLANNER_RUST_RESULT: "success", PLANNER_CONTRACTS_RESULT: "success", FRONTEND_RESULT: "success", FRONTEND_CHANGED: "true" };
  const scenarios = [
    { env: success, passes: true },
    { env: { ...success, FRONTEND_RESULT: "skipped", FRONTEND_CHANGED: "false" }, passes: true },
    ...["QUALITY_RESULT", "UNIT_RESULT", "PLANNER_RUST_RESULT", "PLANNER_CONTRACTS_RESULT", "FRONTEND_RESULT"].flatMap(key =>
      ["failure", "cancelled", "skipped"].map(result => ({ env: { ...success, [key]: result }, passes: false }))),
  ];
  for (const { env, passes } of scenarios) {
    const result = await new Deno.Command("bash", { args: ["-e", "-c", script], env, stdout: "null", stderr: "null" }).output();
    assertEquals(result.success, passes, JSON.stringify(env));
  }
});

Deno.test("manual deployment retains accepted contracts while deploying all files", async () => {
  const base = workflow.split("        id: base\n")[1].split("\n      - name:")[0];
  const baseScript = base.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
  const directory = await Deno.makeTempDir({ prefix: "synthetic-ci-base-" });
  const accepted = "1234567890abcdef1234567890abcdef12345678";
  try {
    for (const event of ["push", "workflow_dispatch", "pull_request"]) {
      const output = `${directory}/${event}`;
      const result = await new Deno.Command("bash", { args: ["-e", "-c", `gh() { echo '${accepted}'; }\n${baseScript}`],
        env: { EVENT: event, BRANCH: "dev", PR_BASE: accepted, GITHUB_REPOSITORY: "synthetic/repository", GITHUB_OUTPUT: output },
        stdout: "null", stderr: "piped" }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
      const values = Object.fromEntries((await Deno.readTextFile(output)).trim().split("\n").map(line => line.split("=")));
      assertEquals(values.contract_base, accepted);
      assertEquals(values.sha, event === "workflow_dispatch" ? "" : accepted);
    }
    const check = workflow.split("      - name: Run current and previously accepted contracts against this planner")[1]
      .split("\n  planner-rust:")[0].split("        run: ")[1].trim();
    assert(!check.includes(":-HEAD"));
    const missing = await new Deno.Command("bash", { args: ["-e", "-c", check], env: { CONTRACT_BASE: "" },
      stdout: "null", stderr: "piped" }).output();
    assert(!missing.success);
    assert(new TextDecoder().decode(missing.stderr).includes("Cannot find an accepted revision"));
  } finally { await Deno.remove(directory, { recursive: true }); }
});
