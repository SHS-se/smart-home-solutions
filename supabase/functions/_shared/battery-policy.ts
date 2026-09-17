import {
  type BatterySearchScope,
  createBatteryActionDomain,
} from "./battery-action-domain.ts";
/** Offline battery counterfactuals. No HA commands, interpolation or thermal model. */
import { z } from "zod";
import {
  type Equipment,
  type HouseholdCandidate,
  householdCandidateSchema,
  type HouseholdProblem,
  parseHouseholdProblem,
  type Violation,
} from "./household-case.ts";
import {
  type BatteryPrefix,
  createBatteryPrefixScorer,
  createHouseholdScorer,
  emptyObjective,
  HOUSEHOLD_SCORER_VERSION,
  type HouseholdScore,
  type Objective,
} from "./household-score.ts";

export const BATTERY_POLICY_VERSION = "offline-battery-policy-v1";
export const BATTERY_POLICY_LIMITS = {
  // A 288-quarter merit-order curve can use two points per band plus endpoints.
  terminal_points: 578,
  intervals: 288,
  alternatives: 12,
  requested_levels: 32,
  combined_levels: 48,
  curtailment_fractions: 4,
  retained_per_level: 8,
  total_interval_evaluations: 40_000_000,
  output_bytes: 2_000_000,
} as const;
type Battery = Extract<Equipment, { kind: "battery" }>;
type BatteryAction = Extract<
  HouseholdCandidate["actions"][string][number],
  { kind: "battery" }
>;
type Scored = Extract<HouseholdScore, { status: "scored" }>;
interface Path {
  actions: BatteryAction[];
  pv_curtail_w: number[];
}
interface Alternative {
  id: string;
  current: Path;
}
interface Node {
  path: Path;
  score: BatteryPrefix;
  bucket: number;
  key: string;
  idle: boolean;
  guided: boolean;
}
export interface SearchEvidence {
  scorer_calls: number;
  interval_evaluations: number;
  dominated_prefixes: number;
  pruned_prefixes: number;
  feasible_extensions: number;
  exhaustive_in_declared_graph: boolean;
}
type Outcome =
  | {
    id: string;
    status: "solved";
    candidate: HouseholdCandidate;
    score: Scored;
    search: SearchEvidence;
  }
  | {
    id: string;
    status: "current_infeasible";
    violations: Violation[];
    search: SearchEvidence;
  }
  | {
    id: string;
    status: "no_solution_found";
    reason: "search_pruned" | "declared_graph_exhausted";
    search: SearchEvidence;
  };

const nonnegative = z.number().finite().nonnegative();
export const batteryPolicyRequestSchema = z.object({
  problem: z.unknown(),
  reference_id: z.string().min(1).max(100),
  alternatives: z.array(
    z.object({
      id: z.string().min(1).max(100),
      current: z.object({
        actions: z.array(z.unknown()).min(1).max(
          BATTERY_POLICY_LIMITS.intervals,
        ),
        pv_curtail_w: z.array(nonnegative).min(1).max(
          BATTERY_POLICY_LIMITS.intervals,
        ),
      }).strict(),
    }).strict(),
  ).min(1).max(BATTERY_POLICY_LIMITS.alternatives),
  search: z.object({
    energy_levels_kwh: z.array(nonnegative).max(
      BATTERY_POLICY_LIMITS.requested_levels,
    ),
    pv_curtailment_fractions: z.array(nonnegative.max(1)).min(1).max(
      BATTERY_POLICY_LIMITS.curtailment_fractions,
    ),
    retained_per_level: z.number().int().min(1).max(
      BATTERY_POLICY_LIMITS.retained_per_level,
    ),
    max_interval_evaluations: z.number().int().min(1).max(
      BATTERY_POLICY_LIMITS.total_interval_evaluations,
    ),
  }).strict(),
}).strict();
class Rejection extends Error {
  constructor(
    readonly reason:
      | "invalid_input"
      | "unsupported_scope"
      | "work_limit_exceeded",
    message: string,
  ) {
    super(message);
  }
}
const sortedNumbers = (values: number[]) =>
  [...new Set(values)].sort((a, b) => a - b);
