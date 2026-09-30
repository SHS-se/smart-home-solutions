/** Explicit user minimum runtime, measured in physical seconds, not slot counts. */
export interface MinimumRun {
  minimum_seconds: number;
  remaining_seconds: number;
  running: boolean;
}

export function validMinimumRun(value: MinimumRun): boolean {
  return value !== null && typeof value === "object" &&
    typeof value.running === "boolean" &&
    [value.minimum_seconds, value.remaining_seconds].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0) &&
    (value.running || value.remaining_seconds === 0);
}

export function requiredRunSlots(run: MinimumRun | undefined, hours: number[]): number {
  let remaining = run?.remaining_seconds ?? 0;
  let end = 0;
  while (remaining > 1e-6 && end < hours.length) remaining -= hours[end++] * 3600;
  return end;
}

/** Every stop and voluntary horizon-end start must satisfy its commitment. */
export function validRun(power: number[], hours: number[], run?: MinimumRun, continuesBeyondHorizon = false): boolean {
  if (!run) return true;
  let remaining = run.remaining_seconds;
  let on = run.running;
  for (let i = 0; i < power.length; i++) {
    const nextOn = power[i] > 0;
    if (!nextOn && remaining > 1e-6) return false;
    if (nextOn && !on) remaining = run.minimum_seconds;
    remaining = Math.max(0, remaining - hours[i] * 3600);
    on = nextOn;
  }
  // An already-started run may outlive the visible horizon. A new planned
  // start must have its full cost and consumption represented in this plan.
  return continuesBeyondHorizon || remaining <= 1e-6 || (run.remaining_seconds > hours.reduce((a,b) => a+b, 0) * 3600);
}

export function continuedRun(run: MinimumRun | undefined, power: number[], hours: number[]): MinimumRun | undefined {
  if (!run) return undefined;
  let remaining = run.remaining_seconds;
  let on = run.running;
  for (let i = 0; i < power.length; i++) {
    const nextOn = power[i] > 0;
    if (nextOn && !on) remaining = run.minimum_seconds;
    remaining = Math.max(0, remaining - hours[i] * 3600);
    on = nextOn;
  }
  return { ...run, running: on, remaining_seconds: remaining };
}
