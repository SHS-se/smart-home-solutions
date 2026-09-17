import {
  generateOptimisationPlan,
  type OptimisationSnapshot,
} from '../../../supabase/functions/_shared/energy-optimisation';
import type {
  ActualEnergySlot,
  OptimisationPlan,
  PortalOptimisationPlan,
  ThermalFixtureSeason,
} from './contracts';
import { createSeasonalThermalProjection } from './thermal-fixtures';

const SLOT_MS = 15 * 60_000;
const SLOT_HOURS = 0.25;
const DEMO_SLOT_COUNT = 72 * 4;
const TIMEZONE = 'Europe/Stockholm';

const quarterStart = (now: number) => Math.floor(now / SLOT_MS) * SLOT_MS;

const localHour = (value: Date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  return hour + minute / 60;
};

const demoShape = (
  start: Date,
  index: number,
  season: ThermalFixtureSeason = 'summer',
) => {
  const hour = localHour(start);
  const solarShape = season === 'winter'
    ? { dawn: 8, daylightHours: 8, peakW: 2_400 }
    : season === 'spring' || season === 'ev_only'
      ? { dawn: 6, daylightHours: 13, peakW: 6_100 }
      : season === 'autumn'
        ? { dawn: 7, daylightHours: 11, peakW: 4_400 }
        : { dawn: 4.5, daylightHours: 17, peakW: 7_900 };
  const daylight = Math.max(
    0,
    Math.sin(Math.PI * (hour - solarShape.dawn) / solarShape.daylightHours),
  );
  const pvW = solarShape.peakW * daylight ** 1.75;
  const breakfast = hour >= 6.5 && hour < 9 ? 650 : 0;
  const evening = hour >= 17 && hour < 22 ? 1_050 : 0;
  const texture = 90 * (1 + Math.sin(index * 1.7));
  const baseW = 520 + breakfast + evening + texture;
  const peakPrice = (hour >= 7 && hour < 10) || (hour >= 17 && hour < 21);
  const overnight = hour < 5;
  return {
    pvW,
    baseW,
    importPrice: peakPrice ? 1.94 : overnight ? 0.83 : 1.21,
    exportPrice: peakPrice ? 0.62 : 0.37,
  };
};

/**
 * Build the promotional scenario entirely in the browser. It is never sent to
 * Supabase and deliberately has no customer, home, or Home Assistant identity.
 */
