import type {
  ConnectedProcessBelief,
  ConnectedRoomResponse,
  ExchangePosterior,
} from "./connected-exchange.ts";
/** Frozen evidence for every observed node, including rooms without heaters. */
export interface ConnectedRoomPlanningNode {
  key: string;
  model: ConnectedRoomResponse;
  posterior: ExchangePosterior;
  process_belief: ConnectedProcessBelief;
  initial_state: "identified_joint" | "bounded_thermal";
  start_temperature_c: number;
  start_stored_heat_c: number;
}
/** Exact zero needs no peer unless an identified reset prior can activate it. */
export function connectedRoomDependencies(
  node: ConnectedRoomPlanningNode,
): string[] {
  return [
    ...new Set([
      ...node.process_belief.hypotheses.flatMap((h) => h.incoming)
        .filter((edge) => edge.kind !== "constant" || edge.per_h > 0).map(
          (edge) => edge.from,
        ),
      ...(node.process_belief.reset_priors ?? []).map((prior) => prior.from),
    ]),
  ];
}
export interface ConnectedRoomForecastIdentity {
  revision: "joint_regime_replicas_philox_v3";
  accuracy_revision: "connected_integration_accuracy_v2";
  seed: [number, number];
  replicates: 4;
  wasm_sha256: string;
  runtime: string;
  trajectories?: number;
  replayed_paths?: number;
  replicate_trajectories?: number[];
}
export interface ConnectedRoomPlanningNetwork {
  nodes: ConnectedRoomPlanningNode[];
  forecast: ConnectedRoomForecastIdentity;
}

/** Server-owned durable capture work; current observations stay out of forecast caches. */
export interface ConnectedRoomPendingCapture {
  rooms: import("./planning.ts").PreparedRoom[];
  observations: [string, import("./state.ts").RoomStateReading][];
}
