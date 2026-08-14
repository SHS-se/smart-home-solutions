import {
  projectZoneTemperature,
  type ThermalZoneModel,
} from "./thermal-model.ts";

export const COMFORT_MODES = ["off", "low-temp", "high-temp"] as const;
export type ComfortMode = (typeof COMFORT_MODES)[number];
export type ComfortDayType = "weekday" | "weekend";

export interface ZoneComfortSchedule {
  weekday_modes: ComfortMode[];
  weekend_modes: ComfortMode[];
  off_temperature_c: number;
  low_temperature_c: number;
  high_temperature_c: number;
}

export interface ComfortInterval {
  mode: ComfortMode;
  start_quarter: number;
  end_quarter: number;
}

export interface ComfortForecast {
  modes: ComfortMode[];
  comfort_min_c: number[];
  target_c: number[];
  comfort_max_c: number[];
  power_w: number[];
  temperature_c: number[];
}

const SLOT_HOURS = 0.25;
const MODE_SET = new Set<string>(COMFORT_MODES);
const formatterByTimezone = new Map<string, Intl.DateTimeFormat>();

/** The one-off Node-RED seed: warm 05:00–09:30 and 14:00–21:30. */
export const seededComfortModes = (): ComfortMode[] =>
  Array.from(
    { length: 96 },
    (_unused, quarter) =>
      (quarter >= 20 && quarter < 38) || (quarter >= 56 && quarter < 86)
        ? "high-temp"
        : "low-temp",
  );

export const isComfortModeArray = (value: unknown): value is ComfortMode[] =>
  Array.isArray(value) && value.length === 96 &&
  value.every((mode) => typeof mode === "string" && MODE_SET.has(mode));

export const isZoneComfortSchedule = (
  value: unknown,
): value is ZoneComfortSchedule => {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<ZoneComfortSchedule>;
  const temperatures = [
    schedule.off_temperature_c,
    schedule.low_temperature_c,
    schedule.high_temperature_c,
  ];
  return isComfortModeArray(schedule.weekday_modes) &&
    isComfortModeArray(schedule.weekend_modes) &&
    temperatures.every((temperature) =>
      typeof temperature === "number" && Number.isFinite(temperature) &&
      temperature >= 5 && temperature <= 30
    ) &&
    schedule.off_temperature_c! <= schedule.low_temperature_c! &&
    schedule.low_temperature_c! <= schedule.high_temperature_c!;
};

