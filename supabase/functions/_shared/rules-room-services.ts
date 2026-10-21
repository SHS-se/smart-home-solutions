import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";
import { backgroundRateForSlot, roomTransition, usesHouse } from "./planner/thermal-model.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { heatingMask, isThermostat, nativeTarget, supportedTarget, projectThermostatQuarter, type RoomThermostat, type ThermostatRoomState } from "./planner/thermostat.ts";
import { MAX_ROOM_RELAYS, planRoomHeating, type RoomQuarter } from "./room-heating-schedule.ts";

export interface RoomServices {
  commands: Record<string, DeviceCommand[]>;
  power: Record<string, number[]>;
  room_power: Record<string, number[]>;
  temperature: Record<string, Array<number | null>>;
  unplanned_temperature: Record<string,Array<number|null>>;
  unplanned_power: Record<string, number[]>;
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
  const result: RoomServices = { commands: {}, power: {}, room_power: {}, temperature: {}, unplanned_temperature: {}, unplanned_power: {}, warnings: [] };
  const n = snapshot.slots.length;
  const remaining=sharedHeadroom?.slice() ?? snapshot.slots.map(()=>Infinity);
  const surplus=prices?.surplus_w.map(w=>Math.max(0,w)) ?? snapshot.slots.map(()=>0);
  for (const zone of snapshot.thermal_zones ?? []) {
    const members = snapshot.device_models.filter(m => zone.device_keys.includes(m.key));
    const relays = members.filter(m => m.control_type === "switch_schedule");
    const thermostats = members.filter(m => m.control_type === "setpoint");
    const temperature = zone.start_temperature_c;
    const cumulative = new Map<string, number>();
    let comfortMisses = 0;
    result.room_power[zone.key] = [];
    result.temperature[zone.key] = [];
    result.unplanned_temperature[zone.key]=[];
    result.unplanned_power[zone.key]=[];
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
      outdoorKnown && houseKnown && thermostats.every(m => isThermostat(m.thermostat) && (m.active_power_w ?? 0) > 0) && zone.model.gain_c_per_wh > 0 && zone.model.cooling_constant_per_h >= 0) {
      comfortMisses = scheduleRoom(snapshot, zone, thermostats, relays, retained, remaining, surplus, prices, result);
      if (comfortMisses) result.warnings.push(shortfall(zone, comfortMisses));
      continue;
    }
    // Incomplete native/thermal evidence is an estimate, not an ideal heater.
    // Keep existing comfort intent and empirical electrical demand, without
    // inventing temperatures or an unseen thermostat's duty cycle.
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (const m of members) {
        const locked = retained[i]?.device_commands?.[m.key];
        if (m.control_type === "setpoint") {
          const t = isThermostat(m.thermostat) ? m.thermostat : null;
          const command = locked?.type === "setpoint" ? locked : { type: "setpoint" as const,
            target_c: t ? supportedTarget(t, zone.target_c[i]) : zone.target_c[i],
            minimum_c: t?.minimum_c ?? zone.comfort_min_c[i], maximum_c: t?.maximum_c ?? zone.comfort_max_c[i] };
          result.commands[m.key].push(command);
          const watts = Math.max(0, m.forecast_w_by_slot[i]);
          result.power[m.key].push(watts); total += watts;
        } else if (m.control_type === "switch_schedule") {
          const watts = m.active_power_w ?? 0;
          const debt = (cumulative.get(m.key) ?? 0) + (watts > 0 ? m.forecast_w_by_slot[i] / watts : 0);
          const requested = i === 0 && temperature !== null ? temperature < zone.target_c[i] : debt >= 1;
          const on = locked?.type === "switch_schedule" ? locked.on_seconds > 0 : requested && watts <= remaining[i] - total;
          cumulative.set(m.key, debt - (on ? 1 : 0));
          result.commands[m.key].push(locked?.type === "switch_schedule" ? locked : { type: "switch_schedule", on_seconds: on ? 900 : 0 });
          result.power[m.key].push(on ? watts : 0); total += on ? watts : 0;
        }
      }
      result.room_power[zone.key].push(total);
      result.temperature[zone.key].push(null);
      result.unplanned_temperature[zone.key].push(null);
      result.unplanned_power[zone.key].push(zone.unplanned_power_w[i]);
      remaining[i] = Math.max(0, remaining[i] - total);
      surplus[i] = Math.max(0, surplus[i] - total);
    }
    result.warnings.push(planningWarning("room_estimate", zone.key,
      `${zone.name}: the thermal or native thermostat forecast has incomplete evidence.`,
      "Comfort setpoints and empirical relay schedules remain active; consumption is estimated from measured history."));
  }
  return result;
}

type Zone = NonNullable<OptimisationSnapshot["thermal_zones"]>[number];
type Member = OptimisationSnapshot["device_models"][number];
type Retained = Array<{ device_commands?: Record<string, DeviceCommand>; device_loads_w?: Record<string, number> }>;

const shortfall = (zone: Zone, quarters: number) => planningWarning("comfort_shortfall", zone.key,
  `${zone.name}: ${quarters} quarters may be outside the requested comfort band.`,
  "The best attainable room schedule is included and household planning continues.", { quarters });

