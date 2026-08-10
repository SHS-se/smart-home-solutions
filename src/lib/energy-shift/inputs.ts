/**
 * Load-shift plan inputs - 15-minute resolution.
 *
 * Snapshot from the live Home Assistant instance at ISSUED_AT. Every value is
 * measured or forecast; nothing is invented. Where a value is derived rather
 * than read directly, the comment says how.
 *
 * Canonical timestep is 900 s, per ENERGY_OPTIMISATION_ARCHITECTURE section 5.1.
 * Slots are half-open [start, start+15min), local Europe/Stockholm.
 *
 * Units: power W, energy kWh, price SEK/kWh, temperature degC, SOC fraction.
 */

export const ISSUED_AT = '2026-08-10T09:16:57+02:00';
export const TIMEZONE = 'Europe/Stockholm';

/** 288 quarter-hours = 72 h, first slot 2026-08-10T09:30 local. */
export const HORIZON_START_DAY = '2026-08-10';
export const HORIZON_START_QUARTER = 38; // 09:30
export const SLOT_COUNT = 288;
export const SLOT_HOURS = 0.25;

/**
 * Binding boundary.
 *
 * Tibber has published spot only through 2026-08-10T23:45 - tomorrow's prices
 * appear around 13:00 CET and it is currently 09:16. The Ellevio tariff runs
 * further (to 2026-08-11T23:00) but the binding horizon is the OVERLAP of the
 * two series, not the longer one. Zipping them blindly would price tomorrow
 * evening at today's rate, the trap called out in the working notes.
 *
 * Slot 0 = 08-10 09:30, so slots 0..57 are priced; everything after is
 * advisory - PV forecast exists, price does not.
 */
export const BINDING_UNTIL_SLOT = 58;

export const PLANT = {
  batteryCapacityKwh: 18.08,   // sensor.sigen_plant_rated_energy_capacity
  batteryChargeMaxW: 8800,     // sensor.sigen_plant_ess_rated_charging_power
  batteryDischargeMaxW: 9600,  // sensor.sigen_plant_ess_rated_discharging_power
  plantMaxActiveW: 13200,      // sensor.sigen_plant_max_active_power
  gridImportMaxW: 13200,
  gridExportMaxW: 13200,
  socMin: 0.05,                // observed floor, held for 3 h on 2026-08-01
  socMax: 1.00,
  chargeEff: 0.95,
  dischargeEff: 0.95,
};

/** Measured live state at ISSUED_AT. */
export const INITIAL = {
  batterySoc: 0.265,            // sensor.sigen_plant_battery_state_of_charge
  poolTempC: 29.75,             // sensor.pool_temperature_sensor_temperature
  poolTargetC: 30.2,
  poolCompleteToday: false,     // binary_sensor.node_red_pool_heating_complete = off
  poolDoneTodayKwh: 0.0,        // pool + pump utility meters, both reset at midnight
  boilerDoneTodayKwh: 0.909874, // sensor.hot_water_utility_meter

  carConnected: true,           // binary_sensor.tesla_model_y_charge_cable = on
  carAtHome: true,              // device_tracker.tesla_model_y_location = home
  carSoc: 0.73,                 // sensor.tesla_model_y_battery_level
  carDepartureDeadline: null,   // no departure entity exists - never guessed
};

export const DEVICES = {
  pool: {
    label: 'Pool heating',
    powerW: 3660,              // 3250 heater + 410 pump, measured together
    dailyRequirementKwh: 15.3, // median of 17 measured days
    configuredTargetKwh: 22.0, // input_number.emhass_pool_daily_target
    minRunSlots: 4,            // 1 h - avoids chattering a 3.6 kW contactor
  },
  boiler: {
    label: 'Hot water',
    powerW: 3000,              // sensor.water_boiler_power while heating
    dailyRequirementKwh: 4.1,  // median of 17 measured days
    configuredTargetKwh: 9.0,  // input_number.emhass_boiler_daily_target
    minRunSlots: 2,            // 30 min
  },
  car: {
    label: 'Car charging',
    powerW: 11000,             // Easee maximum
    // Derived from the vehicle: sensor.tesla_model_y_energy_remaining = 55.26
    // kWh at 73 percent SOC => usable pack 75.70 kWh.
    batteryKwh: 75.70,
    targetSoc: 0.80,           // number.tesla_model_y_charge_limit
    chargeEff: 0.92,
    minRunSlots: 2,
  },
};

/**
 * PV forecast, 96 points per day at 15-minute spacing, from the `watts`
 * attribute of sensor.meteo_solar_production_forecast_estimate_*.
 *
 * 2026-08-10 was revised UP from 36.6 kWh in last night's snapshot to 42.6 kWh
 * here. Forecasts move; a plan is only as good as its issue time.
 */
