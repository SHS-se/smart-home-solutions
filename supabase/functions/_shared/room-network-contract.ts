import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import type { ConnectedRoomForecastIdentity } from "./planner/models/room/network.ts";
import { PlanningError } from "./planning-errors.ts";
export const ROOM_NETWORK_WORK_REVISION =
  "joint_regime_replicas_philox_v3" as const;

/** Native continuation is executable numerical state, scoped to its frozen input. */
export interface NativeRoomNetworkStatistics {
  trajectories: number;
  replayed_paths: number;
  total: number[];
  replicates: Array<{ trajectories: number; total: number[] }>;
  infeasible: number[];
}
export type NativeRoomNetworkPackedStatistics = Omit<NativeRoomNetworkStatistics,"total"|"replicates"> & {
  total:string;
  replicates:Array<{trajectories:number;total:string}>;
};
export interface NativeRoomNetworkWork {
  [key: string]: unknown;
  revision: typeof ROOM_NETWORK_WORK_REVISION;
  identity: string;
  seed: [number, number];
  replicate_count: number;
  cursor: number;
  slot: number;
  minute: number;
  deterministic: boolean;
  statistics: NativeRoomNetworkPackedStatistics;
}
export interface RoomNetworkWork {
  revision: typeof ROOM_NETWORK_WORK_REVISION;
  cursor: number;
  target_trajectories: number;
  replicas: Array<NativeRoomNetworkReplicaWork | null>;
}

import type { RoomHeatingPlan, RoomQuarter } from "./room-heating-schedule.ts";
import type { RoomThermostat } from "./planner/thermostat.ts";

export interface NativeRoomNetworkInput {
  nodes: Array<
    {
      key: string;
      start_c: number;
      start_stored_heat_c: number;
      outdoor_per_h: number;
      gain_c_per_wh: number[];
      lag_h: number;
      forcing_c_per_h: number[];
      incoming: Array<{ node: number; rates: number[][] }>;
      legacy_steps?: Array<
        {
          step: import("./planner/models/room/thermal.ts").RoomTransition;
          memory_scale?: number | null;
        }
      >;
    }
  >;
  rooms: Array<
    {
      node: number;
      input: {
        start_c: number;
        start_stored_heat_c: number;
        thermostats: readonly RoomThermostat[];
        quarters: RoomQuarter[];
      };
    }
  >;
  stage: number;
  hours: number[];
  headroom_w: number[];
  import_sek_per_kwh: number[];
  export_sek_per_kwh: number[];
  surplus_w: number[];
  accepted?: RoomHeatingPlan[];
}
export interface NativeRoomNetworkProposal {
  plans: RoomHeatingPlan[];
  temperature_c: number[][];
  mean_temperature_c: number[][];
}
export interface NativeRoomNetworkOutput extends NativeRoomNetworkProposal {
  literal: RoomHeatingPlan[];
}

export type NativeExchangeDynamics =
  | { kind: "constant"; from: number; per_h: number }
  | {
    kind: "log_ou";
    from: number;
    mean_log_per_h: number;
    reversion_per_h: number;
    stationary_variance: number;
  };
export interface NativeRoomNetworkBelief {
  hypotheses: Array<
    {
      log_weight: number;
      incoming: NativeExchangeDynamics[];
      posterior:
        import("./planner/models/room/connected-exchange.ts").ExchangePosterior;
      hazards?:
        import("./planner/models/room/connected-exchange.ts").ConnectedExchangeHazard[];
    }
  >;
  thermal_noise_c2_per_h: number;
  bounded_thermal: boolean;
  reset_priors?: Array<
    Omit<
      import("./planner/models/room/connected-exchange.ts").ConnectedExchangeResetPrior,
      "from"
    > & { from: number }
  >;
}
export type NativeRoomNetworkHypothesis = NativeRoomNetworkBelief["hypotheses"][number];
export const ROOM_NETWORK_REPLICA_REVISION = ROOM_NETWORK_WORK_REVISION;
/** Compiled by Rust once per complete node belief; CDF arithmetic stays with
 * the sampler. Catalog offsets/record bytes belong to the pure caller codec. */
