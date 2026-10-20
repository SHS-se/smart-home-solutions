import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";
import { backgroundRateForSlot, roomTransition, type RoomState, stepRoom, usesHouse } from "./planner/thermal-model.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { MAX_ROOM_RELAYS, planRoomHeating, type RoomQuarter } from "./room-heating-schedule.ts";

export interface RoomServices {
  commands: Record<string, DeviceCommand[]>;
  power: Record<string, number[]>;
  room_power: Record<string, number[]>;
  temperature: Record<string, Array<number | null>>;
  unplanned_temperature: Record<string,Array<number|null>>;
  warnings: PlanningWarning[];
}

/** Marginal electricity prices before the household solve, per quarter. */
export interface RoomPrices {
  import_sek_per_kwh: number[];
  export_sek_per_kwh: number[];
  /** Forecast solar left after base, boiler and other fixed loads. */
  surplus_w: number[];
}

/** Comfort service is authoritative even when its statistical model is weak. */
export function prepareRoomServices(snapshot: OptimisationSnapshot, retained: Retained = [], sharedHeadroom?: number[], prices?: RoomPrices): RoomServices {
  const result: RoomServices = { commands: {}, power: {}, room_power: {}, temperature: {}, unplanned_temperature: {}, warnings: [] };
  const n = snapshot.slots.length;
  const remaining=sharedHeadroom?.slice() ?? snapshot.slots.map(()=>Infinity);
  const surplus=prices?.surplus_w.map(w=>Math.max(0,w)) ?? snapshot.slots.map(()=>0);
  for (const zone of snapshot.thermal_zones ?? []) {
    const members = snapshot.device_models.filter(m => zone.device_keys.includes(m.key));
    const relays = members.filter(m => m.control_type === "switch_schedule");
    const thermostats = members.filter(m => m.control_type === "setpoint");
    let temperature: number | null = zone.start_temperature_c;
    let unplannedTemperature=temperature;
    const cumulative = new Map<string, number>();
    let comfortMisses = 0;
    result.room_power[zone.key] = [];
    result.temperature[zone.key] = [];
    result.unplanned_temperature[zone.key]=[];
    for (const member of [...relays, ...thermostats]) {
      result.commands[member.key] = [];
      result.power[member.key] = [];
    }
    const outdoorKnown = snapshot.outdoor_temperature_c?.length === n &&
      snapshot.outdoor_temperature_c.every(v => typeof v === "number" && Number.isFinite(v));
    // A room coupled to the house cannot be run forward without it.
    const houseKnown = !zone.model || !usesHouse(zone.model) || (snapshot.house_temperature_c?.length === n &&
      snapshot.house_temperature_c.every(v => typeof v === "number" && Number.isFinite(v)));
    if (relays.length + thermostats.length && relays.length <= MAX_ROOM_RELAYS && zone.model && temperature !== null &&
      outdoorKnown && houseKnown && zone.model.gain_c_per_wh > 0 && zone.model.cooling_constant_per_h >= 0) {
      comfortMisses = scheduleRoom(snapshot, zone, thermostats, relays, retained, remaining, surplus, prices, result);
      if (comfortMisses) result.warnings.push(shortfall(zone, comfortMisses));
      continue;
    }
    let estimated = !zone.model || temperature === null;
    let delivered = zone.start_delivered_w ?? 0, unplannedDelivered = delivered;
    for (let i = 0; i < n; i++) {
      const target = zone.target_c[i], minimum = zone.comfort_min_c[i], maximum = zone.comfort_max_c[i];
      const outdoor = snapshot.outdoor_temperature_c?.[i];
      const model = zone.model;
      const hours = Math.min(.25, Math.max(0, (Date.parse(snapshot.slots[i].start) + 900_000 - Date.parse(snapshot.captured_at)) / 3_600_000));
      const modelled = model && temperature !== null && typeof outdoor === "number" && Number.isFinite(outdoor)
        && houseKnown && model.gain_c_per_wh > 0 && model.cooling_constant_per_h >= 0;
      // Exact constant-input transition, stable at any decay rate.
      const step = modelled ? roomTransition(model, { hours, outdoor_c: outdoor!, house_c: snapshot.house_temperature_c?.[i],
        background_c_per_h: backgroundRateForSlot(model, i, snapshot.solar_irradiance_w_per_m2) }) : null;
      const passive = step ? stepRoom(step, { temperature_c: temperature!, delivered_w: delivered }, 0).temperature_c : null;
      const budget=Math.max(0,Math.min(zone.maximum_power_w_by_slot[i],remaining[i]));
      const preferred = passive !== null && step && step.gain_c_per_w > 0 ? Math.max(0, (target - passive) / step.gain_c_per_w)
        : passive !== null ? (target > passive ? Infinity : 0) : zone.unplanned_power_w[i];
      estimated ||= !modelled;
      const rating = (key: string) => {
        const m = members.find(m => m.key === key)!;
        return m.active_power_w && m.active_power_w > 0 ? m.active_power_w : Math.max(0, ...m.forecast_w_by_slot);
      };
      let total = 0;
      const continuous = thermostats.reduce((sum, m) => sum + rating(m.key), 0);
      for (const m of relays) {
        const watts = rating(m.key), expected = Math.max(0, m.forecast_w_by_slot[i]);
        const debt = (cumulative.get(m.key) ?? 0) + (watts ? expected / watts : 0);
        const remaining = preferred - total;
        const offMiss = Math.max(0, remaining - continuous, -remaining);
        const onMiss = Math.max(0, remaining - watts - continuous, watts - remaining);
        let on = modelled ? onMiss < offMiss : i === 0 && temperature !== null
          ? temperature < target : debt >= 1;
        if (watts > budget-total || budget <= 0) on = false;
        const locked = retained[i]?.device_commands?.[m.key];
        if (locked?.type === "switch_schedule") on = locked.on_seconds > 0;
        cumulative.set(m.key, debt - (on ? 1 : 0));
        const power = retained[i]?.device_loads_w?.[m.key] ?? (on ? watts : 0);
        result.commands[m.key].push({ type: "switch_schedule", on_seconds: on ? 900 : 0 });
        result.power[m.key].push(power);
        total += power;
      }
      const continuousDemand = Math.max(0, Math.min(preferred - total,budget-total));
      for (const m of thermostats) {
        const command = retained[i]?.device_commands?.[m.key];
        result.commands[m.key].push(command?.type === "setpoint" ? command : {
          type: "setpoint", target_c: target, minimum_c: minimum, maximum_c: maximum,
        });
        const watts = modelled ? continuousDemand * (continuous ? rating(m.key) / continuous : 0)
          : Math.min(Math.max(0,m.forecast_w_by_slot[i]), Math.max(0,budget-total));
        const power = retained[i]?.device_loads_w?.[m.key] ?? Math.min(rating(m.key), watts);
        result.power[m.key].push(power);
        total += power;
      }
      if (step && unplannedTemperature !== null) {
        const next: RoomState = stepRoom(step, { temperature_c: unplannedTemperature, delivered_w: unplannedDelivered }, zone.unplanned_power_w[i]);
        unplannedTemperature = next.temperature_c; unplannedDelivered = next.delivered_w;
      } else unplannedTemperature = null;
      result.unplanned_temperature[zone.key].push(unplannedTemperature);
      if (step && temperature !== null) {
        const next = stepRoom(step, { temperature_c: temperature, delivered_w: delivered }, total);
        temperature = next.temperature_c; delivered = next.delivered_w;
      } else temperature = null;
      if (temperature !== null && (temperature < minimum || temperature > maximum)) comfortMisses++;
      remaining[i]=Math.max(0,remaining[i]-total);
      surplus[i]=Math.max(0,surplus[i]-total);
      result.room_power[zone.key].push(total);
      result.temperature[zone.key].push(temperature);
    }
    if (estimated) result.warnings.push(planningWarning("room_estimate", zone.key,
      `${zone.name}: the thermal forecast has incomplete evidence.`,
      "Comfort setpoints and empirical relay schedules remain active; consumption is estimated from measured history."));
    if (comfortMisses) result.warnings.push(shortfall(zone, comfortMisses));
  }
  return result;
}

