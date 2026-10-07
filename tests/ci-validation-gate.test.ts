import { assert, assertEquals } from "@std/assert";

const workflow = Deno.readTextFileSync(new URL("../.github/workflows/ci-deploy.yml", import.meta.url));
const gate = workflow.split("\n  ci:\n")[1].split("\n  migrate:\n")[0];
const script = gate.split("        run: |\n")[1]
  .split("\n").filter(line => line.trim()).map(line => line.slice(10)).join("\n");

Deno.test("CI deployment gate waits for quality, every unit shard, Rust and browser tests", () => {
  assert(gate.includes("needs: [changes, quality, unit, planner-rust, frontend]"));
  assert(gate.includes("!cancelled()"));
  assert(workflow.includes("fail-fast: false"));
  assert(workflow.includes("run: deno task test --shard ${{ matrix.shard }}/4"));
  assert(workflow.includes("needs: [changes, ci]"));
});

Deno.test("the actual CI gate rejects failed, cancelled or unexpectedly skipped checks", async () => {
  const success = { QUALITY_RESULT: "success", UNIT_RESULT: "success", PLANNER_RUST_RESULT: "success", FRONTEND_RESULT: "success", FRONTEND_CHANGED: "true" };
  const scenarios = [
    { env: success, passes: true },
    { env: { ...success, FRONTEND_RESULT: "skipped", FRONTEND_CHANGED: "false" }, passes: true },
    ...["QUALITY_RESULT", "UNIT_RESULT", "PLANNER_RUST_RESULT", "FRONTEND_RESULT"].flatMap(key =>
      ["failure", "cancelled", "skipped"].map(result => ({ env: { ...success, [key]: result }, passes: false }))),
  ];
  for (const { env, passes } of scenarios) {
    const result = await new Deno.Command("bash", { args: ["-e", "-c", script], env, stdout: "null", stderr: "null" }).output();
    assertEquals(result.success, passes, JSON.stringify(env));
  }
});