export function createWebsiteDemoPlan(
  now = Date.now(),
  season: ThermalFixtureSeason = 'winter',
): PortalOptimisationPlan {
  const captured = new Date(now);
  const firstStart = quarterStart(now);
  const slots = Array.from({ length: DEMO_SLOT_COUNT }, (_, index) => {
    const start = new Date(firstStart + index * SLOT_MS);
    const shape = demoShape(start, index, season);
    return {
      start: start.toISOString(),
      pv_forecast_w: Math.round(shape.pvW),
      base_load_forecast_w: Math.round(shape.baseW),
      import_price_sek_per_kwh: shape.importPrice,
      export_price_sek_per_kwh: shape.exportPrice,
    };
  });
  const horizonEnd = new Date(firstStart + DEMO_SLOT_COUNT * SLOT_MS).toISOString();
  const at = (index: number) => slots[index].start;
  const boilerForecastW = slots.map((slot, index) => {
    const hour = localHour(new Date(slot.start));
    const expected = hour >= 5 && hour < 9
      ? 620
      : hour >= 16 && hour < 22
        ? 480
        : 75;
    return Math.round(expected * (0.88 + 0.12 * Math.sin(index * 0.41) ** 2));
  });
  const airconForecastW = slots.map((slot, index) => {
    const hour = localHour(new Date(slot.start));
    return hour >= 6 && hour < 18
      ? Math.round(610 + 260 * Math.sin(index * 0.27) ** 2)
      : 8;
  });
  const advancedHome = season !== 'ev_only';
  const services: OptimisationSnapshot['services'] = [];
  for (const dayStart of advancedHome ? [0, 96, 192] : []) {
    const dayEnd = Math.min(dayStart + 96, slots.length);
    services.push(
      {
        id: `website-demo-boiler-${dayStart / 96 + 1}`,
        device: 'boiler',
        earliest_start: at(dayStart),
        deadline: new Date(firstStart + dayEnd * SLOT_MS).toISOString(),
        required_kwh: Number((boilerForecastW
          .slice(dayStart, dayEnd)
          .reduce((sum, power) => sum + power, 0) / 4_000).toFixed(5)),
        control: {
          type: 'duty_cycle',
          rated_power_w: 3_000,
          expected_power_w_by_slot: boilerForecastW,
          max_consecutive_inhibit_slots: 4,
        },
        priority: 1,
      },
      {
        id: `website-demo-pool-${dayStart / 96 + 1}`,
        device: 'pool',
        earliest_start: at(dayStart),
        deadline: at(dayStart + 80),
        required_kwh: 8,
        control: { type: 'fixed_power', power_w: 4_000 },

        priority: 2,
        baseline_preferred_start: at(dayStart + 44),
      },
    );
  }
  services.push({
    id: 'website-demo-ev',
    device: 'ev',
    earliest_start: at(0),
    deadline: at(64),
    required_kwh: Number((((0.8 - 0.64) * 75) / 0.94).toFixed(3)),
    control: {
      type: 'discrete_current',
      min_current_a: 5,
      max_current_a: 16,
      current_step_a: 1,
      phase_count: 3,
      voltage_v: 230,
    },
    priority: 3,
    baseline_preferred_start: at(0),
  });

  const source = (
    provider: string,
    entityId: string,
    quality: 'measured' | 'provider_raw',
    location?: { latitude?: number; longitude?: number; market_area?: string },
  ) => ({
    provider,
    entity_ids: [entityId],
    issued_at: captured.toISOString(),
    valid_until: horizonEnd,
    quality,
    ...(location ? { location } : {}),
  });
  const snapshot: OptimisationSnapshot = {
    schema_version: 5,
    mode: 'live',
    capabilities: {
      pv: true,
      battery: advancedHome,
      pool: advancedHome,
      boiler: advancedHome,
      ev: true,
    },
    snapshot_id: '00000000-0000-4000-8000-000000000099',
    captured_at: captured.toISOString(),
    timezone: TIMEZONE,
    slot_minutes: 15,
    slots,
    sources: {
      pv: source('Website example', 'demo.pv', 'provider_raw', {
        latitude: 59.33,
        longitude: 18.07,
      }),
      base_load: source('Website example', 'demo.base_load', 'measured'),
      import_price: source('Website example', 'demo.import_price', 'provider_raw', {
        market_area: 'SE3',
      }),
      export_price: source('Website example', 'demo.export_price', 'provider_raw', {
        market_area: 'SE3',
      }),
      battery: advancedHome
        ? source('Website example', 'demo.battery', 'measured')
        : null,
    },
    pv_calibration: {
      correction_factor_by_lead_day: [0.96, 0.93, 0.91, 0.9],
      sample_count_by_lead_day: [42, 38, 31, 24],
    },
    battery: advancedHome
      ? {
        capacity_kwh: 13.5,
        soc: 0.43,
        min_soc: 0.1,
        max_soc: 1,
        charge_max_w: 5_000,
        discharge_max_w: 5_000,
        charge_efficiency: 0.95,
        discharge_efficiency: 0.95,
      }
      : null,
    ev_battery: {
      name: 'Example EV',
      connected: true,
      capacity_kwh: 75,
      soc: 0.64,
      departure_target_soc: 0.8,
      charge_efficiency: 0.94,
      available_from: at(0),
      departure: at(64),
      priority: 3,
      source_entity_ids: {
        connected: 'binary_sensor.demo_ev_connected',
        soc: 'sensor.demo_ev_soc',
        target_soc: 'number.demo_ev_target_soc',
        energy_remaining: 'sensor.demo_ev_energy_remaining',
        charge_current: 'number.demo_ev_charge_current',
      },
    },
    grid: { import_limit_w: 17_000, export_limit_w: 17_000 },
    policy: {
      battery_end_of_solar_target_soc: advancedHome ? 0.75 : 0,
      battery_target_is_hard: false,
      terminal_soc_min: advancedHome ? 0.1 : 0,
      terminal_energy_value_sek_per_kwh: advancedHome ? 1.1 : 0,
      battery_export_enabled: advancedHome,
      battery_export_reserve_soc: advancedHome ? 0.8 : 0,
      battery_export_min_price_sek_per_kwh: advancedHome ? 2.5 : 0,
    },
    device_models: advancedHome ? [
      {
        key: 'sensor.demo_water_boiler_energy',
        name: 'Water boiler',
        statistic_id: 'sensor.demo_water_boiler_energy',
        category: 'hot_water',
        suggested_load_type: 'duty_cycle',
        load_type: 'duty_cycle',
        planning_role: 'controllable',
        control_type: 'permit_inhibit',
        active_power_w: 3_050,
        profile_sample_count: 1_920,
        forecast_w_by_slot: boilerForecastW,
      },
      {
        key: 'sensor.demo_living_room_aircon_energy',
        name: 'Living room aircon',
        statistic_id: 'sensor.demo_living_room_aircon_energy',
        category: 'cooling',
        suggested_load_type: 'inverter',
        load_type: 'inverter',
        planning_role: 'controllable',
        control_type: 'variable_power',
        active_power_w: 910,
        profile_sample_count: 1_920,
        forecast_w_by_slot: airconForecastW,
      },
    ] : [],
    services,
    service_requirement_sample_days: {
      hot_water: 21,
      pool_heating: 19,
      ev_charging: 8,
    },
  };
  const generated = generateOptimisationPlan(snapshot, captured);
  const sources = Object.fromEntries(
    Object.entries(generated.sources).map(([key, value]) => [
      key,
      value === null
        ? null
        : { ...value, provider: 'Built-in website example', quality: 'synthetic' as const },
    ]),
  ) as OptimisationPlan['sources'];
  return {
    ...generated,
    mode: 'demo',
    plan_id: 'website-demo',
    snapshot_id: 'website-demo',
    sources,
    thermal_projection: createSeasonalThermalProjection(
      season,
      firstStart,
    ),
  };
}