export const PV_FORECAST_W: Record<string, number[]> = {
  '2026-08-10': [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 99, 210, 309, 392,
    459, 518, 601, 707, 826, 929, 970, 901, 739, 543, 451, 444,
    502, 584, 644, 695, 758, 842, 973, 1116, 1315, 1580, 1962, 2496,
    3075, 3603, 4037, 4413, 4721, 4929, 4957, 4720, 4374, 4087, 4072, 4269,
    4577, 4918, 5216, 5566, 5898, 6170, 6289, 6319, 6246, 6075, 5813, 5449,
    5039, 4572, 4091, 3594, 3076, 2566, 2032, 1537, 1041, 572, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  '2026-08-11': [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 113, 248, 384, 526,
    671, 807, 933, 1049, 1160, 1268, 1368, 1455, 1529, 1595, 1794, 2072,
    2350, 2622, 2901, 3207, 3544, 3897, 4230, 4536, 4813, 5049, 5245, 5358,
    5421, 5456, 5544, 5653, 5766, 5907, 6053, 6289, 6536, 6678, 6576, 6189,
    5661, 5170, 4843, 4628, 4497, 4362, 4209, 4052, 3909, 3763, 3613, 3504,
    3398, 3248, 3073, 2896, 2686, 2374, 1924, 1412, 894, 439, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  '2026-08-12': [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 234, 371, 515,
    661, 801, 931, 1049, 1157, 1253, 1339, 1415, 1484, 1544, 1718, 2004,
    2305, 2618, 2941, 3274, 3612, 3954, 4298, 4639, 4973, 5305, 5629, 5946,
    6244, 6536, 6808, 7038, 7230, 7403, 7536, 7656, 7750, 7812, 7838, 7849,
    7838, 7796, 7710, 7602, 7459, 7291, 7062, 6797, 6513, 6210, 5926, 5010,
    4368, 3869, 3246, 2724, 2089, 1487, 1065, 710, 438, 203, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  '2026-08-13': [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 154, 258, 375,
    515, 666, 808, 937, 1046, 1135, 1170, 1131, 1039, 946, 1036, 1340,
    1701, 2067, 2430, 2816, 3188, 3531, 3824, 4111, 4408, 4740, 5077, 5406,
    5724, 6026, 6311, 6563, 6777, 6959, 7121, 7254, 7364, 7450, 7498, 7532,
    7530, 7511, 7458, 7390, 7298, 7161, 6979, 6734, 6464, 6149, 5816, 5504,
    5145, 4697, 4095, 3279, 2421, 1668, 1174, 902, 769, 407, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
};

export const PV_FORECAST_DAILY_KWH: Record<string, number> = {
  '2026-08-10': 42.62,
  '2026-08-11': 52.84,
  '2026-08-12': 64.27,
  '2026-08-13': 61.25,
};

/**
 * Base load - whole-home load minus the separately modelled deferrables.
 *
 * Hourly, because that is its true source resolution: derived from the
 * 2026-08-01 reference day (sensor.sigen_plant_total_load_power minus pool
 * heater, pool pump, water boiler and car). Held flat within each hour rather
 * than interpolated - inventing 15-minute structure it does not have would be
 * worse than admitting the resolution.
 *
 * Sums to 18.2 kWh/day.
 */
export const BASE_LOAD_HOURLY_W = [
    791, 804, 593, 714, 438, 365, 639, 526, 582, 1094, 955, 851,
    1002, 923, 517, 721, 372, 386, 816, 1512, 1618, 795, 623, 537,
];

export const GRID_IMPORT_SEK = 0.71;   // flat across all published slots
export const GRID_EXPORT_SEK = 0.033;

/**
 * Tibber spot, 15-minute native. Published for 2026-08-10 only at issue time.
 * Later days are null - deliberately absent rather than extrapolated.
 */
export const SPOT_SEK: Record<string, (number | null)[]> = {
  '2026-08-10': [
    0.1725, 0.1724, 0.1695, 0.1624, 0.1672, 0.1634, 0.1616, 0.1580,
    0.1617, 0.1608, 0.1598, 0.1597, 0.1566, 0.1591, 0.1590, 0.1606,
    0.1598, 0.1617, 0.1653, 0.1788, 0.1816, 0.1947, 0.2043, 0.2056,
    0.2100, 0.2212, 0.2390, 0.2504, 0.2433, 0.2668, 0.2735, 0.2984,
    0.3207, 0.3073, 0.3065, 0.2865, 0.2674, 0.2613, 0.2320, 0.2196,
    0.2341, 0.2126, 0.2111, 0.2111, 0.2167, 0.2136, 0.2111, 0.2026,
    0.2162, 0.2228, 0.2140, 0.2166, 0.2111, 0.2111, 0.2111, 0.2122,
    0.2111, 0.2111, 0.2117, 0.2206, 0.2111, 0.2196, 0.2292, 0.2530,
    0.2111, 0.2322, 0.2533, 0.3177, 0.2154, 0.2654, 0.3076, 0.4040,
    0.2312, 0.3359, 0.3998, 0.3957, 0.3075, 0.3830, 0.3216, 0.3790,
    0.3455, 0.3411, 0.3075, 0.2764, 0.3619, 0.3322, 0.2566, 0.2529,
    0.3069, 0.2530, 0.2178, 0.1976, 0.2174, 0.2034, 0.1907, 0.1832,
  ],
  '2026-08-11': new Array(96).fill(null),
  '2026-08-12': new Array(96).fill(null),
  '2026-08-13': new Array(96).fill(null),
};

export const MEASURED_DAILY_KWH = {
  pool: [33.8, 9.3, 14.7, 13.9, 18.4, 16.7, 16.7, 15.9, 11.9, 6.2, 26.2, 12.9, 15.3, 13.2, 15.9, 16.5, 12.9],
  boiler: [3.9, 8.5, 3.6, 3.4, 3.2, 6.9, 2.9, 12.7, 4.2, 9.4, 3.8, 7.9, 4.1, 3.1, 2.9, 7.0, 7.0],
};

export const REFERENCE_DAY = {
  date: '2026-08-01',
  pvKwh: 58.8, loadKwh: 40.0, exportKwh: 10.4, importKwh: 1.5, batteryNetKwh: 9.3,
  socStart: 0.266, socEnd: 0.781, socFloorHitAt: '05:00-07:00',
  note: 'Battery drained to its 5 percent floor before dawn, then exported 10.4 kWh once full.',
};
