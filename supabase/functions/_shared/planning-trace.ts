type Details = Record<string, string | number | boolean | null>;

/** Emit request-local breadcrumbs before work that the runtime might terminate.
 * Timings are elapsed wall time, not Supabase's CPU accounting. Never log inputs.
 */
export class PlanningTrace {
  private readonly started = performance.now();
  private sequence = 0;
  private active: { stage: string; started: number }[] = [];

  constructor(private readonly requestId: string, private readonly log: (message: string) => void = console.info) {}

  private emit(stage: string, phase: "start" | "complete" | "failed", details: Details) {
    this.log(JSON.stringify({ event: "energy_planning_stage", request_id: this.requestId,
      sequence: ++this.sequence, stage, phase, elapsed_ms: Math.round(performance.now() - this.started), ...details }));
  }

  start(stage: string, details: Details = {}): (completedDetails?: Details) => void {
    const entry = { stage, started: performance.now() };
    this.active.push(entry);
    this.emit(stage, "start", details);
    return (completedDetails = {}) => {
      this.emit(stage, "complete", { ...details, ...completedDetails, duration_ms: Math.round(performance.now() - entry.started) });
      this.active.pop();
    };
  }

  run<T>(stage: string, work: () => T, details: Details = {}): T {
    const complete = this.start(stage, details);
    const result = work();
    complete();
    return result;
  }

  failed(detail: string) {
    const entry = this.active.at(-1);
    this.emit(entry?.stage ?? "request", "failed", { detail });
  }
}

export function planningStage<T>(trace: PlanningTrace | undefined, stage: string, work: () => T, details?: Details): T {
  return trace ? trace.run(stage, work, details) : work();
}
