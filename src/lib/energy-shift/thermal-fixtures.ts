import type {
  ThermalFixtureSeason,
  ThermalProjection,
  ThermalZoneProjection,
} from './contracts';

const SLOT_MS = 15 * 60_000;
const SLOT_HOURS = 0.25;
const SLOT_COUNT = 72 * 4;

interface ZoneDefinition {
  key: string;
  name: string;
  controlType: ThermalZoneProjection['control_type'];
  loadType: ThermalZoneProjection['load_type'];
  priority: number;
  ratedPowerW: number;
  minimumPowerW: number;
  heatLossWPerC: number;
  thermalCapacityWhPerC: number;
  heatingEfficiency: number;
  initialTemperatureC: number;
  occupiedStartHour: number;
  occupiedEndHour: number;
  occupiedTargetC: number;
  setbackTargetC: number;
}

const ZONES: ZoneDefinition[] = [
  {
    key: 'living-room-aircon',
    name: 'Living room aircon',
    controlType: 'setpoint',
    loadType: 'inverter',
    priority: 1,
    ratedPowerW: 2_100,
    minimumPowerW: 550,
    heatLossWPerC: 52,
    thermalCapacityWhPerC: 11_500,
    heatingEfficiency: 2.6,
    initialTemperatureC: 20.8,
    occupiedStartHour: 6,
    occupiedEndHour: 23,
    occupiedTargetC: 21,
    setbackTargetC: 18.5,
  },
  {
    key: 'bedroom-wall-heater',
    name: 'Bedroom wall heater',
    controlType: 'switch_schedule',
    loadType: 'duty_cycle',
    priority: 2,
    ratedPowerW: 1_000,
    minimumPowerW: 1_000,
    heatLossWPerC: 34,
    thermalCapacityWhPerC: 6_800,
    heatingEfficiency: 1,
    initialTemperatureC: 20.4,
    occupiedStartHour: 18,
    occupiedEndHour: 8,
    occupiedTargetC: 20.5,
    setbackTargetC: 17.5,
  },
  {
    key: 'bathroom-floor-heater',
    name: 'Bathroom floor heater',
    controlType: 'setpoint',
    loadType: 'duty_cycle',
    priority: 3,
    ratedPowerW: 850,
    minimumPowerW: 850,
    heatLossWPerC: 27,
    thermalCapacityWhPerC: 9_200,
    heatingEfficiency: 1,
    initialTemperatureC: 21.2,
    occupiedStartHour: 5.5,
    occupiedEndHour: 9,
    occupiedTargetC: 22,
    setbackTargetC: 19,
  },
];

const seasonalWeather: Record<Exclude<ThermalFixtureSeason, 'ev_only'>, {
  meanC: number;
  amplitudeC: number;
  dayOffsetsC: [number, number, number];
}> = {
  winter: { meanC: -4.5, amplitudeC: 3.5, dayOffsetsC: [-1.5, 0, -0.5] },
  spring: { meanC: 8, amplitudeC: 5.5, dayOffsetsC: [-3, 1.5, 4] },
  summer: { meanC: 20, amplitudeC: 5, dayOffsetsC: [0, 1.5, 0.5] },
  autumn: { meanC: 9, amplitudeC: 4.5, dayOffsetsC: [-2, 1, 3.5] },
};

const localHour = (epochMs: number) => {
  const value = new Date(epochMs);
  return value.getUTCHours() + value.getUTCMinutes() / 60;
};

const occupied = (zone: ZoneDefinition, hour: number) =>
  zone.occupiedStartHour < zone.occupiedEndHour
    ? hour >= zone.occupiedStartHour && hour < zone.occupiedEndHour
    : hour >= zone.occupiedStartHour || hour < zone.occupiedEndHour;