type Zone = NonNullable<OptimisationSnapshot["thermal_zones"]>[number];
type Member = OptimisationSnapshot["device_models"][number];
type Retained = Array<{ device_commands?: Record<string, DeviceCommand>; device_loads_w?: Record<string, number> }>;

const shortfall = (zone: Zone, quarters: number) => planningWarning("comfort_shortfall", zone.key,
  `${zone.name}: ${quarters} quarters may be outside the requested comfort band.`,
  "The best attainable room schedule is included and household planning continues.", { quarters });

/**
 * A modelled room planned for price and deadline. Each quarter's setpoint is
 * the planned temperature at its end: a thermostat cannot take watts, and the
 * planned trajectory already reaches Comfort when the first Comfort quarter
 * begins. Relays run whole quarters as planned, and the thermostats top up
 * whatever they leave. Returns the number of quarters outside the comfort
 * objective.
 */
function scheduleRoom(snapshot: OptimisationSnapshot, zone: Zone, thermostats: Member[], relays: Member[],
  retained: Retained, remaining: number[], surplus: number[],
  prices: RoomPrices | undefined, result: RoomServices): number {
  const model = zone.model!, n = snapshot.slots.length;
  const rating = (m: Member) => m.active_power_w && m.active_power_w > 0 ? m.active_power_w : Math.max(0, ...m.forecast_w_by_slot);
  const continuous = thermostats.reduce((sum, m) => sum + rating(m), 0);
  const quarters: RoomQuarter[] = snapshot.slots.map((slot, i) => {
    const hours = Math.min(.25, Math.max(0, (Date.parse(slot.start) + 900_000 - Date.parse(snapshot.captured_at)) / 3_600_000));
    const step = roomTransition(model, { hours, outdoor_c: snapshot.outdoor_temperature_c![i]!,
      house_c: snapshot.house_temperature_c?.[i], background_c_per_h: backgroundRateForSlot(model, i, snapshot.solar_irradiance_w_per_m2) });
    const loads = thermostats.map(m => retained[i]?.device_loads_w?.[m.key]);
    const locked = relays.map(m => {
      const command = retained[i]?.device_commands?.[m.key];
      return command?.type === "switch_schedule" ? command.on_seconds > 0 : null;
    });
    return { hours, decay: step.decay, offset_c: step.offset_c, gain_c_per_w: step.gain_c_per_w,
      delivered_gain_c_per_w: step.delivered_gain_c_per_w, carry: step.carry,
      // A Comfort quarter is a deadline at its start, so the quarter before it
      // must end at the next objective as well as its own.
      required_c: Math.max(zone.comfort_min_c[i], zone.comfort_min_c[i + 1] ?? zone.comfort_min_c[i]),
      maximum_c: zone.comfort_max_c[i],
      maximum_w: Math.max(0, Math.min(zone.maximum_power_w_by_slot[i], remaining[i])),
      continuous_w: continuous,
      relay_w: relays.map((m, r) => locked[r] ? retained[i]?.device_loads_w?.[m.key] ?? rating(m) : rating(m)),
      // A room of relays alone has no thermostat power to fix.
      fixed_w: thermostats.length > 0 && loads.every(w => typeof w === "number" && Number.isFinite(w))
        ? loads.reduce((a, w) => a! + w!, 0)! : null,
      fixed_relays: locked,
      import_sek_per_kwh: prices?.import_sek_per_kwh[i] ?? 1,
      export_sek_per_kwh: prices?.export_sek_per_kwh[i] ?? 1,
      surplus_w: surplus[i] };
  });
  const plan = planRoomHeating(zone.start_temperature_c!, quarters, zone.start_delivered_w ?? 0);
  let misses = 0;
  let unplanned: RoomState = { temperature_c: zone.start_temperature_c!, delivered_w: zone.start_delivered_w ?? 0 };
  for (let i = 0; i < n; i++) {
    const q = quarters[i], total = plan.power_w[i], next = plan.temperature_c[i];
    const minimum = zone.comfort_min_c[i], maximum = zone.comfort_max_c[i];
    let relayW = 0;
    relays.forEach((m, r) => {
      const on = plan.relays_on[i][r], command = retained[i]?.device_commands?.[m.key];
      result.commands[m.key].push(command?.type === "switch_schedule" ? command : { type: "switch_schedule", on_seconds: on ? 900 : 0 });
      const power = on ? q.relay_w[r] : 0;
      result.power[m.key].push(power);
      relayW += power;
    });
    for (const m of thermostats) {
      const command = retained[i]?.device_commands?.[m.key];
      result.commands[m.key].push(command?.type === "setpoint" ? command : { type: "setpoint",
        target_c: Math.min(maximum, Math.max(minimum, Math.round(next * 100) / 100)), minimum_c: minimum, maximum_c: maximum });
      result.power[m.key].push(retained[i]?.device_loads_w?.[m.key] ?? (continuous ? (total - relayW) * rating(m) / continuous : 0));
    }
    unplanned = stepRoom({ decay: q.decay, offset_c: q.offset_c, gain_c_per_w: q.gain_c_per_w,
      delivered_gain_c_per_w: q.delivered_gain_c_per_w ?? 0, carry: q.carry ?? 0 }, unplanned, zone.unplanned_power_w[i]);
    result.unplanned_temperature[zone.key].push(unplanned.temperature_c);
    result.room_power[zone.key].push(total);
    result.temperature[zone.key].push(next);
    if (plan.shortfall_c[i] > 1e-6 || next > maximum + 1e-6) misses++;
    remaining[i] = Math.max(0, remaining[i] - total);
    surplus[i] = Math.max(0, surplus[i] - total);
  }
  return misses;
}
