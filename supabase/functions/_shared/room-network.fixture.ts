import { connectedRoomForecastIdentity } from "./room-network-contract.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { ConnectedRoomResponse } from "./planner/models/room/connected-exchange.ts";

/** Independently generated synthetic rooms; no household observations. */
export function connectedRoomSnapshot(
  activePeer = false,
  rate = .5,
): OptimisationSnapshot {
  const s: OptimisationSnapshot = dispatchedEvSnapshot();
  s.schema_version = 12;
  s.slots = s.slots.slice(0, 16);
  s.captured_at = s.slots[0].start;
  const n = s.slots.length,
    values = (v: number) => Array(n).fill(v),
    start = Date.parse(s.captured_at);
  s.outdoor_temperature_c = values(5);
  s.house_temperature_c = values(20);
  s.solar_irradiance_w_per_m2 = values(0);
  s.device_models = [];
  s.thermal_zones = [];
  s.room_network = { nodes: [], forecast: connectedRoomForecastIdentity() };
  for (
    const [key, temperature, target, heated] of [
      ["synthetic-a", 19, 21, true],
      ["synthetic-b", activePeer ? 15 : 27, 25, activePeer],
    ] as const
  ) {
    const peer = key === "synthetic-a" ? "synthetic-b" : "synthetic-a";
    const thermal = {
      outdoor_per_h: .03,
      heater: heated
        ? {
          gain_c_per_wh: .002,
          lag_h: 0,
          gain_reference_outdoor_c: 5,
          gain_outdoor_slope_per_c: 0,
        }
        : null,
      solar_per_wm2_h: 0,
      background_per_h: 0,
    };
    const posterior = {
      through_ms: start,
      temperature_c: temperature,
      stored_heat_c: 0,
      log_rates: [Math.log(key === "synthetic-a" ? rate : .1)],
      covariance: [[.01, 0, 0], [0, 0, 0], [0, 0, .02]],
      observations: 1000,
    };
    const model: ConnectedRoomResponse = {
      family: "adaptive_connected_native_v1",
      thermal,
      incoming: [{
        kind: "log_ou",
        from: peer,
        mean_log_per_h: Math.log(key === "synthetic-a" ? rate : .1),
        reversion_per_h: .02,
        stationary_variance: .02,
      }],
      observation_noise_c2_h: .001,
      thermal_noise_c2_per_h: .001,
      reference_state: posterior,
      basis: {
        graph_owner: null,
        graph_revision: null,
        topology_hash: "synthetic",
        source_policy: "synthetic",
        source_revision: 1,
        history_from: new Date(start - 86400000).toISOString(),
        history_to: s.captured_at,
      },
      evidence: { heater_identified: heated },
    };
    s.room_network.nodes.push({
      key,
      model,
      posterior,
      process_belief: {
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
          thermal_state_identified: true,
        }],
      },
      initial_state: "identified_joint",
      start_temperature_c: temperature,
      start_stored_heat_c: 0,
    });
    if (!heated) continue;
    const device = key + "-heater";
    s.device_models.push({
      key: device,
      name: key,
      statistic_id: device,
      category: "heating",
      suggested_load_type: "duty_cycle",
      load_type: "duty_cycle",
      planning_role: "controllable",
      control_type: "setpoint",
      thermostat: {
        entity_id: device,
        minimum_c: 5,
        maximum_c: 35,
        step_c: .5,
        current_temperature_c: temperature,
        target_temperature_c: target,
        hvac_action: "idle",
      },
      active_power_w: 2000,
      profile_sample_count: 1000,
      forecast_w_by_slot: values(500),
    });
    s.thermal_zones.push({
      key,
      name: key,
      device_keys: [device],
      model: {
        gain_c_per_wh: .002,
        cooling_constant_per_h: .03,
        background_gain_c_per_h: 0,
        thermal_capacity_wh_per_c: 500,
        heat_loss_w_per_c: 15,
        time_constant_h: 1 / .03,
        heating_rate_c_per_h: 4,
        r2: .99,
        sample_count: 1000,
        residual_std_c: .1,
      },
      start_temperature_c: temperature,
      start_stored_heat_c: 0,
      rated_power_w: 2000,
      comfort_min_c: values(target),
      target_c: values(target),
      comfort_max_c: values(target + .5),
      maximum_power_w_by_slot: values(2000),
      unplanned_power_w: values(500),
    });
  }
  return s;
}
