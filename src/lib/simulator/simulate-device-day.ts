import {
  SeededRng,
  stepDeviceFleet,
  type DeviceModelKey,
  type DeviceRuntime,
  type OccupancyState,
  type SimulationStepContext,
} from './device-models';

export type PowerCategory = 'base' | 'heating' | 'shiftable' | 'fixedActive';

export interface DeviceDayCategoryResolver {
  getCategory: (deviceId: string, modelKey: DeviceModelKey) => PowerCategory;
  getHeatRoomKey?: (device: DeviceRuntime) => string;
}

export interface SimulateDeviceDayInputs {
  devices: DeviceRuntime[];
  outdoorTempC: number;
  initialIndoorTempC: number;
  uaWPerK: number;
  thermalMassJPerC?: number;
  dtSeconds?: number; // internal step, defaults to 300s
  outputStepSeconds?: number; // chart step, defaults to 900s
  dayIndex?: number;
  dayOfWeek?: number; // 0=Sun
  seed?: number;
  occupancySchedule?: Array<{
    startMinute: number;
    endMinute: number;
    occupancy: OccupancyState;
  }>;
  roomKeys?: string[];
  categorizer: DeviceDayCategoryResolver;
}

export interface DeviceDayPoint {
  time: string;
  total: number;
  heating: number;
  shiftable: number;
  fixedActive: number;
  base: number;
}