const compareNodes = (a: Node, b: Node) =>
  a.score.objective.total_sek - b.score.objective.total_sek ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const candidate = (
  id: string,
  battery: Battery,
  path: Path,
): HouseholdCandidate => ({
  id,
  pv_curtail_w: path.pv_curtail_w,
  actions: { [battery.id]: path.actions },
});
function combine(terms: { value: Objective; weight: number }[]): Objective {
  return Object.fromEntries(
    Object.keys(terms[0].value).map((key) => [
      key,
      terms.reduce(
        (sum, term) => sum + term.value[key as keyof Objective] * term.weight,
        0,
      ),
    ]),
  ) as unknown as Objective;
}

/** Full scoring is retained for the forced current prefix and final witness. */
function prefixScorers(problem: HouseholdProblem, battery: Battery) {
  const cache = new Map<number, ReturnType<typeof createHouseholdScorer>>();
  return (length: number) => {
    let scorer = cache.get(length);
    if (!scorer) {
      const prefix: HouseholdProblem = {
        ...problem,
        intervals: problem.intervals.slice(0, length),
        plant: {
          ...problem.plant,
          pv_w: problem.plant.pv_w.slice(0, length),
          residual_loads: problem.plant.residual_loads.map((load) => ({
            ...load,
            power_w: load.power_w.slice(0, length),
          })),
          equipment: [{
            ...battery,
            available: battery.available.slice(0, length),
            grid_charge_allowed: battery.grid_charge_allowed.slice(0, length),
            export_allowed: battery.export_allowed.slice(0, length),
          }],
        },
        economics: {
          ...problem.economics,
          import_sek_per_kwh: problem.economics.import_sek_per_kwh.slice(
            0,
            length,
          ),
          export_sek_per_kwh: problem.economics.export_sek_per_kwh.slice(
            0,
            length,
          ),
          terminal: length === problem.intervals.length
            ? problem.economics.terminal
            : [],
        },
      };
      scorer = createHouseholdScorer(prefix);
      cache.set(length, scorer);
    }
    return scorer;
  };
}

/** Bands allocate beam slots only; actual energy and action powers remain exact. */
function energyBands(
  problem: HouseholdProblem,
  battery: Battery,
  goals: number[],
) {
  const duration = Math.max(
    ...problem.intervals.map((i) =>
      (Date.parse(i.end) - Date.parse(i.start)) / 3600000
    ),
  );
  const transfers = [
    battery.charge_max_w * (battery.conversion ? 1 : battery.charge_efficiency),
    battery.discharge_max_w /
    (battery.conversion ? 1 : battery.discharge_efficiency),
  ]
    .filter((x) => x > 0).map((x) => x * duration / 1000);
  const span = battery.state_kwh.max - battery.state_kwh.min;
  const count = transfers.length
    ? Math.max(1, Math.min(24, Math.ceil(span / Math.min(...transfers))))
    : 1;
  return sortedNumbers([
    ...goals,
    ...Array.from(
      { length: count + 1 },
      (_, i) => battery.state_kwh.min + span * i / count,
    ),
  ]);
}
function bandIndex(edges: number[], energy: number) {
  let lo = 0, hi = edges.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (edges[mid] <= energy) lo = mid;
    else hi = mid;
  }
  return lo;
}
/** Future cost is a pruning guide, never the reported objective or a feasibility test.
 * Drop inter-quarter ramp for the guide; the actual search and final score retain it.
 */
function futureGuide(
  problem: HouseholdProblem,
  start: number,
  edges: number[],
  domain: ReturnType<typeof createBatteryActionDomain>,
  fractions: number[],
  scorer: ReturnType<typeof createBatteryPrefixScorer>,
) {
  const rows = Array.from(
    { length: problem.intervals.length + 1 },
    () => edges.map(() => 0),
  );
  let evaluations = 0;
  function value(index: number, energy: number) {
    const j = bandIndex(edges, energy), row = rows[index];
    if (edges.length === 1 || energy <= edges[j]) return row[j];
    if (energy >= edges[j + 1]) return row[j + 1];
    if (!Number.isFinite(row[j]) || !Number.isFinite(row[j + 1])) {
      // Unknown neighboring guide states do not restrict the exact search.
      return Math.min(row[j], row[j + 1]);
    }
    return row[j] +
      (row[j + 1] - row[j]) * (energy - edges[j]) / (edges[j + 1] - edges[j]);
  }
  for (let i = problem.intervals.length - 1; i >= start; i--) {
    for (const [j, energy] of edges.entries()) {
      let best = Infinity;
      for (
        const step of domain.propose(
          i,
          energy,
          [edges[0], edges.at(-1)!],
          fractions,
          null,
        )
      ) {
        evaluations++;
        const result = scorer.extend(
          {
            length: i,
            energy_kwh: energy,
            import_w: null,
            objective: emptyObjective(),
          },
          step.action,
          step.curtail_w,
        );
        if (result.status === "invalid_candidate") {
          throw new Error("Invalid guide action");
        }
        if (result.status !== "scored") continue;
        best = Math.min(
          best,
          result.prefix.objective.total_sek +
            value(i + 1, result.prefix.energy_kwh),
        );
      }
      rows[i][j] = best;
    }
  }
  return { value, evaluations };
}

