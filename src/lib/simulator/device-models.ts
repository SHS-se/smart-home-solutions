import { z } from 'zod';
import {
  interpolateCurve,
  interpolateSurface,
  type CurvePoint,
  type SurfacePoint,
} from '@/lib/performance-data';

export type OccupancyState = 'home' | 'away' | 'sleep' | 'unknown';

export interface SimulationClock {
  stepIndex: number;
  dtSeconds: number;
  minuteOfDay: number; // 0..1439 local time
  dayOfWeek: number; // 0=Sun..6=Sat
  dayIndex: number; // increments each simulated day
}

export interface SimulationInputs {
  outdoorTempC: number;
  occupancy: OccupancyState;
  roomTempsC?: Record<string, number>;
  roomUaWPerK?: Record<string, number>;
}

export interface SimulationStepContext {
  clock: SimulationClock;
  inputs: SimulationInputs;
  rng: SeededRng;
}

export interface DeviceStepOutput<TState> {
  state: TState;
  powerW: number;
  heatToRoomW?: number;
}

export interface DeviceModel<TParams, TState> {
  key: DeviceModelKey;
  parseParams: (raw: unknown) => TParams;
  initState: (params: TParams) => TState;
  step: (params: TParams, state: TState, ctx: SimulationStepContext) => DeviceStepOutput<TState>;
}

export type DeviceModelKey =
  | 'fixed_baseload'
  | 'electric_resistive_thermostat'
  | 'air_to_air_heat_pump_inverter'
  | 'fridge_freezer_compressor'
  | 'event_appliance';

export interface DeviceRuntime<TParams = unknown, TState = unknown> {
  id: string;
  modelKey: DeviceModelKey;
  params: TParams;
  state: TState;
}

const nonNegative = z.number().finite().min(0);
const positive = z.number().finite().gt(0);

const minuteWindowSchema = z.object({
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  weight: positive.optional(),
});

export type MinuteWindow = z.infer<typeof minuteWindowSchema>;

const occupancyMultiplierSchema = z
  .object({
    home: positive.optional(),
    away: positive.optional(),
    sleep: positive.optional(),
    unknown: positive.optional(),
  })
  .partial()
  .default({});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function normalizePowerW(powerW: number): number {
  if (!isFiniteNumber(powerW) || powerW < 0) return 0;
  return powerW;
}

function normalizeHeatW(heatW: number | undefined): number | undefined {
  if (heatW === undefined) return undefined;
  if (!isFiniteNumber(heatW)) return 0;
  return heatW;
}

function occupancyMultiplier(mult: Partial<Record<OccupancyState, number>> | undefined, state: OccupancyState): number {
  if (!mult) return 1;
  return mult[state] ?? 1;
}

function sameDayReset(stateDayIndex: number, currentDayIndex: number): boolean {
  return stateDayIndex !== currentDayIndex;
}

function windowMatches(window: MinuteWindow, clock: SimulationClock): boolean {
  const dayOk = !window.daysOfWeek || window.daysOfWeek.includes(clock.dayOfWeek);
  if (!dayOk) return false;
  const m = clock.minuteOfDay;
  if (window.startMinute <= window.endMinute) {
    return m >= window.startMinute && m < window.endMinute;
  }
  // Cross-midnight window, e.g. 22:00 -> 07:00
  return m >= window.startMinute || m < window.endMinute;
}

function activeWindowWeight(windows: MinuteWindow[] | undefined, clock: SimulationClock): number {
  if (!windows || windows.length === 0) return 1;
  return windows
    .filter(w => windowMatches(w, clock))
    .reduce((sum, w) => sum + (w.weight ?? 1), 0);
}

function totalWindowWeightForDay(windows: MinuteWindow[] | undefined, dayOfWeek: number): number {
  if (!windows || windows.length === 0) return 1440;
  let total = 0;
  for (const w of windows) {
    if (w.daysOfWeek && !w.daysOfWeek.includes(dayOfWeek)) continue;
    const duration =
      w.startMinute <= w.endMinute
        ? w.endMinute - w.startMinute
        : 1440 - w.startMinute + w.endMinute;
    total += duration * (w.weight ?? 1);
  }
  return total > 0 ? total : 1440;
}

function thermostatThresholds(setpointC: number, deadbandC: number): { lowerC: number; upperC: number } {
  const half = deadbandC / 2;
  return { lowerC: setpointC - half, upperC: setpointC + half };
}

