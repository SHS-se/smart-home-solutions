import type { OptimisationPlan } from "./planner/energy-optimisation.ts";

/**
 * Keys a schema 9 plan carries beside the schedule it shares with
 * `execution_plan`. Everything else at the top level is the execution plan.
 * `thermal_projection` is descriptive and added by ingest after planning.
 */
const TOP_LEVEL_ONLY = ["schema_version", "operating_scope", "battery_execution", "execution_plan", "thermal_projection"] as const;

/** The execution plan a schema 9 plan's own top level describes. */
export function derivedExecutionPlan(plan: OptimisationPlan): OptimisationPlan {
  const execution: Record<string, unknown> = { ...plan };
  for (const key of TOP_LEVEL_ONLY) delete execution[key];
  return { ...execution, schema_version: 8 } as OptimisationPlan;
}

/**
 * The form of a plan written to `energy_optimisation_current.plan`.
 *
 * A schema 9 plan repeats its whole schedule in `execution_plan`, which
 * doubles the multi-megabyte JSONB write that must finish inside the API
 * statement timeout. Storage leaves the copy out only when it is exactly the
 * top level, so nothing is lost; any divergence is stored as generated. Home
 * Assistant receives the generated plan from ingest, never this stored form.
 */
export function storedPlan<T extends OptimisationPlan>(plan: T): T {
  if (plan.schema_version !== 9 || !plan.execution_plan ||
      !sameJson(plan.execution_plan, derivedExecutionPlan(plan))) return plan;
  const { execution_plan: _derived, ...stored } = plan;
  return stored as T;
}

/** Restores the `execution_plan` that `storedPlan` left out. */
export function expandStoredPlan<T extends OptimisationPlan>(plan: T): T {
  if (plan.schema_version !== 9 || plan.execution_plan) return plan;
  return { ...plan, execution_plan: derivedExecutionPlan(plan) };
}

/** Equality of the JSON the two values serialize to. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return jsonScalar(a) === jsonScalar(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameJson(value ?? null, b[index] ?? null));
  }
  const left = present(a as Record<string, unknown>);
  const right = present(b as Record<string, unknown>);
  return left.length === right.length &&
    left.every((key) => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

const present = (value: Record<string, unknown>) =>
  Object.keys(value).filter((key) => value[key] !== undefined && typeof value[key] !== "function");

const jsonScalar = (value: unknown) => value === undefined ? undefined : JSON.stringify(value);