function compile(input: unknown, scope: BatterySearchScope) {
  const request = batteryPolicyRequestSchema.parse(input);
  // Check raw cardinalities before parsing/cloning the resolved model.
  z.object({
    intervals: z.array(z.unknown()).min(1).max(BATTERY_POLICY_LIMITS.intervals),
    plant: z.object({
      residual_loads: z.array(z.unknown()).max(32),
      equipment: z.array(z.unknown()).length(1),
      thermal_stores: z.array(z.unknown()).length(0),
    }),
  }).parse(request.problem);
  const boundedSeries = z.array(z.unknown()).max(
    BATTERY_POLICY_LIMITS.intervals,
  );
  z.object({
    plant: z.object({
      pv_w: boundedSeries,
      residual_loads: z.array(z.object({ power_w: boundedSeries })).max(32),
      equipment: z.array(
        z.object({
          available: boundedSeries,
          grid_charge_allowed: boundedSeries.optional(),
          export_allowed: boundedSeries.optional(),
        }),
      ).length(1),
    }),
    economics: z.object({
      import_sek_per_kwh: boundedSeries,
      export_sek_per_kwh: boundedSeries,
      terminal: z.array(
        z.object({
          curve: z.object({
            points: z.array(z.unknown()).max(
              BATTERY_POLICY_LIMITS.terminal_points,
            ),
          }),
        }),
      ).max(1),
    }),
  }).parse(request.problem);
  const problem = parseHouseholdProblem(request.problem);
  const equipment = problem.plant.equipment[0];
  if (
    equipment.kind !== "battery" || problem.economics.services.length ||
    problem.economics.completed_event_ids.length
  ) {
    throw new Rejection(
      "unsupported_scope",
      "This slice requires one battery, no thermal/EV equipment and no service events",
    );
  }
  const battery = equipment;
  const n = problem.intervals.length;
  const segmentEnd = new Date(
    (Math.floor(Date.parse(problem.intervals[0].start) / 900000) + 1) * 900000,
  ).toISOString();
  const block =
    problem.intervals.findIndex((v) =>
      Date.parse(v.end) === Date.parse(segmentEnd)
    ) + 1;
  if (!block) {
    throw new Rejection(
      "unsupported_scope",
      "Horizon must reach the end of the current canonical quarter",
    );
  }
  const ids = request.alternatives.map((a) => a.id);
  if (new Set(ids).size !== ids.length || !ids.includes(request.reference_id)) {
    throw new Rejection(
      "invalid_input",
      "Unique alternatives must include the named reference",
    );
  }
  const alternatives: Alternative[] = request.alternatives.map((a) => {
    if (
      a.current.actions.length !== block ||
      a.current.pv_curtail_w.length !== block
    ) {
      throw new Rejection(
        "invalid_input",
        "Every alternative must cover the complete remaining current quarter",
      );
    }
    const parsed = householdCandidateSchema.parse({
      id: a.id,
      pv_curtail_w: a.current.pv_curtail_w,
      actions: { [battery.id]: a.current.actions },
    }) as HouseholdCandidate;
    const actions = parsed.actions[battery.id];
    if (!actions.every((action) => action.kind === "battery")) {
      throw new Rejection(
        "unsupported_scope",
        "Only materialised battery actions are supported",
      );
    }
    return {
      id: a.id,
      current: {
        actions: actions as BatteryAction[],
        pv_curtail_w: parsed.pv_curtail_w,
      },
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const { search } = request;
  if (
    search.energy_levels_kwh.some((x) =>
      x < battery.state_kwh.min || x > battery.state_kwh.max
    )
  ) {
    throw new Rejection(
      "invalid_input",
      "Search energy levels must lie within physical bounds",
    );
  }
  const fractions = sortedNumbers(search.pv_curtailment_fractions);
  const scorers = prefixScorers(problem, battery);
  const incremental = createBatteryPrefixScorer(problem);
  const evidence = (): SearchEvidence => ({
    scorer_calls: 0,
    interval_evaluations: 0,
    dominated_prefixes: 0,
    pruned_prefixes: 0,
    feasible_extensions: 0,
    exhaustive_in_declared_graph: true,
  });
  const evaluate = (path: Path, stats: SearchEvidence) => {
    stats.scorer_calls++;
    stats.interval_evaluations += path.actions.length;
    const result = scorers(path.actions.length).score(
      candidate("search", battery, path),
    );
    if (result.status === "invalid_candidate") {
      throw new Error(
        `Compiler generated an invalid candidate: ${
          JSON.stringify(result.violations)
        }`,
      );
    }
    return result;
  };
  // Forced-prefix scores are bounded by alternatives * intervals, independent of search.
  if (block + n > search.max_interval_evaluations) {
    throw new Rejection(
      "work_limit_exceeded",
      "Budget cannot cover current validation and final authoritative score",
    );
  }
  const initial = alternatives.map((a) => {
    const stats = evidence();
    return { alternative: a, stats, score: evaluate(a.current, stats) };
  });
  const levels = sortedNumbers([
    battery.state_kwh.min,
    battery.state_kwh.max,
    battery.state_kwh.initial,
    ...search.energy_levels_kwh,
    ...initial.flatMap((item) =>
      item.score.status === "scored"
        ? [item.score.trajectory.state[battery.id].at(-1)!]
        : []
    ),
  ]);
  if (levels.length > BATTERY_POLICY_LIMITS.combined_levels) {
    throw new Rejection(
      "work_limit_exceeded",
      "Too many combined target energy levels",
    );
  }
  const domain = createBatteryActionDomain(problem, scope);
  const bands = energyBands(problem, battery, levels);
  const maxNodes = Math.max(1, bands.length - 1) * search.retained_per_level +
    2;
  const maxExtensions = domain.proposalBound(levels.length, fractions.length);
  const guideBound = (n - block) * bands.length *
    domain.proposalBound(2, fractions.length);
  let perAlternativeBound = block + n;
  for (let length = block + 1; length <= n; length++) {
    perAlternativeBound += (length === block + 1 ? 1 : maxNodes) *
      maxExtensions;
  }
  const totalBound = guideBound + perAlternativeBound * alternatives.length;
  if (
    guideBound + perAlternativeBound > search.max_interval_evaluations ||
    totalBound > BATTERY_POLICY_LIMITS.total_interval_evaluations
  ) {
    throw new Rejection(
      "work_limit_exceeded",
      `Worst-case work ${
        guideBound + perAlternativeBound
      } interval evaluations per alternative (${totalBound} total) exceeds the declared or compiler limit`,
    );
  }
  const guide = futureGuide(
    problem,
    block,
    bands,
    domain,
    fractions,
    incremental,
  );
  if (guide.evaluations > guideBound) {
    throw new Error("Guide exceeded preflight work bound");
  }
  const compareGuided = (a: Node, b: Node) =>
    (a.score.objective.total_sek +
        guide.value(a.score.length, a.score.energy_kwh)) -
      (b.score.objective.total_sek +
        guide.value(b.score.length, b.score.energy_kwh)) || compareNodes(a, b);
  const outcomes: Outcome[] = initial.map(
    ({ alternative: a, stats, score }): Outcome => {
      if (score.status !== "scored") {
        return {
          id: a.id,
          status: "current_infeasible",
          violations: score.violations,
          search: stats,
        };
      }
      let frontier: Node[] = [{
        path: a.current,
        score: {
          length: block,
          energy_kwh: score.trajectory.state[battery.id].at(-1)!,
          import_w: score.trajectory.intervals.at(-1)!.import_w,
          objective: score.objective,
        },
        bucket: bandIndex(bands, score.trajectory.state[battery.id].at(-1)!),
        idle: true,
        guided: true,
        key: JSON.stringify(a.current),
      }];
      for (let index = block; index < n; index++) {
        const merged = new Map<string, Node>();
        for (const node of frontier) {
          const children: Node[] = [];
          for (
            const extension of domain.propose(
              index,
              node.score.energy_kwh,
              levels,
              fractions,
              node.score.import_w,
            )
          ) {
            stats.scorer_calls++;
            stats.interval_evaluations++;
            const step = incremental.extend(
              node.score,
              extension.action,
              extension.curtail_w,
            );
            if (step.status === "invalid_candidate") {
              throw new Error(
                `Compiler generated an invalid candidate: ${
                  JSON.stringify(step.violations)
                }`,
              );
            }
            if (step.status !== "scored") continue;
            stats.feasible_extensions++;
            children.push({
              path: {
                actions: [...node.path.actions, extension.action],
                pv_curtail_w: [...node.path.pv_curtail_w, extension.curtail_w],
              },
              key: `${node.key}/${
                JSON.stringify([extension.action, extension.curtail_w])
              }`,
              score: step.prefix,
              bucket: bandIndex(bands, step.prefix.energy_kwh),
              idle: node.idle && extension.action.charge_w === 0 &&
                extension.action.discharge_w === 0 && extension.curtail_w === 0,
              guided: false,
            });
          }
          if (node.guided && children.length) {
            children.sort(compareGuided)[0].guided = true;
          }
          for (const next of children) {
            const stateKey = JSON.stringify([
              next.score.energy_kwh,
              next.score.import_w,
            ]);
            const previous = merged.get(stateKey);
            if (previous) {
              stats.dominated_prefixes++;
              const winner = compareNodes(next, previous) < 0 ? next : previous;
              winner.idle = next.idle || previous.idle;
              winner.guided = next.guided || previous.guided;
              merged.set(stateKey, winner);
            } else merged.set(stateKey, next);
          }
        }
        const buckets = new Map<number, Node[]>();
        for (const node of merged.values()) {
          const bucket = buckets.get(node.bucket) ?? [];
          bucket.push(node);
          buckets.set(node.bucket, bucket);
        }
        frontier = [...buckets.values()].flatMap((bucket) => {
          bucket.sort(compareGuided);
          // Once complete, keep all finals until the minimum is selected.
          const keep = index === n - 1
            ? bucket.length
            : search.retained_per_level;
          const retained = bucket.filter((node, i) =>
            i < keep || node.idle || node.guided
          );
          stats.pruned_prefixes += bucket.length - retained.length;
          return retained;
        }).sort(compareNodes);
        if (!frontier.length) break;
      }
      stats.exhaustive_in_declared_graph = stats.pruned_prefixes === 0;
      if (!frontier.length) {
        return {
          id: a.id,
          status: "no_solution_found",
          reason: stats.exhaustive_in_declared_graph
            ? "declared_graph_exhausted"
            : "search_pruned",
          search: stats,
        };
      }
      const best = frontier.sort(compareNodes)[0];
      const verified = evaluate(best.path, stats);
      if (
        verified.status !== "scored" ||
        JSON.stringify(verified.objective) !==
          JSON.stringify(best.score.objective)
      ) throw new Error("Authoritative full score disagrees with search");
      if (stats.interval_evaluations > perAlternativeBound) {
        throw new Error("Compiler exceeded its preflight work bound");
      }
      return {
        id: a.id,
        status: "solved",
        candidate: candidate(a.id, battery, best.path),
        score: verified,
        search: stats,
      };
    },
  );
  const reference = outcomes.find((a) => a.id === request.reference_id)!;
  const work = {
    interval_evaluations_upper_bound: totalBound,
    interval_evaluations: outcomes.reduce(
      (sum, a) => sum + a.search.interval_evaluations,
      guide.evaluations,
    ),
    scorer_calls: outcomes.reduce(
      (sum, a) => sum + a.search.scorer_calls,
      guide.evaluations,
    ),
  };
  if (reference.status !== "solved") {
    return {
      status: "reference_unavailable" as const,
      reference_id: request.reference_id,
      outcomes: outcomes.map((a) =>
        a.status === "solved"
          ? { id: a.id, status: a.status, search: a.search }
          : a
      ),
      work,
    };
  }
  const current = (s: Scored) =>
    combine(
      s.intervals.slice(0, block).map((row) => ({
        value: row.objective,
        weight: 1,
      })),
    );
  const referenceCurrent = current(reference.score);
  const compiled = outcomes.flatMap((a) => {
    if (a.status !== "solved") return [];
    const C = current(a.score);
    const F = combine([
      { value: a.score.objective, weight: 1 },
      { value: reference.score.objective, weight: -1 },
      { value: C, weight: -1 },
      { value: referenceCurrent, weight: 1 },
    ]);
    return [{
      id: a.id,
      candidate: a.candidate,
      full: a.score.objective,
      current: C,
      future_delta: F,
      total_delta_sek: a.score.objective.total_sek -
        reference.score.objective.total_sek,
      search: a.search,
    }];
  });
  const ranked = [...compiled].sort((a, b) =>
    a.total_delta_sek - b.total_delta_sek || (a.id < b.id ? -1 : 1)
  );
  return {
    status: "compiled" as const,
    compiler_version: BATTERY_POLICY_VERSION,
    scorer_version: HOUSEHOLD_SCORER_VERSION,
    identity: problem.identity,
    reference_id: reference.id,
    coverage: {
      kind: "exact_problem_anchor" as const,
      problem,
      segment_end: segmentEnd,
      current_interval_count: block,
      response_model: "explicit_imposed_power" as const,
      interpolation: "unsupported" as const,
      optimality: outcomes.every((a) => a.search.exhaustive_in_declared_graph)
        ? "optimal_in_declared_graph" as const
        : "unproven_after_pruning" as const,
      approximation_error_bound_sek: null,
    },
    search_domain: {
      energy_levels_kwh: levels,
      pv_curtailment_fractions: fractions,
      includes_minimum_export_limit_curtailment: true,
      retained_per_level: search.retained_per_level,
    },
    alternatives: compiled,
    omitted: outcomes.filter((a) => a.status !== "solved"),
    ranking: ranked.map((a) => a.id),
    work,
  };
}

/** Pure synchronous compilation. Invalid requests fail closed before publication. */
export function compileBatteryPolicy(
  input: unknown,
  scope: BatterySearchScope = { kind: "physical" },
) {
  try {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input);
    } catch {
      throw new Rejection("invalid_input", "Input must be JSON data");
    }
    if (encoded === undefined) {
      throw new Rejection("invalid_input", "Input must be JSON data");
    }
    if (
      new TextEncoder().encode(encoded).length >
        BATTERY_POLICY_LIMITS.output_bytes
    ) {
      throw new Rejection("work_limit_exceeded", "Input exceeds 2 MB limit");
    }
    const result = compile(input, scope);
    if (
      new TextEncoder().encode(JSON.stringify(result)).length >
        BATTERY_POLICY_LIMITS.output_bytes
    ) {
      throw new Rejection(
        "work_limit_exceeded",
        "Compiled output exceeds byte limit",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof Rejection) {
      return {
        status: "rejected" as const,
        reason: error.reason,
        detail: error.message,
      };
    }
    if (
      error instanceof z.ZodError ||
      (error instanceof Error &&
        error.message.startsWith("Invalid household problem:"))
    ) {
      return {
        status: "rejected" as const,
        reason: "invalid_input" as const,
        detail: error.message,
      };
    }
    throw error; // A compiler/scorer disagreement is a defect, never infeasibility.
  }
}

export type BatteryPolicyResult = ReturnType<typeof compileBatteryPolicy>;
/** Offline applicability check, not an untrusted-wire reader or actuator API. */
export function selectBatteryPolicy(
  result: BatteryPolicyResult,
  problem: unknown,
) {
  if (result.status !== "compiled") return { status: "unavailable" as const };
  try {
    if (
      JSON.stringify(parseHouseholdProblem(problem)) !==
        JSON.stringify(result.coverage.problem)
    ) return { status: "outside_coverage" as const };
  } catch {
    return { status: "outside_coverage" as const };
  }
  return {
    status: "selected" as const,
    alternative_id: result.ranking[0],
    reference_id: result.reference_id,
  };
}