function nextOnOffState(args: {
  isEnabled: boolean;
  currentTempC: number | undefined;
  lowerC: number;
  upperC: number;
  isOn: boolean;
  secondsInState: number;
  minOnSeconds: number;
  minOffSeconds: number;
}): boolean {
  const {
    isEnabled, currentTempC, lowerC, upperC, isOn, secondsInState, minOnSeconds, minOffSeconds,
  } = args;

  if (!isEnabled) return false;
  if (currentTempC == null || !isFiniteNumber(currentTempC)) return false;

  if (isOn) {
    if (secondsInState < minOnSeconds) return true;
    return currentTempC <= upperC;
  }

  if (secondsInState < minOffSeconds) return false;
  return currentTempC < lowerC;
}

function nextCoolingCompressorState(args: {
  isEnabled: boolean;
  currentTempC: number | undefined;
  lowerC: number;
  upperC: number;
  isOn: boolean;
  secondsInState: number;
  minOnSeconds: number;
  minOffSeconds: number;
}): boolean {
  const {
    isEnabled, currentTempC, lowerC, upperC, isOn, secondsInState, minOnSeconds, minOffSeconds,
  } = args;

  if (!isEnabled) return false;
  if (currentTempC == null || !isFiniteNumber(currentTempC)) return false;

  if (isOn) {
    if (secondsInState < minOnSeconds) return true;
    return currentTempC >= lowerC;
  }

  if (secondsInState < minOffSeconds) return false;
  return currentTempC > upperC;
}

export class SeededRng {
  private state: number;

  constructor(seed: number) {
    const normalized = Math.floor(seed) || 1;
    this.state = normalized >>> 0;
    if (this.state === 0) this.state = 1;
  }

  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  chance(probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return this.next() < probability;
  }

  pickWeighted<T>(items: Array<{ value: T; weight: number }>): T | null {
    const positiveItems = items.filter(i => i.weight > 0 && isFiniteNumber(i.weight));
    if (positiveItems.length === 0) return null;
    const total = positiveItems.reduce((s, i) => s + i.weight, 0);
    let r = this.next() * total;
    for (const item of positiveItems) {
      r -= item.weight;
      if (r <= 0) return item.value;
    }
    return positiveItems[positiveItems.length - 1].value;
  }
}

// 1) Fixed baseload
const fixedBaseloadParamsSchema = z.object({
  powerW: nonNegative,
  occupancyMultiplier: occupancyMultiplierSchema.optional(),
});

export type FixedBaseloadParams = z.infer<typeof fixedBaseloadParamsSchema>;
export interface FixedBaseloadState {}

export const fixedBaseloadModel: DeviceModel<FixedBaseloadParams, FixedBaseloadState> = {
  key: 'fixed_baseload',
  parseParams: raw => fixedBaseloadParamsSchema.parse(raw),
  initState: () => ({}),
  step: (params, state, ctx) => {
    const mult = occupancyMultiplier(params.occupancyMultiplier, ctx.inputs.occupancy);
    return { state, powerW: normalizePowerW(params.powerW * mult) };
  },
};

// 2) Electric resistive thermostat
const electricResistiveThermostatParamsSchema = z.object({
  roomKey: z.string().min(1),
  ratedPowerW: positive,
  setpointC: z.number().finite(),
  deadbandC: positive.max(10).default(0.4),
  minOnSeconds: nonNegative.default(0),
  minOffSeconds: nonNegative.default(0),
  heatToRoomFraction: z.number().finite().min(0).max(1.2).default(1),
  scheduleWindows: z.array(minuteWindowSchema).optional(),
});

export type ElectricResistiveThermostatParams = z.infer<typeof electricResistiveThermostatParamsSchema>;

export interface ElectricResistiveThermostatState {
  isOn: boolean;
  secondsInState: number;
}

export const electricResistiveThermostatModel: DeviceModel<
  ElectricResistiveThermostatParams,
  ElectricResistiveThermostatState
