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
  nativeTarget,
  type RoomThermostat,
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

export function retainedRoomTarget(
  slot: Retained[number] | undefined,
  zone: Zone,
): number | null {
  for (const key of zone.device_keys) {
    const command = slot?.device_commands?.[key];
    if (command?.type === "room_relay" && command.room_key === zone.key) {
      return command.target_c;
    }
    if (command?.type === "setpoint" && command.room_target_c != null) {
      return command.room_target_c;
    }
  }
  return null;
}

export function compileRoomSchedule(
  snapshot: OptimisationSnapshot,
  zone: Zone,
  members: Member[],
  relays: Member[],
  retained: Retained,
  remaining: number[],
  surplus: number[],
  prices: RoomPrices | undefined,
  result: RoomServices,
) {
  const model = zone.model!, n = snapshot.slots.length;
  const shared = snapshot.schema_version >= 12;
  const thermostats: RoomThermostat[] = members.map((m) => {
    if (!isThermostat(m.thermostat)) {
      throw new Error("Native thermostat evidence was not prepared");
    }
    return {
      ...m.thermostat,
      power_w: m.active_power_w!,
      ...(m.weather_heating?.banded
        ? { reservation_w: m.active_power_w! }
        : {}),
      sensor_offset_c: m.thermostat.current_temperature_c -
        (zone.temperature_observation?.mean_c ?? zone.start_temperature_c!),
    };
  });
  const actuators = shared
    ? [
      ...thermostats,
      ...relays.map((m) => ({
        relay: true,
        power_w: m.active_power_w!,
        sensor_offset_c: 0,
        current_temperature_c: zone.start_temperature_c!,
        minimum_c: 0,
        maximum_c: 100,
        step_c: 0.1,
        target_temperature_c: zone.start_temperature_c!,
        entity_id: m.key,
        hvac_action: m.relay_on ? "heating" as const : "idle" as const,
      })),
    ]
    : thermostats;
  const weather = members.some((member) => member.weather_heating);
  const controlled = [...members, ...relays];
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
    const runningPower = weather || zone.model_source
      ? controlled.map((member) => {
        const profile = member.weather_heating;
        return profile ? heatingDraw(profile, conditions.outdoor_c) : null;
      })
      : undefined;
    if (zone.model_source && runningPower) {
      for (const [j, member] of controlled.entries()) {
        electricalUse[j].push(electricalSource(member, runningPower[j]));
      }
    }
    const thermostatPower = weather
      ? actuators.map((actuator, j) =>
        runningPower?.[j]?.watts ?? actuator.power_w
      )
      : undefined;
    const transition = roomTransition(physics, conditions);
    return {
      hours,
      steps,
      transition,
      ...(thermostatPower ? { thermostat_power_w: thermostatPower } : {}),
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
      ...(shared && relays.length ? { relay_budget_w: maximum_w } : {}),
      relay_w: shared ? [] : relays.map((m) => m.active_power_w ?? 0),
      fixed_relays: shared ? [] : relays.map((m) => {
        const c = retained[i]?.device_commands?.[m.key];
        return c?.type === "switch_schedule" ? c.on_seconds > 0 : null;
      }),
      fixed_targets_c: [
        ...members.map((m, j) => {
          const c = retained[i]?.device_commands?.[m.key];
          return c?.type === "setpoint"
            ? nativeTarget(thermostats[j], c.target_c)
            : null;
        }),
        ...(shared
          ? relays.map((m) => {
            const c = retained[i]?.device_commands?.[m.key];
            return c?.type === "room_relay" && c.room_key === zone.key
              ? c.target_c
              : null;
          })
          : []),
      ],
      ...(shared
        ? {
          room_target: {
            preferred_c: zone.target_c[i],
            fixed_c: retainedRoomTarget(retained[i], zone),
            fixed_switches: [
              ...members.map(() => null),
              ...relays.map((m) => {
                const c = retained[i]?.device_commands?.[m.key];
                return c?.type === "switch_schedule" ? c.on_seconds > 0 : null;
              }),
            ],
          },
        }
        : {}),
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
  return { quarters, thermostats, actuators };
}

export function storeRoomCommands(
  result: RoomServices,
  zone: Zone,
  thermostats: RoomThermostat[],
  members: Member[],
  relays: Member[],
  retained: Retained,
  plan: RoomHeatingPlan,
  quarters: RoomQuarter[],
  shared: boolean,
) {
  for (const member of [...members, ...relays]) {
    result.commands[member.key] = [];
    result.power[member.key] = [];
  }
  for (let i = 0; i < quarters.length; i++) {
    const q = quarters[i];
    relays.forEach((m, r) => {
      const on = plan.relays_on[i][r],
        command = retained[i]?.device_commands?.[m.key];
      const held = command?.type === "switch_schedule" ||
        command?.type === "room_relay" && command.room_key === zone.key;
      result.commands[m.key].push(
        held ? command : shared
          ? {
            type: "room_relay",
            room_key: zone.key,
            target_c: plan.room_targets_c![i],
          }
          : { type: "switch_schedule", on_seconds: on ? 900 : 0 },
      );
      result.power[m.key].push(
        shared
          ? plan.thermostat_w[i][members.length + r]
          : on
          ? q.relay_w[r]
          : 0,
      );
    });
    members.forEach((m, j) => {
      const command = retained[i]?.device_commands?.[m.key];
      result.commands[m.key].push(
        command?.type === "setpoint" ? command : {
          type: "setpoint",
          target_c: plan.targets_c[i][j],
          minimum_c: thermostats[j].minimum_c,
          maximum_c: thermostats[j].maximum_c,
          ...(shared ? { room_target_c: plan.room_targets_c![i] } : {}),
        },
      );
      result.power[m.key].push(plan.thermostat_w[i][j]);
    });
  }
}
