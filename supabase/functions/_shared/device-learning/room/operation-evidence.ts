/** Dated, source-qualified knowledge admits heating/off/fan observations
 * without rewriting an observed mode or claiming the compressor was on. */
export interface RoomOperationFact {
  id: string;
  kind: "heating_off_fan";
  from_at: string;
  to_at: string;
  basis: "customer_assertion" | "source_capability";
}
export interface RoomOperationObservation {
  start_ts: string;
  duration_s?: number;
  cooling: boolean | null;
  operation_fact?: string;
}

/** Facts have already been joined to the current physical source binding by
 * the database owner. Coverage includes the complete native interval. A fan
 * flag can be true under this fact, so it remains a fact rather than being
 * converted to cooling=false. Missing meters stay missing. */
export function qualifyRoomOperationEvidence<T extends RoomOperationObservation>(
  observations: readonly T[], facts: readonly RoomOperationFact[],
): (Omit<T, "operation_fact"> & { operation_fact?: string })[] {
  const windows = facts.map(fact => {
    const from = Date.parse(fact.from_at), to = Date.parse(fact.to_at);
    if (fact.kind !== "heating_off_fan" || !fact.id || !Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
      (fact.basis !== "customer_assertion" && fact.basis !== "source_capability")) {
      throw new Error("Invalid room operation fact");
    }
    return { id: fact.id, from, to };
  }).sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  return observations.map(observation => {
    const { operation_fact: _previous, ...raw } = observation;
    const from = Date.parse(observation.start_ts), seconds = observation.duration_s ?? 900;
    const covering = Number.isFinite(from) && (seconds === 900 || seconds === 3600)
      ? windows.find(fact => from >= fact.from && from + seconds * 1000 <= fact.to) : undefined;
    return { ...raw, ...(covering ? { operation_fact: covering.id } : {}) };
  });
}

/** An observed non-cooling flag or independently qualified dated direction
 * supports heater attribution. Neither asserts that the compressor was on. */
export { roomHeatingDirectionKnown } from "../../planner/models/room/observation.ts";
