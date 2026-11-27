import { roomHeatingDirectionKnown } from "./planner/models/room/observation.ts";
import { connectedRoomBoundary, type ConnectedBoundaryRoom } from "./planner/models/room/connected-state.ts";
import {
  type ConnectedFilterDiagnostics,
  type ConnectedRoomObservation,
  type ConnectedRoomResponse,
  type ExchangePosterior,
  filterConnectedRoomExchange,
  forecastConnectedExchange,
} from "./planner/models/room/connected-exchange.ts";
import {
  estimateRoomState,
  roomPlanClock,
  type RoomStateReading,
} from "./planner/models/room/state.ts";
import type { DynamicThermalZoneModel } from "./planner/models/room/thermal.ts";
import {
  type ConnectedRoomPlanningNode,
} from "./planner/models/room/network.ts";
import type { PreparedRoom } from "./prepared-energy-forecasts.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { planningWarning } from "./planner/planning-warnings.ts";

export interface ConnectedRoomFilterCapture {
  room: PreparedRoom;
  model: ConnectedRoomResponse;
  rows: ConnectedRoomObservation[];
  filtered?: {
    posterior: ExchangePosterior;
    diagnostics: ConnectedFilterDiagnostics;
  };
}

/** One staged node can supply its already-filtered posterior; source reads and
 * inference are separate bounded work units. No dependency is removed here. */