const comfortTarget = (
  zone: ZoneDefinition,
  hour: number,
  futureMaximumC: number,
) => {
  const scheduled = occupied(zone, hour)
    ? zone.occupiedTargetC
    : zone.setbackTargetC;
  // In shoulder seasons, avoid reheating a cooled room immediately before a
  // warm spell. Comfort bounds remain authoritative; only the preferred point
  // moves down within them.
  return futureMaximumC >= 15 && scheduled > zone.setbackTargetC
    ? scheduled - 0.5
    : scheduled;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const requestedPower = (
  zone: ZoneDefinition,
  temperatureC: number,
  targetC: number,
  wasOn: boolean,
) => {
  if (zone.loadType === 'duty_cycle') {
    const on = wasOn ? temperatureC < targetC + 0.2 : temperatureC <= targetC - 0.2;
    return on ? zone.ratedPowerW : 0;
  }
  if (temperatureC >= targetC + 0.1) return 0;
  const demand = (targetC - temperatureC) * 1_450 + zone.minimumPowerW;
  return clamp(demand, zone.minimumPowerW, zone.ratedPowerW);
};

const nextTemperature = (
  zone: ZoneDefinition,
  temperatureC: number,
  outdoorC: number,
  powerW: number,
) => {
  const heatLossW = zone.heatLossWPerC * (temperatureC - outdoorC);
  const netWh = (powerW * zone.heatingEfficiency - heatLossW) * SLOT_HOURS;
  return temperatureC + netWh / zone.thermalCapacityWhPerC;
};

/**
 * Build a deterministic 72-hour shadow projection for visual and optimiser
 * testing. It never crosses the live Home Assistant execution boundary.
 */
export function createSeasonalThermalProjection(
  season: ThermalFixtureSeason,
  firstStartMs: number,
): ThermalProjection {
  const starts = Array.from({ length: SLOT_COUNT }, (_, index) =>
    new Date(firstStartMs + index * SLOT_MS).toISOString());
  if (season === 'ev_only') {
    return {
      source: 'synthetic_season_fixture',
      season,
      slot_minutes: 15,
      starts,
      outdoor_temperature_c: starts.map(() => 12),
      planned_total_power_w: starts.map(() => 0),
      unplanned_total_power_w: starts.map(() => 0),
      zones: [],
    };
  }

  const weather = seasonalWeather[season];
  const outdoor = starts.map((_, index) => {
    const hour = localHour(firstStartMs + index * SLOT_MS);
    const day = Math.min(2, Math.floor(index / 96));
    const diurnal = Math.cos((hour - 15) / 24 * Math.PI * 2);
    return Number((weather.meanC + weather.dayOffsetsC[day] +
      weather.amplitudeC * diurnal).toFixed(2));
  });
  const futureMaximum = outdoor.map((_, index) =>
    Math.max(...outdoor.slice(index, Math.min(outdoor.length, index + 96))));

  const zones: ThermalZoneProjection[] = ZONES.map(zone => ({
    key: zone.key,
    name: zone.name,
    control_type: zone.controlType,
    load_type: zone.loadType,
    priority: zone.priority,
    rated_power_w: zone.ratedPowerW,
    comfort_min_c: [],
    target_c: [],
    comfort_max_c: [],
    planned_temperature_c: [],
    unplanned_temperature_c: [],
    planned_power_w: [],
    unplanned_power_w: [],
  }));
  const plannedTemperatures = ZONES.map(zone => zone.initialTemperatureC);
  const unplannedTemperatures = ZONES.map(zone => zone.initialTemperatureC);
  const plannedOn = ZONES.map(() => false);
  const unplannedOn = ZONES.map(() => false);
  const plannedTotalPowerW: number[] = [];
  const unplannedTotalPowerW: number[] = [];

  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const hour = localHour(firstStartMs + index * SLOT_MS);
    const targets = ZONES.map(zone =>
      comfortTarget(zone, hour, futureMaximum[index]));
    const minimums = targets.map(target => target - 0.6);
    const maximums = targets.map(target => target + 0.9);
    const unplannedRequests = ZONES.map((zone, zoneIndex) =>
      requestedPower(
        zone,
        unplannedTemperatures[zoneIndex],
        targets[zoneIndex],
        unplannedOn[zoneIndex],
      ));

    // A single coordinated heat budget avoids every local thermostat starting
    // at once. Mandatory comfort recovery wins first, then customer priority
    // and thermal urgency. Inverter loads may use the remaining partial budget;
    // relay loads remain full-power or off.
    const thermalBudgetW = season === 'winter' ? 2_700 : 2_250;
    const middaySolar = hour >= 10.5 && hour < 15.5;
    const expensiveWindow = (hour >= 7 && hour < 10) || (hour >= 17 && hour < 20);
    const plannedTargets = targets.map((target, zoneIndex) => {
      const preheat = middaySolar ? 0.55 : 0;
      const coast = expensiveWindow ? -0.35 : 0;
      return clamp(target + preheat + coast, minimums[zoneIndex], maximums[zoneIndex]);
    });
    const candidates = ZONES.map((zone, zoneIndex) => ({
      zone,
      zoneIndex,
      mandatory: plannedTemperatures[zoneIndex] <= minimums[zoneIndex] + 0.15,
      urgency: plannedTemperatures[zoneIndex] - minimums[zoneIndex],
      request: requestedPower(
        zone,
        plannedTemperatures[zoneIndex],
        plannedTargets[zoneIndex],
        plannedOn[zoneIndex],
      ),
    })).sort((left, right) =>
      Number(right.mandatory) - Number(left.mandatory) ||
      left.urgency - right.urgency ||
      left.zone.priority - right.zone.priority);
    const plannedPowers = ZONES.map(() => 0);
    let remainingBudgetW = thermalBudgetW;
    for (const candidate of candidates) {
      if (candidate.request <= 0) continue;
      const { zone, zoneIndex } = candidate;
      if (zone.loadType === 'duty_cycle') {
        if (candidate.request <= remainingBudgetW) {
          plannedPowers[zoneIndex] = candidate.request;
          remainingBudgetW -= candidate.request;
        }
      } else {
        const granted = Math.min(candidate.request, remainingBudgetW);
        if (granted >= zone.minimumPowerW) {
          plannedPowers[zoneIndex] = granted;
          remainingBudgetW -= granted;
        }
      }
    }

    for (const [zoneIndex, zone] of ZONES.entries()) {
      const projection = zones[zoneIndex];
      projection.comfort_min_c.push(Number(minimums[zoneIndex].toFixed(2)));
      projection.target_c.push(Number(targets[zoneIndex].toFixed(2)));
      projection.comfort_max_c.push(Number(maximums[zoneIndex].toFixed(2)));
      projection.planned_temperature_c.push(
        Number(plannedTemperatures[zoneIndex].toFixed(3)),
      );
      projection.unplanned_temperature_c.push(
        Number(unplannedTemperatures[zoneIndex].toFixed(3)),
      );
      projection.planned_power_w.push(Number(plannedPowers[zoneIndex].toFixed(2)));
      projection.unplanned_power_w.push(
        Number(unplannedRequests[zoneIndex].toFixed(2)),
      );
      plannedOn[zoneIndex] = plannedPowers[zoneIndex] > 0;
      unplannedOn[zoneIndex] = unplannedRequests[zoneIndex] > 0;
      plannedTemperatures[zoneIndex] = nextTemperature(
        zone,
        plannedTemperatures[zoneIndex],
        outdoor[index],
        plannedPowers[zoneIndex],
      );
      unplannedTemperatures[zoneIndex] = nextTemperature(
        zone,
        unplannedTemperatures[zoneIndex],
        outdoor[index],
        unplannedRequests[zoneIndex],
      );
    }
    plannedTotalPowerW.push(
      Number(plannedPowers.reduce((sum, power) => sum + power, 0).toFixed(2)),
    );
    unplannedTotalPowerW.push(
      Number(unplannedRequests.reduce((sum, power) => sum + power, 0).toFixed(2)),
    );
  }

  return {
    source: 'synthetic_season_fixture',
    season,
    slot_minutes: 15,
    starts,
    outdoor_temperature_c: outdoor,
    planned_total_power_w: plannedTotalPowerW,
    unplanned_total_power_w: unplannedTotalPowerW,
    zones,
  };
}