> = {
  key: 'electric_resistive_thermostat',
  parseParams: raw => electricResistiveThermostatParamsSchema.parse(raw),
  initState: () => ({ isOn: false, secondsInState: 0 }),
  step: (params, state, ctx) => {
    const roomTempC = ctx.inputs.roomTempsC?.[params.roomKey];
    const { lowerC, upperC } = thermostatThresholds(params.setpointC, params.deadbandC);
    const enabled = activeWindowWeight(params.scheduleWindows, ctx.clock) > 0;
    const nextIsOn = nextOnOffState({
      isEnabled: enabled,
      currentTempC: roomTempC,
      lowerC,
      upperC,
      isOn: state.isOn,
      secondsInState: state.secondsInState,
      minOnSeconds: params.minOnSeconds,
      minOffSeconds: params.minOffSeconds,
    });

    const transitioned = nextIsOn !== state.isOn;
    const nextState: ElectricResistiveThermostatState = {
      isOn: nextIsOn,
      secondsInState: transitioned ? 0 : state.secondsInState + ctx.clock.dtSeconds,
    };

    const powerW = nextIsOn ? params.ratedPowerW : 0;
    return {
      state: nextState,
      powerW,
      heatToRoomW: nextIsOn ? params.ratedPowerW * params.heatToRoomFraction : 0,
    };
  },
};

// 3) Air-to-air heat pump in "dumb" mode (manual schedule + thermostat)
const airToAirHeatPumpDumbParamsSchema = z.object({
  roomKey: z.string().min(1),
  ratedInputPowerW: positive,
  ratedHeatingCapacityW: positive,
  minInputPowerW: nonNegative.default(0),
  setpointC: z.number().finite(),
  deadbandC: positive.max(10).default(0.6),
  minOnSeconds: nonNegative.default(300),
  minOffSeconds: nonNegative.default(300),
  onWindows: z.array(minuteWindowSchema).min(1),
  outdoorCutoffC: z.number().finite().optional(), // optional warm cutoff for heating season
  copAt7C: positive.default(4),
  copSlopePerC: z.number().finite().default(0.06), // COP drops as temp falls
  copMin: positive.default(1.2),
  copMax: positive.default(6),
  capacitySlopePerC: z.number().finite().default(0.015), // +1.5% per C from 7C reference
  capacityMinFactor: z.number().finite().min(0.2).max(2).default(0.5),
  capacityMaxFactor: z.number().finite().min(0.2).max(3).default(1.4),
  modulationTempGainPerC: nonNegative.default(1200), // extra requested heat per C below setpoint
  partLoadCopBoostMax: z.number().finite().min(0).max(0.5).default(0.1),
  startupBoostSeconds: nonNegative.default(600),
  startupPowerMultiplier: z.number().finite().min(1).max(3).default(1.6),
  startupHeatMultiplier: z.number().finite().min(0.2).max(2).default(0.9),
  copCapacityCurvePoints: z.array(z.object({
    temp_c: z.number().finite(),
    cop: z.number().finite(),
    capacity_w: z.number().finite(),
  })).optional(),
  heatingPerformanceSurfacePoints: z.array(z.object({
    indoor_temp_c: z.number().finite(),
    temp_c: z.number().finite(),
    capacity_w: z.number().finite(),
    input_power_w: z.number().finite(),
  })).optional(),
});

export type AirToAirHeatPumpDumbParams = z.infer<typeof airToAirHeatPumpDumbParamsSchema>;

export interface AirToAirHeatPumpDumbState {
  isOn: boolean;
  secondsInState: number;
  startupRemainingSeconds: number;
}

function heatPumpPerformanceGeneric(params: AirToAirHeatPumpDumbParams, outdoorTempC: number): { inputPowerW: number; heatW: number } {
  const cop = clamp(
    params.copAt7C + (outdoorTempC - 7) * params.copSlopePerC,
    params.copMin,
    params.copMax,
  );
  const capacityFactor = clamp(
    1 + (outdoorTempC - 7) * params.capacitySlopePerC,
    params.capacityMinFactor,
    params.capacityMaxFactor,
  );
  const heatW = params.ratedHeatingCapacityW * capacityFactor;
  const inputPowerByCop = heatW / cop;
  const inputPowerW = clamp(inputPowerByCop, 0, params.ratedInputPowerW * 1.25);
  return { inputPowerW, heatW };
}

type HeatPumpPerfSource = 'surface' | 'curve' | 'generic';

