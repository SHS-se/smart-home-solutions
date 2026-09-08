/** Convert room optimisation into full-quarter relay decisions before simulation.
 * A bounded beam search checks both comfort bounds on every transition. No HA
 * client may reconstruct these decisions from fractional energy allocations.
 */
import type {
  OptimisationSnapshot,
  ThermalZonePlanningInput,
} from "./energy-optimisation.ts";
import {
  backgroundRateForSlot,
  projectZoneTemperature,
} from "./thermal-model.ts";

export function discreteRoomPlan(
  snapshot: OptimisationSnapshot,
  zone: ThermalZonePlanningInput,
  preferred: number[],
) {
  const models = zone.device_keys.map((key) =>
    snapshot.device_models.find((m) => m.key === key)!
  );
  const relays = models.filter((m) => m.control_type === "switch_schedule");
  if (!relays.length) return null;
  if (relays.length > 8 || models.some((m) => !(m.active_power_w! > 0))) {
    throw new Error(
      `${zone.name}: relay planning requires measured ratings and at most eight relays per room`,
    );
  }
  const continuous = models.filter((m) => m.control_type === "setpoint");
  const continuousMax = continuous.reduce(
    (sum, m) => sum + m.active_power_w!,
    0,
  );
  const outdoor = snapshot.outdoor_temperature_c as number[];
  const desired = projectZoneTemperature(zone.model, zone.start_temperature_c, [
    ...outdoor,
    outdoor.at(-1)!,
  ], preferred);
  type Node = {
    temperature: number;
    cost: number;
    powers: number[];
    devicePower: Record<string, number[]>;
  };
  let beam: Node[] = [{
    temperature: zone.start_temperature_c,
    cost: 0,
    powers: [],
    devicePower: Object.fromEntries(models.map((m) => [m.key, []])),
  }];
  for (let i = 0; i < outdoor.length; i++) {
    const next = new Map<number, Node>();
    const at = Math.min(i + 1, zone.comfort_min_c.length - 1);
    for (const prior of beam) {
      for (let mask = 0; mask < (1 << relays.length); mask++) {
        const relayW = relays.reduce(
          (sum, m, bit) => sum + ((mask & (1 << bit)) ? m.active_power_w! : 0),
          0,
        );
        const continuousW = Math.min(
          continuousMax,
          Math.max(0, preferred[i] - relayW),
        );
        const watts = relayW + continuousW;
        if (watts > zone.maximum_power_w_by_slot[i] + 0.01) {
          continue;
        }
        const temperature = prior.temperature +
          0.25 * (zone.model.gain_c_per_wh * watts +
              zone.model.cooling_constant_per_h *
                (outdoor[i] - prior.temperature) +
              backgroundRateForSlot(zone.model, i));
        if (
          temperature < zone.comfort_min_c[at] - 0.01 ||
          temperature > zone.comfort_max_c[at] + 0.01
        ) {
          continue;
        }
        const cost = prior.cost + (temperature - desired[i + 1]) ** 2 +
          ((watts - preferred[i]) / 1000) ** 2 * 0.01;
        const bucket = Math.round(temperature * 100);
        if ((next.get(bucket)?.cost ?? Infinity) <= cost) continue;
        const devicePower = Object.fromEntries(
          models.map(
            (m) => [m.key, [
              ...prior.devicePower[m.key],
              m.control_type === "switch_schedule"
                ? ((mask & (1 << relays.indexOf(m))) ? m.active_power_w! : 0)
                : continuousMax > 0
                ? continuousW * m.active_power_w! / continuousMax
                : 0,
            ]],
          ),
        );
        next.set(bucket, {
          temperature,
          cost,
          powers: [...prior.powers, watts],
          devicePower,
        });
      }
    }
    if (!next.size) {
      throw new Error(
        `${zone.name}: no feasible full-quarter relay schedule within the comfort and power bounds`,
      );
    }
    // Preserve different thermal states so an early low-cost branch cannot
    // remove every alternative needed to meet a later comfort deadline.
    beam = [...next.values()].sort((a, b) => a.cost - b.cost).slice(0, 64);
  }
  return beam.sort((a, b) => a.cost - b.cost)[0];
}