export const quarterLabel = (quarter: number): string => {
  const normalized = Math.max(0, Math.min(96, Math.round(quarter)));
  if (normalized === 96) return "24:00";
  const hour = Math.floor(normalized / 4);
  const minute = (normalized % 4) * 15;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/** Collapse a painted 96-cell row into the periods shown below the editor. */
export const comfortIntervals = (
  modes: ComfortMode[],
): ComfortInterval[] => {
  if (!isComfortModeArray(modes)) return [];
  const intervals: ComfortInterval[] = [];
  let start = 0;
  for (let quarter = 1; quarter <= modes.length; quarter += 1) {
    if (quarter < modes.length && modes[quarter] === modes[start]) continue;
    intervals.push({
      mode: modes[start],
      start_quarter: start,
      end_quarter: quarter,
    });
    start = quarter;
  }
  return intervals;
};

function localSlot(
  start: string | Date,
  timezone: string,
): { day_type: ComfortDayType; quarter: number; month: number } {
  let formatter = formatterByTimezone.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterByTimezone.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(start)).map((
      part,
    ) => [part.type, part.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const month = Number(parts.month);
  if (
    !Number.isInteger(hour) || !Number.isInteger(minute) ||
    !Number.isInteger(month)
  ) {
    throw new Error(`could not resolve local comfort slot in ${timezone}`);
  }
  return {
    day_type: parts.weekday === "Sat" || parts.weekday === "Sun"
      ? "weekend"
      : "weekday",
    quarter: hour * 4 + Math.floor(minute / 15),
    month,
  };
}

/** Existing local safety policy: room heating is locked out June–August. */
export const summerHeatingLockoutForStarts = (
  starts: string[],
  timezone: string,
): boolean[] =>
  starts.map((start) => {
    const month = localSlot(start, timezone).month;
    return month >= 6 && month <= 8;
  });

export function comfortModesForStarts(
  starts: string[],
  timezone: string,
  schedule: ZoneComfortSchedule,
): ComfortMode[] {
  if (!isZoneComfortSchedule(schedule)) {
    throw new Error(
      "comfort schedule must contain two complete 96-quarter days",
    );
  }
  return starts.map((start) => {
    const local = localSlot(start, timezone);
    return schedule[`${local.day_type}_modes`][local.quarter];
  });
}

const temperatureForMode = (
  schedule: ZoneComfortSchedule,
  mode: ComfortMode,
): number => {
  if (mode === "off") return schedule.off_temperature_c;
  return mode === "low-temp"
    ? schedule.low_temperature_c
    : schedule.high_temperature_c;
};

/**
 * Forecast the thermostat demand implied by a comfort routine and a fitted
 * 1R1C zone. The backwards pass works out how early a slow room must begin
 * recovering; the forwards pass emits the bounded mean power for each quarter.
 */
export function buildComfortForecast(
  starts: string[],
  timezone: string,
  schedule: ZoneComfortSchedule,
  model: ThermalZoneModel,
  startTemperatureC: number,
  outdoorTemperatureC: number[],
  ratedPowerW: number,
  heatingLockout: boolean[],
): ComfortForecast {
  if (
    starts.length === 0 || starts.length !== outdoorTemperatureC.length ||
    starts.length !== heatingLockout.length
  ) {
    throw new Error(
      "comfort forecast inputs must cover the same non-empty horizon",
    );
  }
  if (
    !Number.isFinite(startTemperatureC) || !Number.isFinite(ratedPowerW) ||
    ratedPowerW <= 0 || !Number.isFinite(model.gain_c_per_wh) ||
    model.gain_c_per_wh <= 0 ||
    !Number.isFinite(model.cooling_constant_per_h) ||
    model.cooling_constant_per_h < 0 ||
    !Number.isFinite(model.background_gain_c_per_h) ||
    outdoorTemperatureC.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      "comfort forecast needs finite temperatures and rated power",
    );
  }
  const modes = comfortModesForStarts(starts, timezone, schedule);
  const target = modes.map((mode) => temperatureForMode(schedule, mode));
  // These are temperature objectives, not thermostat bands. In particular,
  // the first high-temp quarter is a deadline: the room must already be at
  // the configured comfort temperature when that quarter begins. The upper
  // series is only a planner-side preheat ceiling.
  const comfortMin = [...target];
  const comfortMax = target.map(() => schedule.high_temperature_c + 0.5);

  // Required temperature at the start of each quarter. Looking backwards
  // allows a high-mass floor to start recovery before the comfort period,
  // while never preheating above the configured comfort temperature.
  const required = [...target];
  const alpha = 1 - model.cooling_constant_per_h * SLOT_HOURS;
  if (!(alpha > 0)) throw new Error("thermal cooling constant is unstable");
  for (let index = required.length - 2; index >= 0; index -= 1) {
    const maximumNextGain = SLOT_HOURS * (
      model.gain_c_per_wh * ratedPowerW +
      model.cooling_constant_per_h * outdoorTemperatureC[index] +
      model.background_gain_c_per_h
    );
    const neededNow = (required[index + 1] - maximumNextGain) / alpha;
    required[index] = Math.min(
      schedule.high_temperature_c,
      Math.max(target[index], neededNow),
    );
  }

  const power: number[] = [];
  let temperature = startTemperatureC;
  for (let index = 0; index < starts.length; index += 1) {
    const desiredNext = required[Math.min(index + 1, required.length - 1)];
    const passiveNext = temperature + SLOT_HOURS * (
          model.cooling_constant_per_h *
            (outdoorTemperatureC[index] - temperature) +
          model.background_gain_c_per_h
        );
    const desiredPower = (desiredNext - passiveNext) /
      (SLOT_HOURS * model.gain_c_per_wh);
    const watts = heatingLockout[index]
      ? 0
      : Math.max(0, Math.min(ratedPowerW, desiredPower));
    power.push(Math.round(watts * 100) / 100);
    temperature = passiveNext +
      SLOT_HOURS * model.gain_c_per_wh * watts;
  }

  return {
    modes,
    comfort_min_c: comfortMin,
    target_c: target,
    comfort_max_c: comfortMax,
    power_w: power,
    temperature_c: projectZoneTemperature(
      model,
      startTemperatureC,
      outdoorTemperatureC,
      power,
    ),
  };
}