/** Native target actions and the resulting demand are solved together. */
function scheduleRoom(snapshot: OptimisationSnapshot, zone: Zone, members: Member[], relays: Member[],
  retained: Retained, remaining: number[], surplus: number[],
  prices: RoomPrices | undefined, result: RoomServices): number {
  const model = zone.model!, n = snapshot.slots.length;
  const thermostats: RoomThermostat[] = members.map(m => {
    if (!isThermostat(m.thermostat)) throw new Error("Native thermostat evidence was not prepared");
    return { ...m.thermostat, power_w: m.active_power_w!, sensor_offset_c: m.thermostat.current_temperature_c - zone.start_temperature_c! };
  });
  const quarters: RoomQuarter[] = snapshot.slots.map((slot, i) => {
    const hours = Math.min(.25, Math.max(0, (Date.parse(slot.start) + 900_000 - Date.parse(snapshot.captured_at)) / 3_600_000));
    const steps = Math.ceil(hours * 60);
    const conditions = { hours, outdoor_c: snapshot.outdoor_temperature_c![i]!, house_c: snapshot.house_temperature_c?.[i],
      background_c_per_h: backgroundRateForSlot(model, i, snapshot.solar_irradiance_w_per_m2) };
    return { hours, steps, transition: roomTransition(model, conditions),
      step: roomTransition(model, { ...conditions, hours: steps ? hours / steps : 0 }),
      required_c: Math.max(zone.comfort_min_c[i], zone.comfort_min_c[i + 1] ?? zone.comfort_min_c[i]),
      maximum_c: zone.comfort_max_c[i], maximum_w: Math.max(0, Math.min(zone.maximum_power_w_by_slot[i], remaining[i])),
      relay_w: relays.map(m => m.active_power_w ?? 0),
      fixed_relays: relays.map(m => { const c = retained[i]?.device_commands?.[m.key]; return c?.type === "switch_schedule" ? c.on_seconds > 0 : null; }),
      fixed_targets_c: members.map((m, j) => { const c = retained[i]?.device_commands?.[m.key]; return c?.type === "setpoint" ? nativeTarget(thermostats[j], c.target_c) : null; }),
      import_sek_per_kwh: prices?.import_sek_per_kwh[i] ?? 1,
      export_sek_per_kwh: prices?.export_sek_per_kwh[i] ?? 1, surplus_w: surplus[i] };
  });
  const plan = planRoomHeating(zone.start_temperature_c!, thermostats, quarters, zone.start_delivered_w ?? 0);
  let misses = 0, previousC = zone.start_temperature_c!;
  let unplanned: ThermostatRoomState = { temperature_c: zone.start_temperature_c!, delivered_w: zone.start_delivered_w ?? 0, heating_mask: heatingMask(thermostats) };
  const debts = relays.map(() => 0);
  for (let i = 0; i < n; i++) {
    const q = quarters[i];
    relays.forEach((m, r) => {
      const on = plan.relays_on[i][r], command = retained[i]?.device_commands?.[m.key];
      result.commands[m.key].push(command?.type === "switch_schedule" ? command : { type: "switch_schedule", on_seconds: on ? 900 : 0 });
      result.power[m.key].push(on ? q.relay_w[r] : 0);
    });
    members.forEach((m, j) => {
      const command = retained[i]?.device_commands?.[m.key];
      result.commands[m.key].push(command?.type === "setpoint" ? command : { type: "setpoint", target_c: plan.targets_c[i][j],
        minimum_c: thermostats[j].minimum_c, maximum_c: thermostats[j].maximum_c });
      result.power[m.key].push(plan.thermostat_w[i][j]);
    });
    const baselineRelayW = relays.reduce((sum, m, r) => {
      const watts = q.relay_w[r];
      debts[r] += watts > 0 ? m.forecast_w_by_slot[i] / watts : 0;
      const on = debts[r] >= 1; debts[r] -= on ? 1 : 0;
      return sum + (on ? watts : 0);
    }, 0);
    const baseline = projectThermostatQuarter(q, thermostats, unplanned,
      thermostats.map(t => supportedTarget(t, zone.target_c[i] + t.sensor_offset_c)), baselineRelayW);
    unplanned = baseline.state;
    result.unplanned_temperature[zone.key].push(unplanned.temperature_c);
    result.unplanned_power[zone.key].push(baselineRelayW + baseline.thermostat_w.reduce((a, b) => a + b, 0));
    result.room_power[zone.key].push(plan.power_w[i]);
    result.temperature[zone.key].push(plan.temperature_c[i]);
    if (plan.shortfall_c[i] > 1e-6 || plan.temperature_c[i] > Math.max(zone.comfort_max_c[i], previousC) + 1e-6) misses++;
    previousC = plan.temperature_c[i];
    remaining[i] = Math.max(0, remaining[i] - plan.power_w[i]);
    surplus[i] = Math.max(0, surplus[i] - plan.power_w[i]);
  }
  return misses;
}
