import type { NativeRoomNetworkInput, NativeRoomNetworkOutput, NativeRoomNetworkProposal, NativeRoomNetworkAdvanceInput, NativeRoomNetworkAdvanced, NativeRoomNetworkWork, NativeRoomNetworkBelief, NativeRoomNetworkNodeHeader, NativeRoomNetworkDrawSelection, NativeRoomReplica, NativeRoomNetworkReplicaAdvanceInput, NativeRoomNetworkReplicaAdvanced, NativeRoomNetworkReplicaWork, NativeRoomNetworkMerged } from "../room-network-contract.ts";
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
  charge_dc_w: z.number().finite(),
  discharge_dc_w: z.number().finite(),
  battery_idle_w: z.number().finite(),
  net_w: z.number().finite(),
  battery_kwh: z.number().finite().nullable(),
  ev_kwh: z.number().finite().nullable(),
  ev_usage_unserved_kwh: z.number().finite().nonnegative(),
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
const account = z.object({
        score_sek: z.number().finite(),
        points: z.number().finite(),
        cash_sek: z.number().finite(),
        wear_sek: z.number().finite(),
        continuity_sek: z.number().finite(),
        credit_sek: z.number().finite(),
        contributions: z.number().finite().array().array(),
      });
const chargingRole = z.enum(["ordinary", "block", "refinement"]);

export const solveOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({
    kind: z.literal("selected"),
    selection: z.object({
      commands: command.array(),
      quarters: quarter.array(),
      account,
      charging_role: chargingRole,
      charging_alternatives: z.object({ role: chargingRole, commands: command.array(), quarters: quarter.array(), account }).array().max(2),
      minimum_gain_sek: z.number().finite().nonnegative(),
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
        charging_block_trials: z.number().int().nonnegative(),
        charging_block_improvements: z.number().int().nonnegative(),
      }),
    }),
  }),
]);
export const projectionOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({ kind: z.literal("projected"), quarters: quarter.array() }),
]);
const completionOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({ kind: z.literal("projected"), commands: command.array(), quarters: quarter.array(), account }),
]);
const roomPlan = z.object({
    power_w: z.number().finite().array(), thermostat_w: z.number().finite().array().array(),
    targets_c: z.number().finite().array().array(), relays_on: z.boolean().array().array(),
    temperature_c: z.number().finite().array(), shortfall_c: z.number().finite().array(),
    room_targets_c: z.number().finite().array().optional(),
});
const roomNetworkProjection = z.object({plans:roomPlan.array(),temperature_c:z.number().finite().array().array(),mean_temperature_c:z.number().finite().array().array()});
const roomNetworkProposalOutcome = z.discriminatedUnion("kind",[
  z.object({kind:z.literal("failed"),issue:z.string()}),
  z.object({kind:z.literal("planned"),plan:roomNetworkProjection}),
]);
const roomNetworkOutcome = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("failed"), issue: z.string()}),
  z.object({kind: z.literal("planned"), plan: roomNetworkProjection.extend({literal:roomPlan.array()})}),
]);

// The native result has just crossed JSON.parse. Check its owned numerical
// vectors in place before exposing the result or using it for convergence.
export const nativeForecastTotals = z.custom<number[]>((value) => {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) if (!Number.isFinite(value[i])) return false;
  return true;
});
const numericRoomNetworkStatistics=z.object({
  trajectories:z.number().int().nonnegative(),replayed_paths:z.number().int().nonnegative(),
  total:nativeForecastTotals,
  replicates:z.object({trajectories:z.number().int().nonnegative(),total:nativeForecastTotals}).array(),
  infeasible:z.number().int().nonnegative().array().length(3),
});
const packedRoomNetworkStatistics=numericRoomNetworkStatistics.extend({
  total:z.string(),replicates:z.object({trajectories:z.number().int().nonnegative(),total:z.string()}).array(),
});
const roomNetworkAdvancedOutcome=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("failed"),issue:z.string()}),
  z.object({kind:z.literal("advanced"),result:z.object({
    reached_target:z.boolean(),statistics:numericRoomNetworkStatistics.nullable(),
    assessment:z.object({deadline_resolved:z.boolean(),unresolved_deadline_prefixes:z.number().int().nonnegative(),proposal_rejection:z.discriminatedUnion("kind",[
      z.object({kind:z.literal("horizon_shortfall"),room:z.number().int().nonnegative(),horizon_shortfall_difference_c_h:z.number().finite(),twice_standard_error_c_h:z.number().finite().nonnegative()}),
      z.object({kind:z.literal("prefix_cost"),room:z.number().int().nonnegative(),cost_difference:z.number().finite(),twice_standard_error:z.number().finite().nonnegative(),new_miss:z.boolean(),no_improvement:z.boolean()}),
    ]).nullable()}),
    work:z.object({revision:z.literal("joint_regime_replicas_philox_v3"),identity:z.string(),seed:z.tuple([z.number().int(),z.number().int()]),replicate_count:z.number().int().positive(),cursor:z.number().int().nonnegative(),slot:z.number().int().nonnegative(),minute:z.number().int().nonnegative(),deterministic:z.boolean(),statistics:packedRoomNetworkStatistics}).passthrough(),
  })}),
]);

