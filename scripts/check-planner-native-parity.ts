import { builderRecipe } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { assertEquals } from "@std/assert";
import { command, problem } from "../tests/planner-wasm.fixture.ts";
import { loadWasmCandidate } from "../bench/wasm-planner.ts";
import recipe from "../planner-core/recipe.json" with { type: "json" };

const root = new URL("..", import.meta.url).pathname;
const planner = await loadWasmCandidate(root);
const base = problem();
const committed = problem();
committed.initial.ev_kwh = 75;
committed.accepted = committed.slots.map((_, i) => command(i % 2 === 0));
committed.locked_through_seconds = 3600;
committed.heater.response = {
  kind: "bergvarme",
  startup: [
    { elapsed_seconds: 0, electric_fraction: .5, heat_fraction: 0 },
    { elapsed_seconds: 1200, electric_fraction: 1, heat_fraction: 1 },
  ],
};
for (const input of [base, committed]) {
  input.work_grant = recipe.work_grant;
  input.recipe = builderRecipe(recipe);
  const process = new Deno.Command(
    `${root}/planner-core/target/release/shs-planner-core`,
    {
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    },
  ).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(input)));
  await writer.close();
  const result = await process.output();
  if (!result.success) throw new Error("Native reference planner failed.");
  assertEquals(
    planner.plan(input).outcome,
    JSON.parse(new TextDecoder().decode(result.stdout)),
  );
}
console.log(
  "Native and Wasm commands, physical trajectories, accounts and work usage match exactly.",
);
