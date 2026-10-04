# Proposed state-value interfaces

This is a caller-first design sketch with pseudocode bodies, not an executable production module. The offline implementation is in `bench/experiments/`.

```ts
// Architecture sketch: interfaces only, not a drop-in product implementation.
// Usage first. Three callers share one operation; none coordinate search internals.
import { prepareReplanStart, type ReplanProblem, type SelectedEstimates } from '../../../bench/experiments/replan-seed.ts';

function worker(input: CapturedPlanningInput, saved: SearchCheckpoint | undefined, previous: SelectedEstimates | null, budget: WorkBudget) {
  const problem = resolveHouseholdProblem(input);
  const request: SearchRequest = saved ? { kind: 'resume', checkpoint: saved } : { kind: 'new', previous };
  const step = solveHouseholdStep(problem, request, budget);
  if (step.done === false) return encodeContinuation(step.checkpoint);
  return assemblePlan(input, step.selected);
}

function offlineComparison(input: CapturedPlanningInput, rounds: 8 | 10) {
  const problem = resolveHouseholdProblem(input);
  let checkpoint: SearchCheckpoint | undefined;
  for (;;) {
    const request: SearchRequest = checkpoint ? { kind: 'resume', checkpoint } : { kind: 'new', previous: null };
    const step = solveHouseholdStep(problem, request, { rounds, pause: () => false });
    if (step.done === true) return step.selected;
    checkpoint = step.checkpoint;
  }
}

function bench(selected: SelectedSolve) {
  return selected.evidence.slices.map(slice => ({
    store: slice.store, unit: slice.unit, slot: slice.slot, points: slice.points,
    selectedRound: selected.round, meaning: slice.meaning,
  }));
}

type StoreKey = 'battery' | 'ev' | 'pool';
type Unit = 'kwh' | 'km' | 'celsius';
type ProblemId = string & { readonly problemId: unique symbol };

type States = {
  battery: { usableKwh: number };
  ev: { rangeKm: number };
  pool: { celsius: number; compressor: 'off' | 'starting' | 'running'; elapsedSeconds: number };
};
type Commands = {
  battery: { operation: 'off' | 'charge' | 'discharge' | 'follow_house' | 'follow_solar'; watts: number };
  ev: { currentAmps: number };
  pool: { enabled: boolean; setting: number };
};
type HouseholdState = { [K in StoreKey]: States[K] };
type HouseholdCommand = { [K in StoreKey]: Commands[K] };

type ModelRegistry = { [K in StoreKey]: DeviceModel<K> };
interface DeviceModel<K extends StoreKey> {
  readonly key: K;
  readonly unit: Unit;
  // Device model owns lattice/native-memory approximation and admissible commands.
  nodes(slot: number): readonly States[K][];
  commands(state: States[K], slot: number): readonly Commands[K][];
  transition(state: States[K], command: Commands[K], slot: number): {
    next: States[K]; netElectricalKwh: number; wearSek: number; nativeStartSek: number;
  };
  interpolate(values: Float64Array, state: States[K], slot: number): number;
}

interface FixedObjective {
  readonly policyVersion: string;
  // Pool rate integrated over duration; EV event reward, not repeated each quarter.
  serviceSek(state: HouseholdState, slot: number): number;
  // Beyond horizon only. Does not contain the in-horizon Bellman result.
  continuationSek(finalState: HouseholdState): number;
  score(schedule: PhysicalSchedule): ObjectiveBreakdown;
}
interface HouseholdPhysics {
  // Owns existing grid/equipment/permissions accounting. No duplicated simulator.
  apply(state: HouseholdState, command: HouseholdCommand, slot: number):
    | { allowed: true; next: HouseholdState; netGridKwh: number }
    | { allowed: false; equipmentReason: string };
  validate(schedule: PhysicalSchedule): ValidatedSchedule;
}
interface HouseholdProblem {
  readonly id: ProblemId;
  readonly models: ModelRegistry;
  readonly objective: FixedObjective;
  readonly physics: HouseholdPhysics;
  readonly slots: readonly ResolvedSlot[];
  readonly initial: HouseholdState;
  readonly seedProblem: ReplanProblem;
}
interface StateValueSlice {
  store: StoreKey; slot: number; unit: Unit;
  // Signed and possibly nonconcave; separate from preference UtilityCurve.
  points: readonly { at: number; estimatedSekPerUnit: number }[];
  nativeMemory: States['pool'] | null;
  meaning: 'conditional_cost_to_go_under_selected_prices';
}
interface SelectedSolve {
  readonly problem: ProblemId;
  readonly round: number;
  readonly schedule: ValidatedSchedule;
  readonly objective: ObjectiveBreakdown;
  // Atomically retained with the schedule, including when an earlier round wins.
  // SelectedEstimates is serialized from THESE prices/tables and problem seed
  // metadata; do not store a second independently mutable copy.
  readonly evidence: {
    prices: readonly number[];
    tables: Readonly<Record<StoreKey, readonly Float64Array[]>>;
    slices: readonly StateValueSlice[];
    transitions: number; jointActions: number;
  };
}
interface WorkBudget { rounds: 8 | 10; pause(): boolean }
interface SearchCheckpoint {
  problem: ProblemId;
  round: number;
  cursor: { phase: 'bellman'; store: StoreKey; slot: number; node: number }
        | { phase: 'rollout'; slot: number; beam: number; action: number }
        | { phase: 'coordination' };
  tables: Record<StoreKey, Float64Array[]>;
  prices: number[];
  beam: BeamTrajectory[];
  selected: SelectedSolve | null;
  transitions: number;
  jointActions: number;
}
type SearchStep =
  | { done: false; checkpoint: SearchCheckpoint }
  | { done: true; selected: SelectedSolve; stopped: 'converged' | 'round_limit' | 'work_limit' };

type SearchRequest = { kind: 'new'; previous: SelectedEstimates | null } | { kind: 'resume'; checkpoint: SearchCheckpoint };

function solveHouseholdStep(problem: HouseholdProblem, request: SearchRequest, budget: WorkBudget): SearchStep {
  if (request.kind === 'new') {
    const seed = prepareReplanStart(problem.seedProblem, request.previous);
    // Initialize numeric tables/prices from this seed. Current terminal utility,
    // measurements, native memory and physical permissions remain in problem.
    void seed;
  }
  /*
  For resume: validate checkpoint identity (never seed a new problem with it).
  For new: use aligned selected-solve estimates; restart resource prices on
    changed economics/models/limits. Do not copy commands, states or rewards.
  Validate saved problem identity; rebuild callbacks from immutable input.
  For each round (initial counts, all devices updated):
    For each device and t backwards:
      W[T,state] = fixed beyond-horizon utility.
      W[t,state] = max over executable commands of
        fixed service contribution - price[t]*signed consumption
        - wear - native start + interpolated W[t+1,next physical state].
      Resume at cell/action cursor; work counters include every evaluated transition.
    Joint rollout:
      For each beam trajectory, propose combinations guided by device W tables.
      Evaluate commands through existing household physical accounting.
      Keep bounded successors using exact stage score + estimated future value.
      Native memory and previous grid import travel with each independent trajectory.
    Rescore complete trajectories with fixed common objective; validate physical schedule.
    Atomically retain selected trajectory, score, tables and prices if better.
    Update shared prices from aggregate proposals and feasible household allocation.
    Stop if stable, round/work limit, or pause at an exact cursor.
  No complete candidate at final work limit => explicit search failure.
  No old-planner fallback, no publishing partial plans, no inferred infeasibility.
  */
  throw new Error('not implemented');
}

// Owned modules:
// planner/household-objective.ts: immutable utility/continuation and exact accounting.
// planner/predictive-dispatch.ts: deep shared search operation and numeric cursors.
// existing device models + dispatch physical accounting: transitions and common constraints.
// energy-optimisation.ts: resolve problem, assemble scenarios and authoritative contracts.
// energy-planning-step.ts: transport, CPU/time budget, continuation encoding.
// bench adapter/chart: read selected evidence; no economics or optimizer policy.

// Integration types are deliberately sketches; resolve from existing domain owners.
interface CapturedPlanningInput { readonly snapshot: unknown }
interface ResolvedSlot { readonly start: string; readonly durationHours: number }
interface PhysicalSchedule { readonly commands: readonly HouseholdCommand[] }
interface ValidatedSchedule extends PhysicalSchedule { readonly validated: true }
interface ObjectiveBreakdown { readonly totalSek: number; readonly components: Readonly<Record<string, number>> }
interface BeamTrajectory { readonly states: readonly HouseholdState[]; readonly commands: readonly HouseholdCommand[]; readonly accumulatedSek: number; readonly previousImportKw: number }
function resolveHouseholdProblem(_input: CapturedPlanningInput): HouseholdProblem { throw new Error('not implemented'); }
function assemblePlan(_input: CapturedPlanningInput, _selected: SelectedSolve): unknown { throw new Error('not implemented'); }
function encodeContinuation(_checkpoint: SearchCheckpoint): unknown { throw new Error('not implemented'); }
```
