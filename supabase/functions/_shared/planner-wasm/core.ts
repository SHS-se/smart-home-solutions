import { z } from "zod";
import type { NativeCommand, ReadyProblem } from "./ready-problem.ts";

const age = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off_unobserved") }),
  z.object({
    kind: z.literal("off"),
    seconds: z.number().finite().nonnegative(),
  }),
  z.object({ kind: z.literal("steady") }),
  z.object({
    kind: z.literal("running"),
    seconds: z.number().finite().nonnegative(),
  }),
]);
const command = z.object({
  pool_on: z.boolean(),
  ev_amps: z.number().int().nonnegative(),
  battery: z.enum([
    "idle",
    "solar_charge",
    "hold",
    "self_consumption",
    "grid_charge",
    "supply_house",
    "export",
  ]),
  charge_limit_w: z.number().finite(),
  discharge_limit_w: z.number().finite(),
});
const quarter = z.object({
  pool_command_w: z.number().finite(),
  pool_w: z.number().finite(),
  pool_compressor_w: z.number().finite(),
  pool_auxiliary_w: z.number().finite(),
  pool_heat_w: z.number().finite(),
  curtailed_w: z.number().finite(),
  ev_w: z.number().finite(),
  charge_w: z.number().finite(),
  discharge_w: z.number().finite(),
  net_w: z.number().finite(),
  battery_kwh: z.number().finite().nullable(),
  ev_kwh: z.number().finite().nullable(),
  pool_c: z.number().finite().nullable(),
  heater_state: age.nullable(),
  pool_start: z.object({
    off_seconds: z.number().finite().nonnegative().nullable(),
  }).nullable(),
  cost: z.number().finite(),
  wear: z.number().finite(),
  spare_battery_cover_w: z.number().finite(),
});
export const solveOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({
    kind: z.literal("selected"),
    selection: z.object({
      commands: command.array(),
      quarters: quarter.array(),
      account: z.object({
        score_sek: z.number().finite(),
        points: z.number().int(),
        cash_sek: z.number().finite(),
        wear_sek: z.number().finite(),
        credit_sek: z.number().finite(),
        contributions: z.number().int().array().array(),
      }),
      work_used: z.number().int().nonnegative(),
      evaluations: z.number().int().nonnegative(),
      termination: z.enum(["grant_exhausted", "bounded_complete"]),
      witness_coverage: z.object({
        family: z.string(),
        trials: z.number().int().nonnegative(),
        proven: z.number().int().nonnegative(),
        quota_exhausted: z.boolean(),
      }).array(),
      economic: z.object({
        published: z.boolean(),
        rule: z.enum([
          "export_before_import",
          "battery_headroom_solar",
          "pool_solar_preheat",
          "pool_wait_for_sun",
          "import_avoidable_by_storage",
          "battery_price_spread",
          "battery_preserve",
          "high_value_export",
          "pool_cheaper_heating",
          "ev_timing",
          "uneconomic_cycling",
        ]),
        quarters: z.number().int().nonnegative().array(),
        saving_sek: z.number().finite(),
      }).array(),
      runs: z.object({
        device: z.enum(["pool", "ev", "battery"]),
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        purpose: z.string(),
      }).array(),
      work: z.object({
        used: z.number().int().nonnegative(),
        limit: z.number().int().nonnegative(),
        reserved: z.number().int().nonnegative(),
        unit_cost: z.number().int().nonnegative(),
        expansions: z.number().int().nonnegative(),
        evaluations: z.number().int().nonnegative(),
        witness_trials: z.number().int().nonnegative(),
        repairs: z.number().int().nonnegative(),
        move_resize_trials: z.number().int().nonnegative(),
        move_resize_passes: z.number().int().nonnegative(),
        move_resize_improvements: z.number().int().nonnegative(),
      }),
    }),
  }),
]);
export const projectionOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({ kind: z.literal("projected"), quarters: quarter.array() }),
]);
export type NativeQuarter = z.infer<typeof quarter>;
export type ProjectionOutcome = z.infer<typeof projectionOutcome>;
export type SolveOutcome = z.infer<typeof solveOutcome>;