export function assembleConnectedRoomNodes(
  snapshot: OptimisationSnapshot,
  captures: readonly ConnectedRoomFilterCapture[],
  observations: ReadonlyMap<string, RoomStateReading>,
  boundaryRooms: readonly ConnectedBoundaryRoom[] = captures.map(c => ({ key: c.room.key, model: c.room.connected_exchange ?? c.model })),
) {
  const warnings: ReturnType<typeof planningWarning>[] = [],
    nodes: ConnectedRoomPlanningNode[] = [];
  const clock = roomPlanClock(snapshot);
  for (const { room, model, rows, filtered } of captures) {
    try {
      const { posterior, diagnostics } = filtered ??
        filterConnectedRoomExchange(model, rows, clock.start_ms);
      let temperature = posterior.temperature_c, heat = posterior.stored_heat_c;
      if (!diagnostics.thermal_state_identified) {
        const measured = rows.findLast((row) =>
          row.room_c !== null && Number.isFinite(row.room_c)
        );
        const native = measured
          ? {
            start_ms: measured.start_ms,
            end_ms: measured.start_ms + (measured.duration_s ?? 900) * 1000,
            mean_c: measured.room_c!,
          }
          : undefined;
        const captured = observations.get(room.key);
        const accepted = room.connected_exchange?.reference_state;
        const anchor = model.reference_state.observations > 0
          ? model.reference_state
          : accepted && accepted.observations > 0
          ? accepted
          : undefined;
        if (!native && !captured && !anchor) {
          throw new Error(
            "No observed room temperature supports the thermal initial state",
          );
        }
        const reading = captured && (!native || captured.end_ms > native.end_ms)
          ? captured
          : native ?? captured ??
            {
              start_ms: anchor!.through_ms,
              end_ms: anchor!.through_ms,
              mean_c: anchor!.temperature_c,
            };
        const rates = forecastConnectedExchange(model, posterior, 0),
          exchange = rates.reduce((a, b) => a + b, 0),
          t = model.thermal,
          h = t.heater;
        const nowcast = snapshot.outdoor_temperature_c?.[0];
        const outdoor = typeof nowcast === "number" && Number.isFinite(nowcast) ? nowcast :
          rows.findLast(row => row.outdoor_c !== null && Number.isFinite(row.outdoor_c))?.outdoor_c ?? reading.mean_c;
        const boundary = connectedRoomBoundary(room.key, boundaryRooms, observations, rows, outdoor, rates);
        const scalar: DynamicThermalZoneModel = {
          response_family: "finite",
          gain_c_per_wh: h?.gain_c_per_wh ?? 0,
          cooling_constant_per_h: t.outdoor_per_h,
          house_coupling_per_h: exchange,
          background_gain_c_per_h: Math.min(0, t.background_per_h),
          solar_gain_c_per_h_per_wm2: t.solar_per_wm2_h,
          heat_lag_h: h?.lag_h ?? 0,
          gain_reference_outdoor_c: h?.gain_reference_outdoor_c,
          gain_outdoor_slope_per_c: h?.gain_outdoor_slope_per_c,
          thermal_capacity_wh_per_c: null,
          heat_loss_w_per_c: null,
          time_constant_h: null,
          heating_rate_c_per_h: null,
          r2: 0,
          sample_count: 0,
          residual_std_c: 0,
        };
        const estimate = estimateRoomState(scalar, {
          reading,
          intervals: rows.map((row) => ({
            start_ms: row.start_ms,
            end_ms: row.start_ms + (row.duration_s ?? 900) * 1000,
            heater_w: h
              ? (roomHeatingDirectionKnown(row) ? row.heat_w : null)
              : 0,
            outdoor_c: row.outdoor_c,
            solar_w_per_m2: row.solar_w_per_m2,
            house_c: exchange > 0 && model.incoming.every(edge =>
              typeof row.peer_c?.[edge.from] === "number" && Number.isFinite(row.peer_c[edge.from]))
              ? model.incoming.reduce(
                (sum, edge, i) =>
                  sum + rates[i] * row.peer_c![edge.from]!,
                0,
              ) / exchange
              : null,
          })),
          fallback: {
            outdoor_c: outdoor,
            house_c: boundary,
            solar_w_per_m2: 0,
          },
        }, clock.start_ms);
        temperature = estimate.temperature_c;
        heat = estimate.stored_heat_c;
        const latest = Math.floor(clock.start_ms / 900000) * 900000;
        const spans = [
          ...estimate.missing_power,
          ...estimate.estimated_boundary,
        ].filter((span) => span.end_ms > reading.start_ms);
        if (spans.length) {
          warnings.push(planningWarning(
            spans.some((span) => span.start_ms < latest - 2 * 900000)
              ? "room_state_boundary_estimate"
              : "room_state_boundary_late",
            room.key,
            `${room.name}: current room exchange and thermal state use available observations.`,
            "Received heater energy is retained; unknown heater and neighbour warmth receive no assumed credit.",
          ));
        }
      }
      if (![temperature, heat].every(Number.isFinite)) {
        throw new Error("No finite room state can be estimated");
      }
      if (
        !model.process_belief &&
        model.incoming.some((edge) =>
          edge.kind !== "constant" || edge.per_h > 0
        )
      ) throw new Error("No supported process belief for joint forecasting");
      nodes.push({
        key: room.key,
        model: { ...model, process_belief: undefined },
        posterior,
        process_belief: model.process_belief ?? {
          revision: "connected_process_regimes_v2",
          initial_incoming: model.incoming,
          initial_hazard: { shape: .5, rate_h: .25 },
          reset_priors: [],
          replicas: [{ rng_state: 0, particles: 1, log_evidence: 0 }],
          hypotheses: [{
            replica: 0,
            multiplicity: 1,
            hazards: model.incoming.map(() => ({ shape: 1, rate_h: 1 })),
            log_weight: 0,
            incoming: model.incoming,
            posterior,
            thermal_state_identified: diagnostics.thermal_state_identified,
          }],
        },
        initial_state: diagnostics.thermal_state_identified
          ? "identified_joint"
          : "bounded_thermal",
        start_temperature_c: temperature,
        start_stored_heat_c: heat,
      });
    } catch (error) {
      warnings.push(
        planningWarning(
          "room_evidence_unavailable",
          room.key,
          `${room.name}: the connected thermal state could not be reconstructed.`,
          "Comfort instructions and measured electrical demand remain active.",
          { reason: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }
  return { nodes, warnings };
}

/** Resolve named model dependencies only after all staged nodes are assembled. */
export function finalizeConnectedRoomNodes<T extends {key: string}>(nodes: T[], dependencies: (node: T) => string[]) {
  const warnings: ReturnType<typeof planningWarning>[] = [];
  // Missing model identity is distinct from missing observations. A receiving
  // equation cannot be evaluated with a fabricated peer response.
  let usable = nodes;
  for (;;) {
    const keys = new Set(usable.map((node) => node.key));
    const next = usable.filter((node) => {
      const missing = dependencies(node).filter((from) =>
        !keys.has(from)
      );
      if (missing.length) {
        warnings.push(
          planningWarning(
            "room_evidence_unavailable",
            node.key,
            "A connected room has no supported thermal response or bounded initial state.",
            "The affected room keeps comfort instructions and measured electrical demand.",
            { peers: missing.join(", ") },
          ),
        );
      }
      return missing.length === 0;
    });
    if (next.length === usable.length) break;
    usable = next;
  }
  return { nodes: usable, warnings };
}
