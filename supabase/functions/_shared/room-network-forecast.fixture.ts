/** Independent synthetic coupled rooms: no household observations or identifiers. */
import type { NativeRoomNetworkAdvanceInput } from "./room-network-contract.ts";
import type { ConnectedRoomResponse } from "./planner/models/room/connected-exchange.ts";
export function syntheticJointRoomForecast(
  tau = 2,
  variance = .65,
  hours = 24,
  thermalNoise = 0,
): NativeRoomNetworkAdvanceInput {
  const slots = hours * 4,
    initial = [19, 24],
    targets = [21, 24],
    loss = [.04, .055],
    gain = [.001, .0012],
    power = [1500, 1500];
  const identity = {
    decay: 1,
    offset_c: 0,
    stored_heat_release: 0,
    gain_c_per_w: 0,
    stored_heat_gain_c_per_w: 0,
    carry: 1,
  };
  const models: ConnectedRoomResponse[] = initial.map((temperature, i) => {
    const level = Math.log(.2 * (i ? .7 : 1));
    return {
      family: "adaptive_connected_native_v1",
      thermal: {
        outdoor_per_h: loss[i],
        heater: {
          gain_c_per_wh: gain[i],
          lag_h: i ? 0 : 1,
          gain_reference_outdoor_c: 5,
          gain_outdoor_slope_per_c: 0,
        },
        solar_per_wm2_h: 0,
        background_per_h: 0,
      },
      incoming: [{
        kind: "log_ou",
        from: String(1 - i),
        mean_log_per_h: level,
        reversion_per_h: 1 / tau,
        stationary_variance: variance,
      }],
      observation_noise_c2_h: 0,
      thermal_noise_c2_per_h: thermalNoise,
      reference_state: {
        through_ms: 0,
        temperature_c: temperature,
        stored_heat_c: 0,
        log_rates: [level],
        covariance: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
        observations: 1,
      },
      basis: {
        graph_owner: null,
        graph_revision: null,
        topology_hash: "independent-synthetic",
        source_policy: "independent-synthetic",
        source_revision: 1,
        history_from: new Date(0).toISOString(),
        history_to: new Date(0).toISOString(),
      },
      evidence: { heater_identified: true },
    };
  });
  return {
    identity:
      `independent-synthetic-${tau}-${variance}-${hours}-${thermalNoise}`,
    seed: [0x8dc4a519, 0x6f37e2ab],
    replicate_count: 4,
    target_trajectories: 64,
    max_minute_steps: 4096,
    beliefs: models.map((model) => ({
      bounded_thermal: false,
      thermal_noise_c2_per_h: thermalNoise,
      hypotheses: [{
        log_weight: 0,
        incoming: model.incoming.map((edge) => ({
          ...edge,
          from: Number(edge.from),
        })),
        posterior: model.reference_state,
      }],
    })),
    network: {
      nodes: models.map((_, i) => ({
        key: String(i),
        start_c: initial[i],
        start_stored_heat_c: 0,
        outdoor_per_h: loss[i],
        gain_c_per_wh: Array(slots).fill(gain[i]),
        lag_h: i ? 0 : 1,
        forcing_c_per_h: Array(slots).fill(loss[i] * 5),
        incoming: [{ node: 1 - i, rates: [[0]] }],
      })),
      rooms: models.map((_, i) => ({
        node: i,
        input: {
          start_c: initial[i],
          start_stored_heat_c: 0,
          thermostats: [{
            entity_id: String(i),
            minimum_c: 5,
            maximum_c: 35,
            step_c: .5,
            current_temperature_c: initial[i],
            target_temperature_c: targets[i],
            hvac_action: "idle",
            power_w: power[i],
            sensor_offset_c: 0,
          }],
          quarters: Array.from({ length: slots }, () => ({
            hours: .25,
            steps: 15,
            step: identity,
            transition: identity,
            required_c: targets[i],
            maximum_c: targets[i] + 1,
            maximum_w: 10000,
            relay_w: [],
            fixed_relays: [],
            fixed_targets_c: [targets[i]],
            room_target: {
              preferred_c: targets[i],
              fixed_c: targets[i],
              fixed_switches: [null],
            },
            import_sek_per_kwh: .2,
            export_sek_per_kwh: 0,
            surplus_w: 0,
          })),
        },
      })),
      accepted: models.map((_, i) => ({
        power_w: Array(slots).fill(0),
        thermostat_w: Array.from({ length: slots }, () => [0]),
        targets_c: Array.from({ length: slots }, () => [targets[i]]),
        relays_on: Array.from({ length: slots }, () => []),
        temperature_c: Array(slots).fill(initial[i]),
        shortfall_c: Array(slots).fill(0),
        room_targets_c: Array(slots).fill(targets[i]),
      })),
      stage: 1,
      hours: Array(slots).fill(.25),
      headroom_w: Array(slots).fill(10000),
      import_sek_per_kwh: Array(slots).fill(.2),
      export_sek_per_kwh: Array(slots).fill(0),
      surplus_w: Array(slots).fill(0),
    },
  };
}
