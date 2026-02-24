import { createDeviceRuntime, type DeviceModelKey, type DeviceRuntime, type MinuteWindow } from './device-models';
import type { CurvePoint, SurfacePoint } from '@/lib/performance-data';

export interface SimulatorDeviceTypeRef {
  key?: string | null;
  simulation_model_key?: string | null;
}

export interface SimulatorDeviceInstanceRow {
  id: string;
  name?: string | null;
  field_values?: Record<string, unknown> | null;
  controllable?: boolean | null;
  shiftable?: boolean | null;
  priority?: number | null;
  device_types?: SimulatorDeviceTypeRef | null;
}

export interface SimulatorAssignmentRow {
  quantity?: number | null;
  device_instances: SimulatorDeviceInstanceRow | null;
}

export interface DeviceBindingDefaults {
  roomKeyByDeviceId?: Record<string, string>;
  roomKeyByDeviceTypeKey?: Record<string, string>;
  occupancyDefault?: 'home' | 'away' | 'sleep' | 'unknown';
  defaultSetpointC?: number;
  heatPumpProfilesByDeviceId?: Record<string, {
    copCapacityCurvePoints?: CurvePoint[];
    heatingPerformanceSurfacePoints?: SurfacePoint[];
  }>;
}

export interface DeviceBindingWarning {
  deviceId: string;
  deviceName?: string | null;
  code: string;
  message: string;
}

export interface DeviceBindingResult {
  devices: DeviceRuntime[];
  warnings: DeviceBindingWarning[];
}

