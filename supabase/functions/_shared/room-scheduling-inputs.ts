import { roomPlanClock } from "./planner/models/room/state.ts";
import { heatingDraw } from "./planner/weather-heating.ts";
import {
  heatingModelRuns,
  type HeatingModelSource,
} from "./planner/heating-bands.ts";
import {
  backgroundRateForSlot,
  roomTransition,
} from "./planner/models/room/thermal.ts";
import {
  isThermostat,
  type ThermostatInput,
} from "./planner/thermostat.ts";
import type { RoomHeatingPlan, RoomQuarter } from "./room-heating-schedule.ts";
import type {
  Member,
  Retained,
  RoomPrices,
  RoomServices,
  Zone,
} from "./rules-room-services.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";
import { roomHeater, roomHeaterDraw, roomHeaterState, roomHeaterCommand } from "./planner/room-heater.ts";

/** Verification forecasts the same interval heating it would execute in Controlling. */
export function schedulableRoomThermostat(member: Member, scope: OptimisationSnapshot["operating_scope"]):
  member is Member & { thermostat: ThermostatInput } {
  const native = member.thermostat;
  if (!isThermostat(native)) return false;
  // An interval command must be expressible in both directions on this native
  // surface. Otherwise retain settings and measured demand rather than promise
  // an OFF state that a thermostat at its frost minimum cannot carry out.
  if (native.current_temperature_c - 1 <= native.minimum_c ||
    native.current_temperature_c + 1 >= native.maximum_c) return false;
  if (native.hvac_action !== "off") return true;
  const mode = scope?.modes[scope.device_owners[member.key]];
  return member.category === "heating" && native.can_activate_heat === true &&
    (mode === "controlling" || mode === "control_verification");
}

/** Empirical room thermostats and comfort relays keep their measured duty profile.
 * An explicit retained switch instead fixes the relay's electrical state. */
export function empiricalHeaterWatts(member: Member, slot: number, retained?: DeviceCommand, outdoorC: number | null = null): number {
  const heater = roomHeater(member);
  const state = heater ? roomHeaterState(heater, retained) : undefined;
  if (state !== undefined) return state ? roomHeaterDraw(heater!, outdoorC)?.watts ?? heater!.power.on_w : 0;
  return Math.max(0, member.forecast_w_by_slot[slot]);
}

export function electricalSource(
  member: Member,
  draw: ReturnType<typeof heatingDraw>,
): HeatingModelSource {
  const point = draw?.band;
  return point
    ? { kind: "band", band_c: point.band_c, revision: point.revision }
    : draw?.anchors_c
    ? {
      kind: "weather_curve",
      revision: draw.reference ?? member.weather_heating?.revision ?? null,
      anchors_c: draw.anchors_c,
    }
    : member.active_power_w != null
    ? {
      kind: "running_power",
      watts: member.active_power_w,
      ...member.running_power_model,
    }
    : { kind: "empirical" };
}

export function compileRoomSchedule(
  snapshot: OptimisationSnapshot,
  zone: Zone,
  controlled: Member[],
  retained: Retained,
  remaining: number[],
  surplus: number[],
  prices: RoomPrices | undefined,
  result: RoomServices,
) {
  const model = zone.model!, n = snapshot.slots.length;
  const shared = snapshot.schema_version >= 12;
  const heaters = controlled.map(member => {
    const contract = roomHeater(member);
    if (!contract) throw new Error(`${member.name}: no supported room heating contract`);
    return contract;
  });
  // Native temperature settings are controller-owned. All planning inputs are
  // interval-constant heat, including Setpoint equipment.
  const electricalUse = controlled.map(() => [] as HeatingModelSource[]);
  const clock = roomPlanClock(snapshot);
  const quarters: RoomQuarter[] = snapshot.slots.map((_slot, i) => {
    const hours = clock.hours[i];
    const steps = Math.ceil(hours * 60);
    // One response throughout; the quarter's outdoor temperature is its input.
    const physics = model;
    const conditions = {
      hours,
      outdoor_c: snapshot.outdoor_temperature_c![i]!,
      house_c: (zone.doorway_boundary_c ?? snapshot.house_temperature_c)?.[i],
      background_c_per_h: backgroundRateForSlot(
        physics,
        i,
        snapshot.solar_irradiance_w_per_m2,
        zone.passive_heat_c_per_h,
      ),
    };
    const maximum_w = Math.max(
      0,
      Math.min(zone.maximum_power_w_by_slot[i], remaining[i]),
    );
    const runningPower = heaters.map(heater => roomHeaterDraw(heater, conditions.outdoor_c));
    if (zone.model_source) {
      controlled.forEach((member, j) => electricalUse[j].push(electricalSource(member, runningPower[j])));
    }
    const transition = roomTransition(physics, conditions);
    return {
      hours,
      steps,
      transition,
      step: roomTransition(physics, {
        ...conditions,
        hours: steps ? hours / steps : 0,
      }),
      required_c: Math.max(
        zone.comfort_min_c[i],
        zone.comfort_min_c[i + 1] ?? zone.comfort_min_c[i],
      ),
      maximum_c: zone.comfort_max_c[i],
      maximum_w,
      relay_w: heaters.map((heater, j) => runningPower[j]?.watts ?? heater.power.on_w),
      fixed_relays: controlled.map((member, j) => roomHeaterState(heaters[j], retained[i]?.device_commands?.[member.key]) ?? null),
      fixed_targets_c: [],
      ...(shared ? { room_target: { preferred_c: zone.target_c[i], fixed_c: null, fixed_switches: [] } } : {}),
      import_sek_per_kwh: prices?.import_sek_per_kwh[i] ?? 1,
      export_sek_per_kwh: prices?.export_sek_per_kwh[i] ?? 1,
      surplus_w: surplus[i],
    };
  });
  if (zone.model_source) {
    (result.heating_model_use ??= {})[zone.key] = {
      thermal: [{ from: 0, through: n - 1, source: zone.model_source }],
      electrical: Object.fromEntries(
        controlled.map((
          member,
          i,
        ) => [member.key, heatingModelRuns(electricalUse[i])]),
      ),
    };
  }
  return { quarters, controlled, heaters, interval_heaters: heaters.map(heater =>
    heater.power.kind === "fixed" ? {kind: "fixed" as const, on_w: heater.power.on_w} : {kind: "inverter" as const}) };
}

export function storeRoomCommands(
  result: RoomServices,
  controlled: Member[],
  retained: Retained,
  plan: RoomHeatingPlan,
  quarters: RoomQuarter[],
) {
  for (const [index, member] of controlled.entries()) {
    const heater = roomHeater(member);
    if (!heater) throw new Error(`${member.name}: room heater contract changed`);
    result.commands[member.key] = [];
    result.power[member.key] = [];
    for (let i = 0; i < quarters.length; i++) {
      const heating = plan.relays_on[i][index];
      const held = retained[i]?.device_commands?.[member.key];
      result.commands[member.key].push(roomHeaterState(heater, held) !== undefined ? held! : roomHeaterCommand(heater, heating));
      result.power[member.key].push(heating ? quarters[i].relay_w[index] : 0);
    }
  }
}
