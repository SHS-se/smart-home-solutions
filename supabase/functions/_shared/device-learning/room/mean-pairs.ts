import { roomMeanObservation } from "../../planner/models/room/observation.ts";

/** Eliminate boundary temperature between adjacent, possibly mixed-duration means. */
export function roomMeanPair(current: ReturnType<typeof roomMeanObservation>, next: ReturnType<typeof roomMeanObservation>) {
  const alpha = next.E * current.a / current.E;
  return {
    alpha, L: next.E * current.effect - alpha * current.V, nextForcing: next.V,
    memory: next.E * current.B - alpha * current.U + next.U * current.C,
    currentHeat: next.E * (current.effect - current.B) - alpha * (current.V - current.U) + next.U * (1 - current.C),
    nextHeat: next.V - next.U,
  };
}

/** Fast-exchange limit, in temperature rather than temperature-rate coordinates. */
export function roomEquilibriumMeanPair(lag: number, currentHours: number, nextHours: number) {
  const carry = lag ? Math.exp(-currentHours / lag) : 0;
  const fraction = lag ? -lag * Math.expm1(-nextHours / lag) / nextHours : 0;
  return { alpha: 0, L: 0, nextForcing: 1, memory: fraction * carry,
    currentHeat: fraction * (1 - carry), nextHeat: 1 - fraction };
}
