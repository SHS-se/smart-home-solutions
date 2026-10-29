import { z } from "zod";
import type { NativeCommand, ReadyProblem } from "./ready-problem.ts";
import { planningStage, type PlanningTrace } from "../planning-trace.ts";
import type { RoomQuarter, RoomHeatingPlan } from "../room-heating-schedule.ts";
import type { RoomThermostat } from "../planner/thermostat.ts";

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
    "shave_import",
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
  pool_pending_heat_kwh: z.number().finite().nonnegative().nullable(),
  pool_source_depletion_kwh: z.number().finite().nonnegative().nullable(),
  heater_state: age.nullable(),
  pool_start: z.object({
    off_seconds: z.number().finite().nonnegative().nullable(),
  }).nullable(),
  cost: z.number().finite(),
  wear: z.number().finite(),
  continuity: z.number().finite(),
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
        continuity_sek: z.number().finite(),
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
const roomOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({ kind: z.literal("planned"), plan: z.object({
    power_w: z.number().finite().array(), thermostat_w: z.number().finite().array().array(),
    targets_c: z.number().finite().array().array(), relays_on: z.boolean().array().array(),
    temperature_c: z.number().finite().array(), shortfall_c: z.number().finite().array(),
  }) }),
]);
// All fields in the validated wire schemas are required. Preserve that fact
// for browser consumers whose project disables strictNullChecks (Zod otherwise
// infers optional object keys there); runtime parsing remains unchanged.
type Wire<T> = T extends readonly (infer Item)[] ? Wire<Item>[]
  : T extends object ? { [Key in keyof T]-?: Wire<T[Key]> } : T;
export type NativeQuarter = Wire<z.infer<typeof quarter>>;
export type ProjectionOutcome = Wire<z.infer<typeof projectionOutcome>>;
export type SolveOutcome = Wire<z.infer<typeof solveOutcome>>;

// Hosted Edge wraps the public Memory constructor. Exported memories retain
// their native brand, so constructor identity is not a portable ABI check.
function plannerMemory(
  value: WebAssembly.ExportValue,
): value is WebAssembly.Memory {
  return typeof value === "object" && value !== null &&
    Object.prototype.toString.call(value) === "[object WebAssembly.Memory]" &&
    "buffer" in value && value.buffer instanceof ArrayBuffer;
}

/** Fresh native memory per invocation for live planning and independent reference checks. */
export function createWasmPlanner(bytes: Uint8Array) {
  const module = new WebAssembly.Module(new Uint8Array(bytes));
  return { ...createPlanner(module, false),
    /** One solve request owns the allocator for its sequential postprocessing
     * projections. No physical state or memory crosses request boundaries. */
    projectionSession() {
      const { project } = createPlanner(module, true);
      return { project };
    },
  };
}

/** One monthly replay owns its projection memory; optimiser solves remain private.
 * Thousands of quarter projections must not depend on GC reclaiming a new Wasm
 * memory for every trial. Rust projections carry all state in their input and
 * return independently decoded JSON, so only the allocator is retained here.
 */
export function createWasmReplayPlanner(bytes: Uint8Array) {
  return createPlanner(new WebAssembly.Module(new Uint8Array(bytes)), true);
}

function createPlanner(module: WebAssembly.Module, reuseProjections: boolean) {
  let projectionInstance: WebAssembly.Instance | undefined;
  let projectionFailure: Error | undefined;
  function invoke<T>(
    inputValue: unknown,
    exportName: "planner_solve" | "planner_project" | "planner_room",
    parse: (value: unknown) => T,
    trace?: PlanningTrace,
  ) {
    const retained = reuseProjections && exportName === "planner_project";
    if (retained && projectionFailure) throw projectionFailure;
    const instance = planningStage(trace, "wasm_instantiate", () => retained
      ? projectionInstance ??= new WebAssembly.Instance(module)
      : new WebAssembly.Instance(module));
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
    const input = planningStage(trace, "wasm_input_encode", () => new TextEncoder().encode(JSON.stringify(inputValue)));
    const allocated = trace?.start("wasm_input_allocate", { input_bytes: input.length });
    const pointer: number = alloc(input.length);
    if (
      !Number.isSafeInteger(pointer) || pointer < 0 ||
      pointer + input.length > memory.buffer.byteLength
    ) throw new Error("Invalid planner input allocation.");
    let outputPointer = 0, outputLength = 0;
    try {
      new Uint8Array(memory.buffer, pointer, input.length).set(input);
      allocated?.();
      const result: bigint = planningStage(trace, "wasm_execute", () => run(pointer, input.length), { export: exportName });
      const decoded = trace?.start("wasm_output_decode");
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
      decoded?.({ input_bytes: input.length, output_bytes: outputLength, wasm_memory_bytes: memory.buffer.byteLength });
      // Wasm memory only grows: replay projections report their retained
      // instance's high-water mark. This is not whole-handler/browser RSS.
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
    room(input: { start_c: number; start_delivered_w: number; thermostats: readonly RoomThermostat[]; quarters: RoomQuarter[] }, trace?: PlanningTrace): RoomHeatingPlan {
      const { outcome } = invoke(input, "planner_room", value => roomOutcome.parse(value), trace);
      if (outcome.kind === "failed") throw new Error(outcome.issue);
      const plan = outcome.plan as RoomHeatingPlan;
      if (Object.values(plan).some(series => series.length !== input.quarters.length) ||
        plan.targets_c.some(row => row.length !== input.thermostats.length) ||
        plan.thermostat_w.some(row => row.length !== input.thermostats.length) ||
        plan.relays_on.some((row, i) => row.length !== input.quarters[i].relay_w.length)) {
        throw new Error("Invalid native room plan coverage");
      }
      return plan;
    },
    solve(problem: ReadyProblem, trace?: PlanningTrace) {
      const result = invoke(
        problem,
        "planner_solve",
        (value) => solveOutcome.parse(value) as SolveOutcome,
        trace,
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
      try {
        const result = invoke(
          { problem, commands },
          "planner_project",
          (value) => projectionOutcome.parse(value) as ProjectionOutcome,
        );
        if (
          result.outcome.kind === "projected" &&
          result.outcome.quarters.length !== problem.slots.length
        ) {
          throw new Error("Invalid model projection coverage.");
        }
        return result;
      } catch (error) {
        if (reuseProjections) {
          projectionInstance = undefined;
          projectionFailure = error instanceof Error ? error : new Error(String(error));
          throw projectionFailure;
        }
        throw error;
      }
    },
  };
}