function resolveHeatPumpPerformance(
  params: AirToAirHeatPumpDumbParams,
  outdoorTempC: number,
  indoorTempC: number,
): { inputPowerW: number; heatW: number; source: HeatPumpPerfSource } {
  const surfacePts = params.heatingPerformanceSurfacePoints as SurfacePoint[] | undefined;
  if (surfacePts && surfacePts.length >= 2) {
    const r = interpolateSurface(surfacePts, indoorTempC, outdoorTempC);
    if (r && Number.isFinite(r.capacityW) && Number.isFinite(r.inputPowerW)) {
      return {
        inputPowerW: clamp(r.inputPowerW, 0, params.ratedInputPowerW * 1.25),
        heatW: Math.max(0, r.capacityW),
        source: 'surface',
      };
    }
  }

  const curvePts = params.copCapacityCurvePoints as CurvePoint[] | undefined;
  if (curvePts && curvePts.length >= 2) {
    const r = interpolateCurve(curvePts, outdoorTempC);
    if (r && Number.isFinite(r.capacityW) && Number.isFinite(r.cop) && r.cop > 0) {
      return {
        inputPowerW: clamp(r.capacityW / r.cop, 0, params.ratedInputPowerW * 1.25),
        heatW: Math.max(0, r.capacityW),
        source: 'curve',
      };
    }
  }

  return { ...heatPumpPerformanceGeneric(params, outdoorTempC), source: 'generic' };
}

export const airToAirHeatPumpDumbModel: DeviceModel<AirToAirHeatPumpDumbParams, AirToAirHeatPumpDumbState> = {
  key: 'air_to_air_heat_pump_inverter',
  parseParams: raw => airToAirHeatPumpDumbParamsSchema.parse(raw),
  initState: () => ({ isOn: false, secondsInState: 0, startupRemainingSeconds: 0 }),
  step: (params, state, ctx) => {
    const roomTempC = ctx.inputs.roomTempsC?.[params.roomKey];
    const roomUaWPerK = ctx.inputs.roomUaWPerK?.[params.roomKey] ?? 0;
    const { lowerC, upperC } = thermostatThresholds(params.setpointC, params.deadbandC);
    const scheduleEnabled = activeWindowWeight(params.onWindows, ctx.clock) > 0;
    const seasonEnabled = params.outdoorCutoffC == null ? true : ctx.inputs.outdoorTempC < params.outdoorCutoffC;
    const nextIsOn = nextOnOffState({
      isEnabled: scheduleEnabled && seasonEnabled,
      currentTempC: roomTempC,
      lowerC,
      upperC,
      isOn: state.isOn,
      secondsInState: state.secondsInState,
      minOnSeconds: params.minOnSeconds,
      minOffSeconds: params.minOffSeconds,
    });

    const transitioned = nextIsOn !== state.isOn;
    const nextState: AirToAirHeatPumpDumbState = {
      isOn: nextIsOn,
      secondsInState: transitioned ? 0 : state.secondsInState + ctx.clock.dtSeconds,
      startupRemainingSeconds: transitioned && nextIsOn
        ? params.startupBoostSeconds
        : Math.max(0, state.startupRemainingSeconds - ctx.clock.dtSeconds),
    };

    if (!nextIsOn) {
      return { state: nextState, powerW: 0, heatToRoomW: 0 };
    }

    const perfMax = resolveHeatPumpPerformance(
      params,
      ctx.inputs.outdoorTempC,
      params.setpointC,
    );
    const maxHeatW = Math.max(0, perfMax.heatW);
    const maxInputW = Math.max(1, perfMax.inputPowerW);
    const fullLoadCop = maxHeatW / maxInputW;
    const minInputW = clamp(
      params.minInputPowerW > 0 ? params.minInputPowerW : params.ratedInputPowerW * 0.15,
      0,
      maxInputW,
    );
    const minFracByInput = maxInputW > 0 ? minInputW / maxInputW : 0;

    const effectiveRoomTempC = roomTempC ?? params.setpointC;
    const tempErrorC = params.setpointC - effectiveRoomTempC;
    const holdHeatDemandW = roomUaWPerK > 0
      ? Math.max(0, roomUaWPerK * Math.max(0, params.setpointC - ctx.inputs.outdoorTempC))
      : maxHeatW;
    const recoveryHeatDemandW = Math.max(0, tempErrorC) * params.modulationTempGainPerC;
    const trimHeatDemandW = Math.max(0, -tempErrorC) * (params.modulationTempGainPerC * 0.7);
    const requestedHeatW = clamp(holdHeatDemandW + recoveryHeatDemandW - trimHeatDemandW, 0, maxHeatW);

    // Convert requested heat to a compressor fraction. Keep a minimum running level while ON.
    const requestedFrac = maxHeatW > 0 ? requestedHeatW / maxHeatW : 0;
    const compressorFrac = clamp(
      requestedFrac <= 0 ? minFracByInput : Math.max(minFracByInput, requestedFrac),
      0,
      1,
    );
    const modulationFrac = compressorFrac <= minFracByInput
      ? 0
      : (compressorFrac - minFracByInput) / Math.max(1e-6, 1 - minFracByInput);

    // Mild part-load COP gain for inverter operation.
    const partLoadCopBoost = params.partLoadCopBoostMax * (1 - compressorFrac);
    const effectiveCop = fullLoadCop * (1 + partLoadCopBoost);
    let inputPowerW = minInputW + (maxInputW - minInputW) * modulationFrac;
    let heatW = inputPowerW * effectiveCop;

    // Respect max heating capacity at the current outdoor temperature.
    if (heatW > maxHeatW) {
      heatW = maxHeatW;
      inputPowerW = heatW / Math.max(0.5, effectiveCop);
    }

    // Startup transient: short higher electrical draw, with lower effective COP.
    if (nextState.startupRemainingSeconds > 0) {
      inputPowerW = Math.min(params.ratedInputPowerW * 1.25, inputPowerW * params.startupPowerMultiplier);
      heatW = Math.min(maxHeatW, heatW * params.startupHeatMultiplier);
    }

    return {
      state: nextState,
      powerW: normalizePowerW(inputPowerW),
      heatToRoomW: normalizeHeatW(heatW),
    };
  },
};

