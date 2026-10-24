import { HOUSEHOLD } from '../src/lib/planner-bench/household.ts';
import { builderRecipe } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { assertEquals } from "@std/assert";
import { causalCase, command, forecastProblem, problem } from "../tests/planner-wasm.fixture.ts";
import { loadWasmCandidate, readyProblem } from "../bench/wasm-planner.ts";
import recipe from "../planner-core/recipe.json" with { type: "json" };
import roomVectors from "../tests/room-heating-native.fixture.json" with { type: "json" };
import { nativePlanner } from "../supabase/functions/_shared/planner-wasm/runtime.ts";
import type { RoomThermostat } from "../supabase/functions/_shared/planner/thermostat.ts";
import type { RoomQuarter } from "../supabase/functions/_shared/room-heating-schedule.ts";

const root = new URL("..", import.meta.url).pathname;
const planner = await loadWasmCandidate(root);
const base = problem();
const committed = problem();
committed.initial.ev_kwh = 75;
committed.accepted = committed.slots.filter((s) => s.start_seconds < 3600).map((
  _,
  i,
) => command(i % 2 === 0));
committed.locked_through_seconds = 3600;
committed.heater.response = {
  kind: "bergvarme",
  startup: [
    { elapsed_seconds: 0, electric_fraction: .5, heat_fraction: 0 },
    { elapsed_seconds: 1200, electric_fraction: 1, heat_fraction: 1 },
  ],
};
const reservoir = structuredClone(committed);
reservoir.pool_store.response_time_constant_h = .675;
reservoir.initial.pool_pending_heat_kwh = 1.5;
reservoir.initial.pool_c = 29.7;
reservoir.accepted = reservoir.slots.filter(s => s.start_seconds < 3600).map((_, i) => command(i === 0 || i === 3));
const recovering = structuredClone(reservoir);
recovering.heater.source = {recovery_rate_per_h:.15,heat_loss_per_kwh:.02};
recovering.initial.pool_source_depletion_kwh = 9;
for (const input of [base, committed, reservoir, recovering, forecastProblem(), readyProblem(causalCase(), HOUSEHOLD)]) {
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
for (const { name, input } of roomVectors) {
  const process = new Deno.Command(`${root}/planner-core/target/release/shs-planner-core`, {
    args: ["--room"], stdin: "piped", stdout: "piped", stderr: "inherit",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(input)));
  await writer.close();
  const result = await process.output();
  if (!result.success) throw new Error(`Native room reference failed: ${name}`);
  assertEquals(nativePlanner().room({ ...input, thermostats: input.thermostats as RoomThermostat[],
    quarters: input.quarters as RoomQuarter[] }), JSON.parse(new TextDecoder().decode(result.stdout)).plan);
}
console.log("Native and Wasm room commands and physical trajectories match exactly.");