// Hosted Edge wraps the public Memory constructor. Exported memories retain
// their native brand, so constructor identity is not a portable ABI check.
function plannerMemory(
  value: WebAssembly.ExportValue,
): value is WebAssembly.Memory {
  return typeof value === "object" && value !== null &&
    Object.prototype.toString.call(value) === "[object WebAssembly.Memory]" &&
    "buffer" in value && value.buffer instanceof ArrayBuffer;
}

/** Compile once; each solve gets private mutable memory and no cross-home cache. */
export function createWasmPlanner(bytes: Uint8Array) {
  const module = new WebAssembly.Module(new Uint8Array(bytes));
  function invoke<T>(
    inputValue: unknown,
    exportName: "planner_solve" | "planner_project",
    parse: (value: unknown) => T,
  ) {
    const instance = new WebAssembly.Instance(module);
    const {
      memory,
      planner_alloc: alloc,
      planner_free: free,
      [exportName]: run,
    } = instance.exports;
    if (
      !plannerMemory(memory) || typeof alloc !== "function" ||
      typeof free !== "function" || typeof run !== "function"
    ) {
      const exports = Object.entries(instance.exports).map(([name, value]) =>
        `${name}:${typeof value}:${value?.constructor?.name}`
      ).join(",");
      throw new Error(`Invalid planner Wasm exports: ${exports}`);
    }
    const input = new TextEncoder().encode(JSON.stringify(inputValue));
    const pointer: number = alloc(input.length);
    if (
      !Number.isSafeInteger(pointer) || pointer < 0 ||
      pointer + input.length > memory.buffer.byteLength
    ) throw new Error("Invalid planner input allocation.");
    let outputPointer = 0, outputLength = 0;
    try {
      new Uint8Array(memory.buffer, pointer, input.length).set(input);
      const result: bigint = run(pointer, input.length);
      if (typeof result !== "bigint") {
        throw new Error("Invalid planner result ABI.");
      }
      outputPointer = Number(result & 0xffff_ffffn);
      outputLength = Number(result >> 32n);
      if (outputPointer + outputLength > memory.buffer.byteLength) {
        throw new Error("Invalid planner output allocation.");
      }
      const text = new TextDecoder().decode(
        new Uint8Array(memory.buffer, outputPointer, outputLength),
      );
      const outcome = parse(JSON.parse(text));
      // Wasm memory only grows, so its final size is its instance high-water
      // mark. This excludes JS/compiler memory and is not whole-handler RSS.
      return {
        outcome,
        wasm_memory_bytes: memory.buffer.byteLength,
        input_bytes: input.length,
        output_bytes: outputLength,
      };
    } finally {
      if (outputLength) free(outputPointer, outputLength);
      free(pointer, input.length);
    }
  }
  return {
    solve(problem: ReadyProblem) {
      const result = invoke(
        problem,
        "planner_solve",
        (value) => solveOutcome.parse(value),
      );
      const { outcome } = result;
      if (outcome.kind === "selected") {
        const s = outcome.selection;
        if (
          s.commands.length !== problem.slots.length ||
          s.quarters.length !== problem.slots.length ||
          s.account.contributions.length !== problem.slots.length ||
          s.work_used > problem.work_grant || s.work.used !== s.work_used ||
          s.work.limit !== problem.work_grant || s.work.reserved !== 0 ||
          s.work.evaluations !== s.evaluations ||
          s.economic.some((hit) =>
            hit.quarters.some((i) => i >= problem.slots.length)
          ) ||
          s.runs.some((run) =>
            run.from >= run.to || run.to > problem.slots.length
          ) ||
          s.account.contributions.some((row) =>
            row.length !== problem.rules.length
          )
        ) {
          throw new Error(
            "Invalid selected-plan coverage or work accounting.",
          );
        }
      }
      return result;
    },
    project(problem: ReadyProblem, commands: NativeCommand[]) {
      const result = invoke(
        { problem, commands },
        "planner_project",
        (value) => projectionOutcome.parse(value),
      );
      if (
        result.outcome.kind === "projected" &&
        result.outcome.quarters.length !== problem.slots.length
      ) {
        throw new Error("Invalid model projection coverage.");
      }
      return result;
    },
  };
}