// 4) Fridge/freezer compressor (internal thermostat + door-open disturbances)
const fridgeFreezerCompressorParamsSchema = z.object({
  ratedPowerW: positive,
  coolingCapacityW: positive, // heat removed from cabinet while compressor is on
  setpointC: z.number().finite(),
  deadbandC: positive.max(20).default(2),
  minOnSeconds: nonNegative.default(120),
  minOffSeconds: nonNegative.default(120),
  thermalMassJPerC: positive.default(80000),
  uaWPerK: nonNegative.default(2.5), // heat leak from ambient to cabinet
  ambientRoomKey: z.string().optional(),
  ambientTempC: z.number().finite().default(21),
  doorOpenEventsPerDay: nonNegative.default(12),
  doorOpenHeatGainW: nonNegative.default(80),
  doorOpenDurationSeconds: nonNegative.default(20),
});

export type FridgeFreezerCompressorParams = z.infer<typeof fridgeFreezerCompressorParamsSchema>;

export interface FridgeFreezerCompressorState {
  isOn: boolean;
  secondsInState: number;
  internalTempC: number;
  doorOpenRemainingSeconds: number;
}

export const fridgeFreezerCompressorModel: DeviceModel<FridgeFreezerCompressorParams, FridgeFreezerCompressorState> = {
  key: 'fridge_freezer_compressor',
  parseParams: raw => fridgeFreezerCompressorParamsSchema.parse(raw),
  initState: params => ({
    isOn: false,
    secondsInState: 0,
    internalTempC: params.setpointC + params.deadbandC / 2,
    doorOpenRemainingSeconds: 0,
  }),
  step: (params, state, ctx) => {
    const ambientC = params.ambientRoomKey
      ? (ctx.inputs.roomTempsC?.[params.ambientRoomKey] ?? params.ambientTempC)
      : params.ambientTempC;

    const dt = ctx.clock.dtSeconds;
    const stepProb = params.doorOpenEventsPerDay * (dt / 86400);
    const startDoorOpen = state.doorOpenRemainingSeconds <= 0 && ctx.inputs.occupancy !== 'away' && ctx.rng.chance(stepProb);
    const doorOpenRemainingSeconds = startDoorOpen
      ? params.doorOpenDurationSeconds
      : Math.max(0, state.doorOpenRemainingSeconds - dt);

    const { lowerC, upperC } = thermostatThresholds(params.setpointC, params.deadbandC);
    const nextIsOn = nextCoolingCompressorState({
      isEnabled: true,
      currentTempC: state.internalTempC,
      lowerC,
      upperC,
      isOn: state.isOn,
      secondsInState: state.secondsInState,
      minOnSeconds: params.minOnSeconds,
      minOffSeconds: params.minOffSeconds,
    });

    const leakHeatW = params.uaWPerK * (ambientC - state.internalTempC);
    const doorHeatW = doorOpenRemainingSeconds > 0 ? params.doorOpenHeatGainW : 0;
    const coolingW = nextIsOn ? params.coolingCapacityW : 0;
    const netHeatToCabinetW = leakHeatW + doorHeatW - coolingW;
    const deltaC = (netHeatToCabinetW * dt) / params.thermalMassJPerC;
    const nextInternalTempC = state.internalTempC + deltaC;

    const transitioned = nextIsOn !== state.isOn;
    const nextState: FridgeFreezerCompressorState = {
      isOn: nextIsOn,
      secondsInState: transitioned ? 0 : state.secondsInState + dt,
      internalTempC: nextInternalTempC,
      doorOpenRemainingSeconds,
    };

    return {
      state: nextState,
      powerW: nextIsOn ? params.ratedPowerW : 0,
      // Fridge rejects compressor heat + removed cabinet heat into the room
      heatToRoomW: nextIsOn ? params.ratedPowerW + coolingW : 0,
    };
  },
};