export function createWebsiteDemoActuals(now = Date.now()): ActualEnergySlot[] {
  const end = quarterStart(now);
  return Array.from({ length: 96 }, (_, index) => {
    const start = new Date(end - (96 - index) * SLOT_MS);
    const shape = demoShape(start, index + 37);
    const solarKwh = shape.pvW / 1_000 * SLOT_HOURS * (0.94 + 0.04 * Math.sin(index));
    const flexibleW = index % 29 < 5 ? 2_400 : 0;
    const totalKwh = (shape.baseW + flexibleW) / 1_000 * SLOT_HOURS;
    const netKwh = totalKwh - solarKwh;
    return {
      start_ts: start.toISOString(),
      total_load_kwh: Number(totalKwh.toFixed(4)),
      solar_production_kwh: Number(Math.max(0, solarKwh).toFixed(4)),
      grid_import_kwh: Number(Math.max(0, netKwh).toFixed(4)),
      grid_export_kwh: Number(Math.max(0, -netKwh).toFixed(4)),
      battery_charge_kwh: Number(Math.max(0, -netKwh * 0.45).toFixed(4)),
      battery_soc: null,
    ev_soc: null,
    battery_discharge_kwh: Number(Math.max(0, netKwh * 0.18).toFixed(4)),
    };
  });
}
