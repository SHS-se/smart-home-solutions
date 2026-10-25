import { assertEquals } from "@std/assert";
import { bindCandidateImports } from "../scripts/check-planner-contracts.ts";
Deno.test("historical contract runner preserves old helpers and assertions while binding current production", () => {
  const source = `import { plan } from "../../supabase/functions/_shared/rules-planner.ts";
import type { OptimisationPlan } from '../../supabase/functions/_shared/planner/planning-contracts.ts';
import { syntheticHome } from "./synthetic.ts";
assertEquals(plan(syntheticHome()).amps, 12);`;
  assertEquals(bindCandidateImports(source, "tests/planner-contracts/behavior.test.ts", "/candidate"),
    source.replace('"../../supabase', '"file:///candidate/supabase').replace("'../../supabase", "'file:///candidate/supabase"));
});

Deno.test("editing today's oracle cannot make a changed planner pass the accepted contract", async () => {
  const { checkPlannerContracts } = await import("../scripts/check-planner-contracts.ts");
  const { assertRejects } = await import("@std/assert");
  const directory = await Deno.makeTempDir({ prefix: "synthetic-contract-guard-" });
  const command = async (args: string[]) => {
    const out = await new Deno.Command("git", { cwd: directory, args, stdout: "piped", stderr: "piped" }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  };
  try {
    await assertRejects(() => checkPlannerContracts(directory, ""), Error, "An accepted git revision is required");
    await Deno.mkdir(`${directory}/tests/planner-contracts`, { recursive: true });
    await Deno.writeTextFile(`${directory}/deno.json`, "{}");
    await Deno.writeTextFile(`${directory}/device.ts`, "export const amps = 12;");
    await Deno.writeTextFile(`${directory}/tests/planner-contracts/expected.ts`, "export const expected = 12;");
    await Deno.writeTextFile(`${directory}/tests/planner-contracts/behavior.test.ts`, `
      import { amps } from "../../device.ts";
      import { expected } from "./expected.ts";
      Deno.test("synthetic preserved current", () => { if (amps !== expected) throw new Error("regression"); });`);
    await command(["init", "-q"]);
    await command(["add", "."]);
    await command(["-c", "user.name=Synthetic test", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic accepted contract"]);
    await checkPlannerContracts(directory, "HEAD");
    // Today's test and implementation agree with each other, but violate the old requirement.
    await Deno.writeTextFile(`${directory}/device.ts`, "export const amps = 5;");
    await Deno.writeTextFile(`${directory}/tests/planner-contracts/expected.ts`, "export const expected = 5;");
    await assertRejects(() => checkPlannerContracts(directory, "HEAD"), Error, "Planner behavioral contracts failed");
  } finally { await Deno.remove(directory, { recursive: true }); }
});