// 5) Generic event appliance (microwave, oven, kettle, dishwasher, etc.)
const eventApplianceCycleStageSchema = z.object({
  durationSeconds: positive,
  powerW: nonNegative,
  heatToRoomFraction: z.number().finite().min(0).max(1.2).optional(),
});

const eventApplianceParamsSchema = z.object({
  eventsPerDayMean: nonNegative,
  allowedWindows: z.array(minuteWindowSchema).optional(),
  occupancyRequired: z.boolean().default(false),
  occupancyMultiplier: occupancyMultiplierSchema.optional(),
  cooldownSeconds: nonNegative.default(0),
  maxStartsPerDay: z.number().int().min(0).optional(),
  cycle: z.array(eventApplianceCycleStageSchema).min(1),
});

export type EventApplianceParams = z.infer<typeof eventApplianceParamsSchema>;

export interface EventApplianceState {
  running: boolean;
  stageIndex: number;
  stageRemainingSeconds: number;
  cooldownRemainingSeconds: number;
  startsToday: number;
  lastDayIndex: number;
}

function cycleStagePower(stage: EventApplianceParams['cycle'][number]): { powerW: number; heatToRoomW: number } {
  const heatFrac = stage.heatToRoomFraction ?? 1;
  return { powerW: stage.powerW, heatToRoomW: stage.powerW * heatFrac };
}

export const eventApplianceModel: DeviceModel<EventApplianceParams, EventApplianceState> = {
  key: 'event_appliance',
  parseParams: raw => eventApplianceParamsSchema.parse(raw),
  initState: () => ({
    running: false,
    stageIndex: 0,
    stageRemainingSeconds: 0,
    cooldownRemainingSeconds: 0,
    startsToday: 0,
    lastDayIndex: 0,
  }),
  step: (params, state, ctx) => {
    const dt = ctx.clock.dtSeconds;
    const nextState: EventApplianceState = { ...state };

    if (sameDayReset(nextState.lastDayIndex, ctx.clock.dayIndex)) {
      nextState.startsToday = 0;
      nextState.lastDayIndex = ctx.clock.dayIndex;
    }

    if (nextState.cooldownRemainingSeconds > 0) {
      nextState.cooldownRemainingSeconds = Math.max(0, nextState.cooldownRemainingSeconds - dt);
    }

    // Progress a running cycle first.
    if (nextState.running) {
      nextState.stageRemainingSeconds -= dt;
      while (nextState.running && nextState.stageRemainingSeconds <= 0) {
        const overflow = -nextState.stageRemainingSeconds;
        const nextStageIndex = nextState.stageIndex + 1;
        if (nextStageIndex >= params.cycle.length) {
          nextState.running = false;
          nextState.stageIndex = 0;
          nextState.stageRemainingSeconds = 0;
          nextState.cooldownRemainingSeconds = params.cooldownSeconds;
          break;
        }
        nextState.stageIndex = nextStageIndex;
        nextState.stageRemainingSeconds = params.cycle[nextStageIndex].durationSeconds - overflow;
      }
    }

    if (!nextState.running) {
      const occupancyOk = !params.occupancyRequired || ctx.inputs.occupancy === 'home';
      const startsLeft = params.maxStartsPerDay == null || nextState.startsToday < params.maxStartsPerDay;
      const activeWeight = activeWindowWeight(params.allowedWindows, ctx.clock);
      const totalWeight = totalWindowWeightForDay(params.allowedWindows, ctx.clock.dayOfWeek);
      const weightFactor = totalWeight > 0 ? (activeWeight * 1440) / totalWeight : 0;
      const occMult = occupancyMultiplier(params.occupancyMultiplier, ctx.inputs.occupancy);
      const stepProbability = clamp(
        params.eventsPerDayMean * (dt / 86400) * weightFactor * occMult,
        0,
        1,
      );

      const canStart =
        occupancyOk &&
        startsLeft &&
        nextState.cooldownRemainingSeconds <= 0 &&
        activeWeight > 0 &&
        params.eventsPerDayMean > 0;

      if (canStart && ctx.rng.chance(stepProbability)) {
        nextState.running = true;
        nextState.stageIndex = 0;
        nextState.stageRemainingSeconds = params.cycle[0].durationSeconds;
        nextState.startsToday += 1;
      }
    }

    if (!nextState.running) {
      return { state: nextState, powerW: 0, heatToRoomW: 0 };
    }

    const stage = params.cycle[nextState.stageIndex];
    const outputs = cycleStagePower(stage);
    return {
      state: nextState,
      powerW: outputs.powerW,
      heatToRoomW: outputs.heatToRoomW,
    };
  },
};