const canonicalResult=roomNetworkAdvancedOutcome.options[1].shape.result;
const replicaWork=canonicalResult.shape.work.omit({replicate_count:true,statistics:true}).extend({
  replica:z.number().int().min(0).max(3),statistics:packedRoomNetworkStatistics.omit({replicates:true}),
}).passthrough();
const nodeHeader=z.object({cdf:z.number().finite().nonnegative().array(),weight_sum:z.number().finite().nonnegative(),count:z.number().int().nonnegative(),deterministic:z.boolean(),thermal_noise_c2_per_h:z.number().finite().nonnegative(),bounded_thermal:z.boolean(),reset_priors:z.object({from:z.number().int().nonnegative(),center_mean:z.number().finite(),center_variance:z.number().finite().nonnegative(),log_reversion_mean:z.number().finite(),log_reversion_sd:z.number().finite().nonnegative(),stationary_variance_scale:z.number().finite().nonnegative(),constant_probability:z.number().finite().min(0).max(1)}).array()});
function nativeReady<T extends z.ZodTypeAny>(schema:T) {
  return z.discriminatedUnion("kind",[z.object({kind:z.literal("failed"),issue:z.string()}),z.object({kind:z.literal("ready"),result:schema})]);
}
const headerOutcome=nativeReady(nodeHeader);
const selectionOutcome=nativeReady(z.object({local_draw:z.number().int().nonnegative(),global_draw:z.number().int().nonnegative(),hypothesis_indexes:z.number().int().nonnegative().nullable().array()}).array());
const replicaOutcome=nativeReady(z.object({work:replicaWork,reached_target:z.boolean(),needs_global_draw:z.number().int().nonnegative().nullable()}));
const mergeOutcome=nativeReady(z.object({work:canonicalResult.shape.work,statistics:numericRoomNetworkStatistics,assessment:canonicalResult.shape.assessment}));

const roomOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), issue: z.string() }),
  z.object({ kind: z.literal("planned"), plan: roomPlan }),
]);
function validateNetworkCoverage(input:NativeRoomNetworkInput,plan:NativeRoomNetworkProposal & {literal?:RoomHeatingPlan[]}) {
  if(plan.plans.length!==input.rooms.length || plan.temperature_c.length!==input.nodes.length ||
    plan.mean_temperature_c.length!==input.nodes.length || plan.temperature_c.some(row=>row.length!==input.hours.length) ||
    plan.mean_temperature_c.some(row=>row.length!==input.hours.length) ||
    plan.literal && plan.literal.length!==input.rooms.length) throw new Error("Invalid native room network coverage");
  plan.plans.forEach((room,i)=>validateRoomCoverage(input.rooms[i].input,room));
  plan.literal?.forEach((room,i)=>validateRoomCoverage(input.rooms[i].input,room));
}
function validateRoomCoverage(input: {quarters:RoomQuarter[];thermostats:readonly RoomThermostat[]},plan:RoomHeatingPlan):void {
      if (Object.values(plan).some(series => series?.length !== input.quarters.length) ||
        Boolean(plan.room_targets_c) !== input.quarters.some(q => q.room_target != null) ||
        plan.targets_c.some(row => row.length !== input.thermostats.length) ||
        plan.thermostat_w.some(row => row.length !== input.thermostats.length) ||
        plan.relays_on.some((row, i) => row.length !== input.quarters[i].relay_w.length)) {
        throw new Error("Invalid native room plan coverage");
      }
}

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
      const { project, complete } = createPlanner(module, true);
      return { project, complete };
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
    exportName: "planner_solve" | "planner_project" | "planner_complete" | "planner_room" | "planner_room_network" | "planner_room_network_forecast" | "planner_room_network_finalize" | "planner_room_network_header" | "planner_room_network_select" | "planner_room_network_replica" | "planner_room_network_merge",
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
    roomNetwork(input: NativeRoomNetworkInput, trace?: PlanningTrace): NativeRoomNetworkProposal {
      const { outcome } = invoke(input, "planner_room_network", value => roomNetworkProposalOutcome.parse(value), trace);
      if (outcome.kind === "failed") throw new Error(outcome.issue);
      validateNetworkCoverage(input,outcome.plan);
      return outcome.plan;
    },
    roomNetworkAdvance(input:NativeRoomNetworkAdvanceInput,trace?:PlanningTrace):NativeRoomNetworkAdvanced {
      const {outcome}=invoke(input,"planner_room_network_forecast",value=>roomNetworkAdvancedOutcome.parse(value),trace);
      if(outcome.kind==="failed")throw new Error(outcome.issue);
      return outcome.result as NativeRoomNetworkAdvanced;
    },
    roomNetworkHeader(input:{belief:NativeRoomNetworkBelief},trace?:PlanningTrace):NativeRoomNetworkNodeHeader {
      const {outcome}=invoke(input,"planner_room_network_header",value=>headerOutcome.parse(value),trace);
      if(outcome.kind==="failed")throw new Error(outcome.issue);
      return outcome.result as NativeRoomNetworkNodeHeader;
    },
    roomNetworkSelect(input:{node_headers:NativeRoomNetworkNodeHeader[];seed:[number,number];replica:NativeRoomReplica;local_draws:number[]},trace?:PlanningTrace):NativeRoomNetworkDrawSelection[] {
      const {outcome}=invoke(input,"planner_room_network_select",value=>selectionOutcome.parse(value),trace);
      if(outcome.kind==="failed")throw new Error(outcome.issue);
      return outcome.result as NativeRoomNetworkDrawSelection[];
    },
    roomNetworkReplicaAdvance(input:NativeRoomNetworkReplicaAdvanceInput,trace?:PlanningTrace):NativeRoomNetworkReplicaAdvanced {
      const {outcome}=invoke(input,"planner_room_network_replica",value=>replicaOutcome.parse(value),trace);
      if(outcome.kind==="failed")throw new Error(outcome.issue);
      return outcome.result as NativeRoomNetworkReplicaAdvanced;
    },
    roomNetworkMerge(input:{network:NativeRoomNetworkInput;identity:string;seed:[number,number];replicas:NativeRoomNetworkReplicaWork[]},trace?:PlanningTrace):NativeRoomNetworkMerged {
      const {outcome}=invoke(input,"planner_room_network_merge",value=>mergeOutcome.parse(value),trace);
      if(outcome.kind==="failed")throw new Error(outcome.issue);
      return outcome.result as NativeRoomNetworkMerged;
    },
    roomNetworkFinalize(input:{network:NativeRoomNetworkInput;work:NativeRoomNetworkWork},trace?:PlanningTrace):NativeRoomNetworkOutput {
      const {outcome}=invoke(input,"planner_room_network_finalize",value=>roomNetworkOutcome.parse(value),trace);
      if(outcome.kind==="failed")throw new Error(outcome.issue);
      validateNetworkCoverage(input.network,outcome.plan);
      return outcome.plan;
    },
    room(input: { start_c: number; start_stored_heat_c: number; thermostats: readonly RoomThermostat[]; quarters: RoomQuarter[] }, trace?: PlanningTrace): RoomHeatingPlan {
      const { outcome } = invoke(input, "planner_room", value => roomOutcome.parse(value), trace);
      if (outcome.kind === "failed") throw new Error(outcome.issue);
      const plan = outcome.plan as RoomHeatingPlan;
      validateRoomCoverage(input,plan);
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
        const roles = [s.charging_role, ...s.charging_alternatives.map(c => c.role)];
        if (
          !roles.includes("ordinary") || new Set(roles).size !== roles.length ||
          [s, ...s.charging_alternatives].some(c =>
            c.commands.length !== problem.slots.length || c.quarters.length !== problem.slots.length ||
            c.account.contributions.length !== problem.slots.length ||
            c.account.contributions.some(row => row.length !== problem.rules.length)) ||
          s.work_used > problem.work_grant || s.work.used !== s.work_used ||
          s.work.limit !== problem.work_grant || s.work.reserved !== 0 ||
          s.work.evaluations !== s.evaluations ||
          s.economic.some((hit) =>
            hit.quarters.some((i) => i >= problem.slots.length)
          ) ||
          s.runs.some((run) =>
            run.from >= run.to || run.to > problem.slots.length
          )
        ) {
          throw new Error(
            "Invalid selected-plan coverage or work accounting.",
          );
        }
      }
      return result;
    },
    complete(problem: ReadyProblem, commands: NativeCommand[]) {
      const result = invoke({ problem, commands }, "planner_complete", value => completionOutcome.parse(value) as Wire<z.infer<typeof completionOutcome>>);
      if (result.outcome.kind === "projected" && (result.outcome.quarters.length !== problem.slots.length || result.outcome.commands.length !== problem.slots.length)) {
        throw new Error("Invalid completed command coverage.");
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