export interface NativeRoomNetworkNodeHeader {
  cdf: number[];
  weight_sum: number;
  count: number;
  deterministic: boolean;
  thermal_noise_c2_per_h: number;
  bounded_thermal: boolean;
  reset_priors: NonNullable<NativeRoomNetworkBelief["reset_priors"]>;
}
export type NativeRoomReplica = 0 | 1 | 2 | 3;
export interface NativeRoomNetworkDrawSelection {
  local_draw: number;
  global_draw: number;
  /** Null identifies a disconnected scalar node with no process catalog. */
  hypothesis_indexes: Array<number | null>;
}
/** Deduplicated exact catalog records for a bounded draw lookahead. */
export interface NativeRoomNetworkSelectedHypothesis {
  node: number;
  index: number;
  /** Exact UTF-8 catalog record; Rust owns hypothesis parsing and validation. */
  json: string;
}
export interface NativeRoomNetworkReplicaWork {
  [key: string]: unknown;
  revision: typeof ROOM_NETWORK_REPLICA_REVISION;
  identity: string;
  seed: [number, number];
  replica: NativeRoomReplica;
  cursor: number;
  slot: number;
  minute: number;
  deterministic: boolean;
  statistics: {
    /** Completed local outer draws, after both conditional strata. */
    trajectories: number;
    replayed_paths: number;
    total: string;
    infeasible: number[];
  };
}
export interface NativeRoomNetworkReplicaAdvanceInput {
  network: NativeRoomNetworkInput;
  node_headers: NativeRoomNetworkNodeHeader[];
  seed: [number, number];
  identity: string;
  replica: NativeRoomReplica;
  target_local_draws: number;
  max_work: number;
  work?: NativeRoomNetworkReplicaWork;
  selected_hypotheses: NativeRoomNetworkSelectedHypothesis[];
}
export interface NativeRoomNetworkReplicaAdvanced {
  work: NativeRoomNetworkReplicaWork;
  reached_target: boolean;
  /** A next draw requires catalog records that were not in this bounded slice. */
  needs_global_draw: number | null;
}
export interface NativeRoomNetworkMerged {
  work: NativeRoomNetworkWork;
  statistics: NativeRoomNetworkStatistics;
  assessment: NativeRoomNetworkAdvanced["assessment"];
}
export interface NativeRoomNetworkAdvanceInput {
  network: NativeRoomNetworkInput;
  beliefs: NativeRoomNetworkBelief[];
  seed: [number, number];
  identity: string;
  replicate_count: number;
  target_trajectories: number;
  max_minute_steps: number;
  work?: NativeRoomNetworkWork;
}
export interface NativeRoomNetworkAdvanced {
  work: NativeRoomNetworkWork;
  reached_target: boolean;
  statistics: NativeRoomNetworkStatistics | null;
  assessment: {
    deadline_resolved: boolean;
    unresolved_deadline_prefixes: number;
    proposal_rejection: null | {
      kind: "horizon_shortfall";
      room: number;
      horizon_shortfall_difference_c_h: number;
      twice_standard_error_c_h: number;
    } | {
      kind: "prefix_cost";
      room: number;
      cost_difference: number;
      twice_standard_error: number;
      new_miss: boolean;
      no_improvement: boolean;
    };
  };
}

const CONNECTED_INTEGRATION_REVISION = "connected_integration_accuracy_v3";

/** A completed capture records the native draw count. New captures freeze the policy alone. */
export function connectedForecastTarget(forecast: ConnectedRoomForecastIdentity): number {
  if (forecast.trajectories !== undefined) return forecast.trajectories;
  if (forecast.accuracy_revision !== CONNECTED_INTEGRATION_REVISION) {
    throw new PlanningError("Room forecast policy changed. A fresh capture is required.", "planner_upgraded", 409, "recapture");
  }
  return 64;
}

/** Frozen numerical identity travels with the complete replay input. */
export function connectedRoomForecastIdentity(): ConnectedRoomForecastIdentity {
  const runtime =
    (globalThis as { Deno?: { version?: { v8?: string } } }).Deno?.version
      ?.v8 ?? "browser";
  return {
    revision: ROOM_NETWORK_WORK_REVISION,
    accuracy_revision: CONNECTED_INTEGRATION_REVISION,
    seed: [0x8dc4a519, 0x6f37e2ab],
    replicates: 4,
    wasm_sha256: artifact.wasm_sha256,
    runtime,
  };
}