export const deviceModelRegistry = {
  fixed_baseload: fixedBaseloadModel,
  electric_resistive_thermostat: electricResistiveThermostatModel,
  air_to_air_heat_pump_inverter: airToAirHeatPumpDumbModel,
  fridge_freezer_compressor: fridgeFreezerCompressorModel,
  event_appliance: eventApplianceModel,
} as const satisfies Record<DeviceModelKey, DeviceModel<any, any>>;

export type AnyDeviceModel = (typeof deviceModelRegistry)[DeviceModelKey];

export function parseDeviceParams<TKey extends DeviceModelKey>(
  modelKey: TKey,
  raw: unknown,
): ReturnType<(typeof deviceModelRegistry)[TKey]['parseParams']> {
  const model = deviceModelRegistry[modelKey];
  return model.parseParams(raw) as any;
}

export function createDeviceRuntime(
  id: string,
  modelKey: DeviceModelKey,
  rawParams: unknown,
): DeviceRuntime {
  const model = deviceModelRegistry[modelKey];
  const params = model.parseParams(rawParams);
  const state = model.initState(params as any);
  return { id, modelKey, params, state } as DeviceRuntime;
}

export interface FleetStepResult {
  totalPowerW: number;
  totalHeatToRoomsW: number;
  deviceOutputs: Array<{ id: string; modelKey: DeviceModelKey; powerW: number; heatToRoomW?: number }>;
  nextDevices: DeviceRuntime[];
}

export function stepDeviceFleet(
  devices: DeviceRuntime[],
  ctx: SimulationStepContext,
): FleetStepResult {
  const nextDevices: DeviceRuntime[] = [];
  const deviceOutputs: FleetStepResult['deviceOutputs'] = [];
  let totalPowerW = 0;
  let totalHeatToRoomsW = 0;

  for (const device of devices) {
    const model = deviceModelRegistry[device.modelKey];
    const out = model.step(device.params as any, device.state as any, ctx);
    const powerW = normalizePowerW(out.powerW);
    const heatToRoomW = normalizeHeatW(out.heatToRoomW);

    totalPowerW += powerW;
    totalHeatToRoomsW += heatToRoomW ?? 0;
    deviceOutputs.push({ id: device.id, modelKey: device.modelKey, powerW, heatToRoomW });
    nextDevices.push({ ...device, state: out.state });
  }

  return { totalPowerW, totalHeatToRoomsW, deviceOutputs, nextDevices };
}

export const DUMB_HOME_ARCHETYPE_KEYS: DeviceModelKey[] = [
  'fixed_baseload',
  'electric_resistive_thermostat',
  'air_to_air_heat_pump_inverter',
  'fridge_freezer_compressor',
  'event_appliance',
];