const MODEL_KEY_ALIASES: Record<string, DeviceModelKey> = {
  constant: 'fixed_baseload',
  base_load_constant: 'fixed_baseload',
  resistive: 'electric_resistive_thermostat',
  direct_electric_heater: 'electric_resistive_thermostat',
  heat_pump_aa: 'air_to_air_heat_pump_inverter',
  air_to_air_heat_pump: 'air_to_air_heat_pump_inverter',
  air_to_air_heat_pump_dumb: 'air_to_air_heat_pump_inverter',
  fixed_schedule: 'event_appliance',
  ev_charger: 'event_appliance',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readNumber(
  fv: Record<string, unknown>,
  keys: string[],
  opts?: { min?: number; allowZero?: boolean },
): number | null {
  for (const key of keys) {
    const raw = fv[key];
    if (raw == null || raw === '') continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    if (opts?.min != null && n < opts.min) continue;
    if (!opts?.allowZero && n === 0) continue;
    return n;
  }
  return null;
}

function readString(fv: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = fv[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

function readBoolean(fv: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const raw = fv[key];
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return null;
}

function readArray<T = unknown>(fv: Record<string, unknown>, keys: string[]): T[] | null {
  for (const key of keys) {
    const raw = fv[key];
    if (Array.isArray(raw)) return raw as T[];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as T[];
      } catch {
        // ignore parse failures
      }
    }
  }
  return null;
}

function parsePowerFromTextW(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.toLowerCase();

  // Explicit units first: "1200w", "11 kw", "4.0kW class"
  const unitMatch = s.match(/(\d+(?:[.,]\d+)?)\s*(kw|w)\b/);
  if (unitMatch) {
    const n = Number(unitMatch[1].replace(',', '.'));
    if (Number.isFinite(n) && n > 0) {
      return unitMatch[2] === 'kw' ? n * 1000 : n;
    }
  }

  // Common base-load style model names like "BL-500"
  const blMatch = s.match(/\bbl[-_\s]?(\d{2,5})\b/);
  if (blMatch) {
    const n = Number(blMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

function readPowerWWithAliases(
  fv: Record<string, unknown>,
  options: {
    wKeys?: string[];
    kwKeys?: string[];
    nameText?: string | null;
    allowNameFallback?: boolean;
    min?: number;
    allowZero?: boolean;
  },
): number | null {
  const min = options.min;
  const allowZero = options.allowZero;

  const fromW = options.wKeys && options.wKeys.length > 0
    ? readNumber(fv, options.wKeys, { min, allowZero })
    : null;
  if (fromW != null) return fromW;

  if (options.kwKeys && options.kwKeys.length > 0) {
    const fromKw = readNumber(fv, options.kwKeys, { min: min != null ? min / 1000 : undefined, allowZero });
    if (fromKw != null) return fromKw * 1000;
  }

  if (options.allowNameFallback) {
    const fromName = parsePowerFromTextW(options.nameText);
    if (fromName != null) {
      if (min != null && fromName < min) return null;
      if (!allowZero && fromName === 0) return null;
      return fromName;
    }
  }

  return null;
}

function resolveRoomKey(
  device: SimulatorDeviceInstanceRow,
  fv: Record<string, unknown>,
  defaults?: DeviceBindingDefaults,
): string {
  const fromFieldValues = readString(fv, ['room_key', 'room', 'zone_key']);
  if (fromFieldValues) return fromFieldValues;
  const typeKey = device.device_types?.key ?? undefined;
  if (typeKey && defaults?.roomKeyByDeviceTypeKey?.[typeKey]) return defaults.roomKeyByDeviceTypeKey[typeKey];
  if (defaults?.roomKeyByDeviceId?.[device.id]) return defaults.roomKeyByDeviceId[device.id];
  return 'default_room';
}

function normalizeSimulationModelKey(
  rawKey: string | null | undefined,
): { normalized: DeviceModelKey | null; sourceKey: string | null; aliasUsed: boolean } {
  if (!rawKey) return { normalized: null, sourceKey: null, aliasUsed: false };
  const sourceKey = rawKey.trim();
  if (!sourceKey) return { normalized: null, sourceKey: null, aliasUsed: false };
  const canonical = sourceKey.toLowerCase();
  const direct = canonical as DeviceModelKey;
  if (['fixed_baseload', 'electric_resistive_thermostat', 'air_to_air_heat_pump_inverter', 'fridge_freezer_compressor', 'event_appliance'].includes(direct)) {
    return { normalized: direct, sourceKey, aliasUsed: canonical !== sourceKey };
  }
  const alias = MODEL_KEY_ALIASES[canonical];
  if (alias) return { normalized: alias, sourceKey, aliasUsed: true };
  return { normalized: null, sourceKey, aliasUsed: false };
}

function minuteWindowsFromFieldValues(fv: Record<string, unknown>, fallback?: MinuteWindow[]): MinuteWindow[] | undefined {
  const rawWindows = readArray<Record<string, unknown>>(fv, ['schedule_windows', 'on_windows', 'allowed_windows']);
  if (!rawWindows) return fallback;
  const windows: MinuteWindow[] = [];
  for (const raw of rawWindows) {
    const rec = asRecord(raw);
    const startMinute = readNumber(rec, ['startMinute', 'start_minute'], { min: 0, allowZero: true });
    const endMinute = readNumber(rec, ['endMinute', 'end_minute'], { min: 0, allowZero: true });
    if (startMinute == null || endMinute == null) continue;
    const days = readArray<number>(rec, ['daysOfWeek', 'days_of_week']) ?? undefined;
    const weight = readNumber(rec, ['weight'], { min: 0, allowZero: false }) ?? undefined;
    windows.push({
      startMinute: Math.trunc(startMinute),
      endMinute: Math.trunc(endMinute),
      daysOfWeek: days?.map(d => Math.trunc(Number(d))).filter(d => Number.isFinite(d)),
      weight,
    });
  }
  return windows.length > 0 ? windows : fallback;
}

function pushWarning(warnings: DeviceBindingWarning[], device: SimulatorDeviceInstanceRow, code: string, message: string): void {
  warnings.push({ deviceId: device.id, deviceName: device.name, code, message });
}

function estimateCycleDurationSecondsForEventLikeDevice(
  device: SimulatorDeviceInstanceRow,
  fv: Record<string, unknown>,
  ratedPowerW: number | null,
): number | null {
  const explicitSeconds =
    readNumber(fv, ['duration_seconds', 'session_duration_seconds', 'run_duration_seconds'], { min: 1 }) ??
    (() => {
      const minutes = readNumber(fv, ['duration_minutes', 'session_duration_minutes', 'run_duration_minutes'], { min: 1 });
      return minutes == null ? null : minutes * 60;
    })() ??
    (() => {
      const hours = readNumber(fv, ['duration_hours', 'session_duration_hours', 'run_duration_hours'], { min: 0.1 });
      return hours == null ? null : hours * 3600;
    })();
  if (explicitSeconds && explicitSeconds > 0) return explicitSeconds;

  if (ratedPowerW && ratedPowerW > 0) {
    const energyKwh =
      readNumber(fv, ['session_energy_kwh', 'daily_energy_kwh', 'charge_energy_kwh', 'typical_energy_kwh'], { min: 0.1 }) ??
      null;
    if (energyKwh != null) return Math.max(60, (energyKwh * 1000 / ratedPowerW) * 3600);
  }

  const typeKey = (device.device_types?.key || '').toLowerCase();
  const sourceKey = (device.device_types?.simulation_model_key || '').toLowerCase();
  if (sourceKey === 'ev_charger' || typeKey.includes('ev')) return 4 * 3600;
  if (typeKey.includes('dishwasher')) return 2 * 3600;
  if (typeKey.includes('washing')) return 90 * 60;
  if (typeKey.includes('dryer')) return 75 * 60;
  if (typeKey.includes('oven')) return 45 * 60;
  if (typeKey.includes('microwave')) return 5 * 60;

  return 60 * 60;
}

function buildRuntimeForDevice(
  device: SimulatorDeviceInstanceRow,
  quantity: number,
  defaults: DeviceBindingDefaults | undefined,
  warnings: DeviceBindingWarning[],
): DeviceRuntime | null {
  const fv = asRecord(device.field_values);
  const normalizedModel = normalizeSimulationModelKey(device.device_types?.simulation_model_key ?? null);
  const modelKey = normalizedModel.normalized;

  if (!modelKey) {
    if (normalizedModel.sourceKey) {
      pushWarning(warnings, device, 'unsupported_model_key', `Unsupported simulation_model_key: ${normalizedModel.sourceKey}`);
    } else {
      pushWarning(warnings, device, 'missing_model_key', 'Device type has no simulation_model_key');
    }
    return null;
  }

  try {
    if (
      normalizedModel.aliasUsed &&
      normalizedModel.sourceKey &&
      !['heat_pump_aa', 'air_to_air_heat_pump_dumb'].includes(normalizedModel.sourceKey.toLowerCase())
    ) {
      pushWarning(warnings, device, 'model_key_alias', `Mapped ${normalizedModel.sourceKey} -> ${modelKey}`);
    }

    switch (modelKey) {
      case 'fixed_baseload': {
        const powerW = readPowerWWithAliases(fv, {
          wKeys: ['power_w', 'base_power_w', 'rated_power_w', 'nominal_power_w', 'standby_power_w'],
          kwKeys: ['power_kw', 'base_power_kw', 'rated_power_kw'],
          nameText: device.name,
          allowNameFallback: true,
          min: 0,
          allowZero: true,
        });
        if (powerW == null) {
          pushWarning(warnings, device, 'missing_power', 'fixed_baseload requires power_w/base_power_w/rated_power_w');
          return null;
        }
        if (readNumber(fv, ['power_w', 'base_power_w', 'rated_power_w', 'nominal_power_w', 'standby_power_w'], { min: 0, allowZero: true }) == null &&
            readNumber(fv, ['power_kw', 'base_power_kw', 'rated_power_kw'], { min: 0, allowZero: true }) == null) {
          pushWarning(warnings, device, 'assumed_power_from_name', `Using ${Math.round(powerW)}W inferred from device name`);
        }
        return createDeviceRuntime(device.id, modelKey, { powerW: powerW * quantity });
      }

      case 'electric_resistive_thermostat': {
        const ratedPowerW = readPowerWWithAliases(fv, {
          wKeys: ['rated_power_w', 'power_w', 'nominal_power_w', 'max_power_w', 'heater_power_w'],
          kwKeys: ['rated_power_kw', 'power_kw', 'nominal_power_kw'],
          nameText: device.name,
          allowNameFallback: true,
          min: 1,
        });
        let setpointC = readNumber(fv, ['thermostat_setpoint_c', 'setpoint_c', 'target_temp_c'], { allowZero: true });
        if (ratedPowerW == null) {
          pushWarning(warnings, device, 'missing_fields', 'electric_resistive_thermostat requires rated_power_w');
          return null;
        }
        if (readNumber(fv, ['rated_power_w', 'power_w', 'nominal_power_w', 'max_power_w', 'heater_power_w'], { min: 1 }) == null &&
            readNumber(fv, ['rated_power_kw', 'power_kw', 'nominal_power_kw'], { min: 0.001 }) == null) {
          pushWarning(warnings, device, 'assumed_power_from_name', `Using ${Math.round(ratedPowerW)}W inferred from device name`);
        }
        if (setpointC == null) {
          setpointC = defaults?.defaultSetpointC ?? 21;
        }
        const deadbandC = readNumber(fv, ['deadband_c', 'thermostat_deadband_c'], { min: 0.05 }) ?? 0.4;
        const minOnSeconds = readNumber(fv, ['min_on_seconds'], { min: 0, allowZero: true }) ?? 0;
        const minOffSeconds = readNumber(fv, ['min_off_seconds'], { min: 0, allowZero: true }) ?? 0;
        const heatToRoomFraction = readNumber(fv, ['heat_to_room_fraction'], { min: 0, allowZero: true }) ?? 1;
        const scheduleWindows = minuteWindowsFromFieldValues(fv);
        return createDeviceRuntime(device.id, modelKey, {
          roomKey: resolveRoomKey(device, fv, defaults),
          ratedPowerW: ratedPowerW * quantity,
          setpointC,
          deadbandC,
          minOnSeconds,
          minOffSeconds,
          heatToRoomFraction,
          scheduleWindows,
        });
      }

      case 'air_to_air_heat_pump_inverter': {
        let ratedInputPowerW = readPowerWWithAliases(fv, {
          wKeys: ['rated_input_power_w', 'input_power_w', 'nominal_input_power_w', 'max_input_power_w'],
          kwKeys: ['rated_input_power_kw', 'input_power_kw', 'nominal_input_power_kw'],
          nameText: null,
          allowNameFallback: false,
          min: 1,
        });
        let ratedHeatingCapacityW = readPowerWWithAliases(fv, {
          wKeys: ['rated_heating_capacity_w', 'heating_capacity_w', 'capacity_w', 'rated_capacity_w', 'nominal_capacity_w'],
          kwKeys: ['rated_heating_capacity_kw', 'heating_capacity_kw', 'capacity_kw', 'rated_capacity_kw'],
          nameText: device.name,
          allowNameFallback: true,
          min: 1,
        });
        const genericPowerMaybeCapacityW = readPowerWWithAliases(fv, {
          wKeys: ['rated_power_w', 'power_w', 'nominal_power_w', 'max_power_w'],
          kwKeys: ['rated_power_kw', 'power_kw', 'nominal_power_kw', 'max_power_kw'],
          nameText: null,
          allowNameFallback: false,
          min: 1,
        });
        if (ratedHeatingCapacityW == null && genericPowerMaybeCapacityW != null) {
          ratedHeatingCapacityW = genericPowerMaybeCapacityW;
          pushWarning(warnings, device, 'assumed_capacity_from_generic_power', 'Interpreting generic power field as heating capacity for heat pump');
        }
        let setpointC = readNumber(fv, ['thermostat_setpoint_c', 'setpoint_c', 'target_temp_c'], { allowZero: true });
        if (ratedInputPowerW == null && ratedHeatingCapacityW != null) {
          ratedInputPowerW = ratedHeatingCapacityW / 3.2;
          pushWarning(warnings, device, 'assumed_input_power', 'No input power found; inferred from heating capacity using COP 3.2');
        }
        if (ratedInputPowerW == null && ratedHeatingCapacityW == null) {
          // last resort: parse a power-like token from the device name and treat it as heating capacity class
          const namePowerW = parsePowerFromTextW(device.name);
          if (namePowerW != null) {
            ratedHeatingCapacityW = namePowerW;
            ratedInputPowerW = ratedHeatingCapacityW / 3.2;
            pushWarning(warnings, device, 'assumed_capacity', 'No capacity/input fields found; inferred heating capacity from device name');
            pushWarning(warnings, device, 'assumed_input_power', 'No input power found; inferred from name-derived capacity using COP 3.2');
          }
        }
        if (ratedInputPowerW == null) {
          pushWarning(warnings, device, 'missing_fields', 'air_to_air_heat_pump_inverter requires rated_input_power_w or a capacity field/name');
          return null;
        }
        if (ratedHeatingCapacityW == null) {
          ratedHeatingCapacityW = ratedInputPowerW * 3;
          pushWarning(warnings, device, 'assumed_capacity', 'No heating capacity found; assuming 3x input power');
        }
        if (setpointC == null) {
          setpointC = defaults?.defaultSetpointC ?? 21;
        }
        const minInputPowerW =
          readPowerWWithAliases(fv, {
            wKeys: ['min_input_power_w', 'minimum_input_power_w'],
            kwKeys: ['min_input_power_kw', 'minimum_input_power_kw'],
            nameText: null,
            allowNameFallback: false,
            min: 0,
            allowZero: true,
          }) ?? 0;

        const onWindows =
          minuteWindowsFromFieldValues(fv) ??
          [{ startMinute: 7 * 60, endMinute: 23 * 60 }];
        const hpProfiles = defaults?.heatPumpProfilesByDeviceId?.[device.id];

        return createDeviceRuntime(device.id, modelKey, {
          roomKey: resolveRoomKey(device, fv, defaults),
          ratedInputPowerW: ratedInputPowerW * quantity,
          ratedHeatingCapacityW: ratedHeatingCapacityW * quantity,
          minInputPowerW: minInputPowerW * quantity,
          setpointC,
          deadbandC: readNumber(fv, ['deadband_c'], { min: 0.05 }) ?? 0.6,
          minOnSeconds: readNumber(fv, ['min_on_seconds'], { min: 0, allowZero: true }) ?? 300,
          minOffSeconds: readNumber(fv, ['min_off_seconds'], { min: 0, allowZero: true }) ?? 300,
          onWindows,
          outdoorCutoffC: readNumber(fv, ['outdoor_cutoff_c'], { allowZero: true }) ?? undefined,
          copAt7C: readNumber(fv, ['cop_at_7c'], { min: 0.5 }) ?? 4,
          copSlopePerC: readNumber(fv, ['cop_slope_per_c'], { allowZero: true }) ?? 0.06,
          copMin: readNumber(fv, ['cop_min'], { min: 0.5 }) ?? 1.2,
          copMax: readNumber(fv, ['cop_max'], { min: 0.5 }) ?? 6,
          capacitySlopePerC: readNumber(fv, ['capacity_slope_per_c'], { allowZero: true }) ?? 0.015,
          capacityMinFactor: readNumber(fv, ['capacity_min_factor'], { min: 0.2 }) ?? 0.5,
          capacityMaxFactor: readNumber(fv, ['capacity_max_factor'], { min: 0.2 }) ?? 1.4,
          copCapacityCurvePoints: hpProfiles?.copCapacityCurvePoints,
          heatingPerformanceSurfacePoints: hpProfiles?.heatingPerformanceSurfacePoints,
        });
      }

      case 'fridge_freezer_compressor': {
        const ratedPowerW = readNumber(fv, ['rated_power_w', 'compressor_power_w'], { min: 1 });
        const coolingCapacityW = readNumber(fv, ['cooling_capacity_w'], { min: 1 });
        const setpointC = readNumber(fv, ['setpoint_c', 'thermostat_setpoint_c'], { allowZero: true });
        if (ratedPowerW == null || coolingCapacityW == null || setpointC == null) {
          pushWarning(warnings, device, 'missing_fields', 'fridge_freezer_compressor requires rated_power_w, cooling_capacity_w, setpoint_c');
          return null;
        }
        return createDeviceRuntime(device.id, modelKey, {
          ratedPowerW: ratedPowerW * quantity,
          coolingCapacityW: coolingCapacityW * quantity,
          setpointC,
          deadbandC: readNumber(fv, ['deadband_c'], { min: 0.1 }) ?? 2,
          minOnSeconds: readNumber(fv, ['min_on_seconds'], { min: 0, allowZero: true }) ?? 120,
          minOffSeconds: readNumber(fv, ['min_off_seconds'], { min: 0, allowZero: true }) ?? 120,
          thermalMassJPerC: readNumber(fv, ['thermal_mass_j_per_c'], { min: 1 }) ?? 80000,
          uaWPerK: readNumber(fv, ['ua_w_per_k'], { min: 0, allowZero: true }) ?? 2.5,
          ambientRoomKey: resolveRoomKey(device, fv, defaults),
          ambientTempC: readNumber(fv, ['ambient_temp_c'], { allowZero: true }) ?? 21,
          doorOpenEventsPerDay: readNumber(fv, ['door_open_events_per_day'], { min: 0, allowZero: true }) ?? 12,
          doorOpenHeatGainW: readNumber(fv, ['door_open_heat_gain_w'], { min: 0, allowZero: true }) ?? 80,
          doorOpenDurationSeconds: readNumber(fv, ['door_open_duration_seconds'], { min: 0, allowZero: true }) ?? 20,
        });
      }

      case 'event_appliance': {
        const cycle = readArray<Record<string, unknown>>(fv, ['cycle_stages', 'cycle'])?.map(stage => {
          const rec = asRecord(stage);
          return {
            durationSeconds: readNumber(rec, ['duration_seconds', 'durationSeconds'], { min: 1 }) ?? 0,
            powerW: readNumber(rec, ['power_w', 'powerW'], { min: 0, allowZero: true }) ?? 0,
            heatToRoomFraction: readNumber(rec, ['heat_to_room_fraction', 'heatToRoomFraction'], { min: 0, allowZero: true }) ?? undefined,
          };
        }).filter(s => s.durationSeconds > 0);

        const fallbackPowerW = readPowerWWithAliases(fv, {
          wKeys: ['rated_power_w', 'power_w', 'nominal_power_w', 'max_power_w', 'charging_power_w'],
          kwKeys: ['rated_power_kw', 'power_kw', 'nominal_power_kw', 'charging_power_kw', 'max_power_kw'],
          nameText: device.name,
          allowNameFallback: true,
          min: 1,
        });
        const fallbackDurationSec = estimateCycleDurationSecondsForEventLikeDevice(device, fv, fallbackPowerW);

        const normalizedCycle =
          cycle && cycle.length > 0
            ? cycle
            : (fallbackPowerW != null && fallbackDurationSec > 0
              ? [{ durationSeconds: fallbackDurationSec, powerW: fallbackPowerW * quantity }]
              : null);

        if (!normalizedCycle) {
          pushWarning(warnings, device, 'missing_cycle', 'event_appliance requires cycle_stages or rated_power_w + duration');
          return null;
        }
        if ((!cycle || cycle.length === 0) && fallbackPowerW != null) {
          pushWarning(warnings, device, 'assumed_cycle', `Built single-stage cycle from rated_power_w (${Math.round(fallbackDurationSec / 60)} min assumed duration)`);
        }
        if ((!cycle || cycle.length === 0) &&
            readNumber(fv, ['rated_power_w', 'power_w', 'nominal_power_w', 'max_power_w', 'charging_power_w'], { min: 1 }) == null &&
            readNumber(fv, ['rated_power_kw', 'power_kw', 'nominal_power_kw', 'charging_power_kw', 'max_power_kw'], { min: 0.001 }) == null &&
            fallbackPowerW != null) {
          pushWarning(warnings, device, 'assumed_power_from_name', `Using ${Math.round(fallbackPowerW)}W inferred from device name`);
        }

        return createDeviceRuntime(device.id, modelKey, {
          eventsPerDayMean: readNumber(fv, ['events_per_day_mean', 'uses_per_day', 'sessions_per_day'], { min: 0, allowZero: true }) ?? 1,
          allowedWindows: minuteWindowsFromFieldValues(fv),
          occupancyRequired: readBoolean(fv, ['occupancy_required']) ?? false,
          cooldownSeconds: readNumber(fv, ['cooldown_seconds'], { min: 0, allowZero: true }) ?? 0,
          maxStartsPerDay: readNumber(fv, ['max_starts_per_day'], { min: 0, allowZero: true }) ?? undefined,
          cycle: normalizedCycle,
        });
      }

      default:
        pushWarning(warnings, device, 'unsupported_model_key', `Unsupported simulation_model_key: ${String(modelKey)}`);
        return null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushWarning(warnings, device, 'param_validation_failed', message);
    return null;
  }
}

export function buildDeviceRuntimesFromAssignments(
  assignments: SimulatorAssignmentRow[],
  defaults?: DeviceBindingDefaults,
): DeviceBindingResult {
  const devices: DeviceRuntime[] = [];
  const warnings: DeviceBindingWarning[] = [];

  for (const assignment of assignments) {
    const device = assignment.device_instances;
    if (!device) continue;
    const quantity = Math.max(1, Math.trunc(Number(assignment.quantity ?? 1) || 1));
    const runtime = buildRuntimeForDevice(device, quantity, defaults, warnings);
    if (runtime) devices.push(runtime);
  }

  return { devices, warnings };
}