export interface SimulateDeviceDayResult {
  timeseries: DeviceDayPoint[];
  dailyKwh: number;
  peakW: number;
  avgW: number;
  finalRoomTempsC: Record<string, number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timeLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function occupancyAtMinute(
  minuteOfDay: number,
  schedule?: SimulateDeviceDayInputs['occupancySchedule'],
): OccupancyState {
  if (!schedule || schedule.length === 0) return 'home';
  for (const window of schedule) {
    if (window.startMinute <= window.endMinute) {
      if (minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute) return window.occupancy;
    } else {
      if (minuteOfDay >= window.startMinute || minuteOfDay < window.endMinute) return window.occupancy;
    }
  }
  return 'home';
}

function inferRoomKeyFromDevice(device: DeviceRuntime, fallback = 'default_room'): string {
  const params = device.params && typeof device.params === 'object' ? (device.params as Record<string, unknown>) : {};
  const roomKey = typeof params.roomKey === 'string' ? params.roomKey : undefined;
  const ambientRoomKey = typeof params.ambientRoomKey === 'string' ? params.ambientRoomKey : undefined;
  return roomKey || ambientRoomKey || fallback;
}

function buildRoomKeys(inputs: SimulateDeviceDayInputs): string[] {
  const explicit = (inputs.roomKeys || []).filter(Boolean);
  const inferred = inputs.devices.map(d => inferRoomKeyFromDevice(d));
  const keys = [...new Set([...explicit, ...inferred, 'default_room'])];
  return keys;
}

function aggregateOutputStep(points: Array<{ minuteOfDay: number } & Omit<DeviceDayPoint, 'time'>>): DeviceDayPoint {
  const n = Math.max(1, points.length);
  const avg = (key: keyof Omit<DeviceDayPoint, 'time'>) => points.reduce((s, p) => s + p[key], 0) / n;
  const firstMinute = points[0]?.minuteOfDay ?? 0;
  return {
    time: timeLabel(firstMinute),
    total: avg('total'),
    heating: avg('heating'),
    shiftable: avg('shiftable'),
    fixedActive: avg('fixedActive'),
    base: avg('base'),
  };
}

export function simulateDeviceDay(inputs: SimulateDeviceDayInputs): SimulateDeviceDayResult {
  const dtSeconds = inputs.dtSeconds ?? 300;
  const outputStepSeconds = inputs.outputStepSeconds ?? 900;
  const steps = Math.floor(86400 / dtSeconds);
  const stepsPerOutput = Math.max(1, Math.round(outputStepSeconds / dtSeconds));
  const rng = new SeededRng(inputs.seed ?? 12345);
  const roomKeys = buildRoomKeys(inputs);
  const thermalMassJPerC = Math.max(100_000, inputs.thermalMassJPerC ?? 8_000_000);
  const roomThermalMass = thermalMassJPerC / roomKeys.length;
  const roomUa = Math.max(0, inputs.uaWPerK) / roomKeys.length;

  let devices = inputs.devices;
  let roomTempsC: Record<string, number> = Object.fromEntries(roomKeys.map(k => [k, inputs.initialIndoorTempC]));
  const microPoints: Array<{ minuteOfDay: number } & Omit<DeviceDayPoint, 'time'>> = [];

  for (let stepIndex = 0; stepIndex < steps; stepIndex++) {
    const minuteOfDay = Math.floor((stepIndex * dtSeconds) / 60) % 1440;
    const occupancy = occupancyAtMinute(minuteOfDay, inputs.occupancySchedule);

    const ctx: SimulationStepContext = {
      clock: {
        stepIndex,
        dtSeconds,
        minuteOfDay,
        dayOfWeek: inputs.dayOfWeek ?? 1,
        dayIndex: inputs.dayIndex ?? 0,
      },
      inputs: {
        outdoorTempC: inputs.outdoorTempC,
        occupancy,
        roomTempsC,
        roomUaWPerK: Object.fromEntries(roomKeys.map(k => [k, roomUa])),
      },
      rng,
    };

    const fleet = stepDeviceFleet(devices, ctx);
    devices = fleet.nextDevices;

    let base = 0;
    let heating = 0;
    let shiftable = 0;
    let fixedActive = 0;
    const heatByRoom: Record<string, number> = Object.fromEntries(roomKeys.map(k => [k, 0]));

    const currentDeviceMap = new Map(devices.map(d => [d.id, d] as const));
    for (const out of fleet.deviceOutputs) {
      const category = inputs.categorizer.getCategory(out.id, out.modelKey);
      if (category === 'base') base += out.powerW;
      else if (category === 'heating') heating += out.powerW;
      else if (category === 'shiftable') shiftable += out.powerW;
      else fixedActive += out.powerW;

      if ((out.heatToRoomW ?? 0) > 0) {
        const device = currentDeviceMap.get(out.id);
        const roomKey = device
          ? (inputs.categorizer.getHeatRoomKey?.(device) ?? inferRoomKeyFromDevice(device))
          : 'default_room';
        heatByRoom[roomKey] = (heatByRoom[roomKey] ?? 0) + (out.heatToRoomW ?? 0);
      }
    }

    // Update room temperatures after device outputs (simple independent 1R1C per room).
    const nextTemps: Record<string, number> = {};
    for (const roomKey of roomKeys) {
      const currentTempC = roomTempsC[roomKey] ?? inputs.initialIndoorTempC;
      const heatInW = heatByRoom[roomKey] ?? 0;
      const lossW = roomUa * (currentTempC - inputs.outdoorTempC);
      const deltaC = ((heatInW - lossW) * dtSeconds) / roomThermalMass;
      nextTemps[roomKey] = clamp(currentTempC + deltaC, -30, 45);
    }
    roomTempsC = nextTemps;

    microPoints.push({
      minuteOfDay,
      base,
      heating,
      shiftable,
      fixedActive,
      total: base + heating + shiftable + fixedActive,
    });
  }

  const timeseries: DeviceDayPoint[] = [];
  for (let i = 0; i < microPoints.length; i += stepsPerOutput) {
    timeseries.push(aggregateOutputStep(microPoints.slice(i, i + stepsPerOutput)));
  }

  const totalWh = microPoints.reduce((s, p) => s + p.total * (dtSeconds / 3600), 0);
  const avgW = microPoints.length > 0 ? microPoints.reduce((s, p) => s + p.total, 0) / microPoints.length : 0;
  const peakW = microPoints.length > 0 ? Math.max(...microPoints.map(p => p.total)) : 0;

  return {
    timeseries,
    dailyKwh: Math.round((totalWh / 1000) * 10) / 10,
    peakW,
    avgW: Math.round(avgW),
    finalRoomTempsC: roomTempsC,
  };
}
