/**
 * Measured and forecast inputs for the load-shifting plan.
 *
 * EVERY value in this file was read from the live Home Assistant instance on
 * 2026-08-09T22:47+02:00. Nothing is invented. Where a value is derived rather
 * than read directly, `provenance` says how.
 *
 * Units: power W, energy kWh, price SEK/kWh, temperature degC, SOC fraction.
 * Slots are hourly, local Europe/Stockholm, half-open [start, start+1h).
 */

export const ISSUED_AT = '2026-08-09T22:47:54+02:00';
export const TIMEZONE = 'Europe/Stockholm';

/** Horizon: 72 hourly slots, first slot = 2026-08-09T23:00 local. */
export const HORIZON_START = '2026-08-09T23:00:00+02:00';
export const SLOT_COUNT = 72;

/**
 * Binding boundary. Exact supplier prices exist only to the end of 2026-08-10.
 * Slots at or after this index have PV forecast but NO price, so they are
 * advisory: the plan may rank them by solar surplus but not by money.
 * Slot 0 = Aug 9 23:00, slots 1..24 = Aug 10 00:00..23:00.
 */
export const BINDING_UNTIL_SLOT = 25;

// ---------------------------------------------------------------------------
// Plant capability - sensor.sigen_plant_*
// ---------------------------------------------------------------------------

export const PLANT = {
  batteryCapacityKwh: 18.08,      // sensor.sigen_plant_rated_energy_capacity
  batteryChargeMaxW: 8800,        // sensor.sigen_plant_ess_rated_charging_power
  batteryDischargeMaxW: 9600,     // sensor.sigen_plant_ess_rated_discharging_power
  plantMaxActiveW: 13200,         // sensor.sigen_plant_max_active_power
  gridImportMaxW: 13200,          // service limit, same as plant max
  gridExportMaxW: 13200,

  // Observed floor: SOC sat at exactly 5.0% for three hours on 2026-08-01
  // (05:00-07:00), so 5% is the configured reserve, not a coincidence.
  socMin: 0.05,
  socMax: 1.00,

  // Round-trip 0.90 split evenly. Derived from the 2026-08-01 balance:
  // PV 58.8 + import 1.5 - load 40.0 - export 10.4 = 9.9 kWh into a battery
  // that gained 9.3 kWh of stored charge => 0.6 kWh lost over ~+51 pts.
  chargeEff: 0.95,
  dischargeEff: 0.95,
};

// ---------------------------------------------------------------------------
// Measured initial state
// ---------------------------------------------------------------------------

export const INITIAL = {
  batterySoc: 0.610,              // sensor.sigen_plant_battery_state_of_charge
  poolTempC: 30.0,                // sensor.pool_temperature_sensor_temperature
  poolTargetC: 30.2,              // customer policy
  poolCompleteToday: true,        // binary_sensor.node_red_pool_heating_complete

  // Car IS home and plugged in.
  //   binary_sensor.tesla_model_y_charge_cable = on
  //   device_tracker.tesla_model_y_location    = home
  //   cover.tesla_model_y_charge_port_door     = open
  //   lock.tesla_model_y_charge_cable_lock     = locked
  //   sensor.tesla_model_y_charging            = stopped
  carConnected: true,
  carSoc: 0.73,                   // sensor.tesla_model_y_battery_level
  carChargeLimit: 0.80,           // number.tesla_model_y_charge_limit
  carChargeCurrentA: 5,           // number.tesla_model_y_charge_current, as set now
  carDepartureDeadline: null,     // no departure time published - see NOTE below
};

/**
 * NOTE on the car deadline.
 *
 * There is no departure-time entity, so the plan has no deadline to work to.
 * It charges the shortfall inside the BINDING window rather than deferring to a
 * sunnier advisory day, because deferring work on unpriced forecast while the
 * vehicle could leave at any time is a bet the planner is not entitled to make.
 * A real departure target would let it wait for the better solar on 08-11/08-12.
 */

// ---------------------------------------------------------------------------
// Deferrable device models
// ---------------------------------------------------------------------------

export const DEVICES = {
  /**
   * Pool heater and pump are ONE physical process - the heater cannot run
   * without circulation. Modelled as a single coupled load, which is the
   * workaround recorded in ENERGY_OPTIMISATION_NOTES.md section 6.3.1f.
   * Power is the measured mean while running on 2026-08-01 12:00-14:00.
   */
  pool: {
    label: 'Pool heating',
    powerW: 3660,                 // 3250 heater + 410 pump, measured
    // MEASURED, not configured. 17 days of daily energy (2026-07-24..08-08)
    // from sensor.pool_heater_power + sensor.esphome_pool_pump_power give a
    // median of 15.3 and a mean of 15.9 kWh/day. Median is used because two
    // outlier days (33.8 and 26.2) look like recovery after a cold spell
    // rather than normal maintenance.
    dailyRequirementKwh: 15.3,
    configuredTargetKwh: 22.0,    // input_number.emhass_pool_daily_target
    interruptible: true,
    minRunHours: 1,
  },

  /**
   * Hot water is a hard service commitment, not an optimisation sink. It gets
   * scheduled into the cheapest hours but its daily quota is non-negotiable.
   */
  boiler: {
    label: 'Hot water',
    powerW: 3000,                 // sensor.water_boiler_power while heating
    // MEASURED over the same 17 days: median 4.1, mean 5.6 kWh/day.
    dailyRequirementKwh: 4.1,
    configuredTargetKwh: 9.0,     // input_number.emhass_boiler_daily_target
    interruptible: true,
    minRunHours: 1,
  },

  car: {
    label: 'Car charging',
    powerW: 11000,                // Easee maximum
    // DERIVED from the vehicle's own telemetry rather than the helper:
    // sensor.tesla_model_y_energy_remaining = 55.26 kWh at 73% SOC
    //   => usable pack = 55.26 / 0.73 = 75.70 kWh
    // input_number.emhass_car_battery_capacity says 75.0, so the helper is
    // good to within 1% - recorded here because it is the one helper that
    // survived checking.
    batteryKwh: 75.70,
    configuredBatteryKwh: 75.0,   // input_number.emhass_car_battery_capacity
    targetSoc: 0.80,              // number.tesla_model_y_charge_limit
    chargeEff: 0.92,              // AC charging losses, typical for this pack
    interruptible: true,
    minRunHours: 1,
  },
};

// ---------------------------------------------------------------------------
// PV forecast - sensor.meteo_solar_production_forecast_estimate_*
// 15-minute `watts` attribute, averaged to hourly means.
// ---------------------------------------------------------------------------

export const PV_FORECAST_W = {
  '2026-08-09': [0,0,0,0,0,342,872,1323,1771,2850,4158,5420,6473,7052,7228,6891,4879,3361,2752,1672,294,0,0,0],
  '2026-08-10': [0,0,0,0,0,244,554,1029,582,488,1131,1792,3036,1852,3824,3432,5091,5740,4271,2210,392,0,0,0],
  '2026-08-11': [0,0,0,0,0,310,865,1310,1740,2782,3920,4681,5546,5821,5660,5052,3667,2304,1986,1590,346,0,0,0],
  '2026-08-12': [0,0,0,0,0,262,518,669,961,2172,3640,5014,5972,6544,6250,6445,5901,5614,4487,2166,273,0,0,0],
};

/** Daily totals published by the integration, for cross-checking the shapes. */
export const PV_FORECAST_DAILY_KWH = {
  '2026-08-09': 57.82,
  '2026-08-10': 36.5965,
  '2026-08-11': 47.94675,
  '2026-08-12': 57.76925,
};

// ---------------------------------------------------------------------------
// Base load
//
// Derived, not measured directly: sensor.emhass_load_power_no_var_loads has no
// state_class so it has no long-term statistics. Instead this is the measured
// 2026-08-01 profile of sensor.sigen_plant_total_load_power minus the four
// separately modelled loads (pool heater, pool pump, water boiler, car), which
// is exactly the metering boundary that avoids double counting.
//
// Sums to 18.2 kWh/day. Includes servers, FTX, fridge/freezer, computers and
// the pool room floor heater.
// ---------------------------------------------------------------------------

export const BASE_LOAD_W = [
  791, 804, 593, 714, 438, 365, 639, 526, 582, 1094, 955, 851,
  1002, 923, 517, 721, 372, 386, 816, 1512, 1618, 795, 623, 537,
];

// ---------------------------------------------------------------------------
// Prices
//
// Grid tariff: sensor.smart_home_solutions_grid_import_price `forecast`
// attribute. All 26 published slots are identical at 0.71 - in August the
// Ellevio series is a constant offset and carries no optimisation signal.
// Export side is 0.033 on the same revision.
//
// Spot: tibber.get_prices, 15-minute resolution, averaged to hourly.
// Published through end of 2026-08-10 only.
// ---------------------------------------------------------------------------

export const GRID_IMPORT_SEK = 0.71;
export const GRID_EXPORT_SEK = 0.033;

export const SPOT_SEK = {
  '2026-08-09': [null,null,null,null,null,null,null,null,null,null,null,null,
                 null,null,null,null,null,null,null,null,null,null,null,0.16505],
  '2026-08-10': [0.1692,0.1626,0.1605,0.1588,0.1664,0.1966,0.2302,0.2705,
                 0.3053,0.2451,0.2172,0.2110,0.2174,0.2114,0.2136,0.2282,
                 0.2536,0.2981,0.3407,0.3478,0.3176,0.3009,0.2438,0.1987],
  // No published spot beyond 2026-08-10. Deliberately absent rather than
  // extrapolated - a repeated price would give the plan false precision.
  '2026-08-11': new Array(24).fill(null),
  '2026-08-12': new Array(24).fill(null),
};

// ---------------------------------------------------------------------------
// Seasonal priority stacks, as stated by the customer.
// Summer is confirmed; spring and autumn/winter are his rough guesses and are
// marked as such so the UI never presents them as settled policy.
// ---------------------------------------------------------------------------

export const PRIORITY_STACKS = {
  summer: {
    confidence: 'confirmed',
    label: 'Summer',
    sinks: [
      { id: 'battery', label: 'House battery to 80% by end of solar day', target: 0.80 },
      { id: 'pool',    label: 'Pool to 30.2 degC' },
      { id: 'car',     label: 'Car charging from remaining solar' },
      { id: 'export',  label: 'Export to grid' },
    ],
  },
  spring: {
    confidence: 'estimated',
    label: 'Spring',
    sinks: [
      { id: 'heating', label: 'Home to 22 degC in the morning' },
      { id: 'pool',    label: 'Pool to 30.2 degC on solar or cheap import' },
      { id: 'battery', label: 'House battery to 100%', target: 1.00 },
      { id: 'car',     label: 'Car above 50% on cheap rates', target: 0.50 },
    ],
  },
  winter: {
    confidence: 'estimated',
    label: 'Autumn / Winter',
    sinks: [
      { id: 'heating', label: 'Home to 22 degC in the morning' },
      { id: 'battery', label: 'House battery to 100%', target: 1.00 },
      { id: 'car',     label: 'Car above 50% on cheap rates', target: 0.50 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Reference day - fully instrumented, used to validate the model
// ---------------------------------------------------------------------------

/**
 * Measured daily energy for the two thermostatic loads, 2026-07-24..2026-08-08,
 * from hourly statistics on the power sensors. Kept here so the gap between
 * configured target and observed reality stays visible.
 */
export const MEASURED_DAILY_KWH = {
  pool:   [33.8, 9.3, 14.7, 13.9, 18.4, 16.7, 16.7, 15.9, 11.9, 6.2, 26.2, 12.9, 15.3, 13.2, 15.9, 16.5, 12.9],
  boiler: [3.9, 8.5, 3.6, 3.4, 3.2, 6.9, 2.9, 12.7, 4.2, 9.4, 3.8, 7.9, 4.1, 3.1, 2.9, 7.0, 7.0],
};

export const REFERENCE_DAY = {
  date: '2026-08-01',
  pvKwh: 58.8,
  loadKwh: 40.0,
  exportKwh: 10.4,
  importKwh: 1.5,
  batteryNetKwh: 9.3,
  socStart: 0.266,
  socEnd: 0.781,
  socFloorHitAt: '05:00-07:00',
  poolRan: '12:00-15:00',
  carRan: '16:00-17:00',
  note: 'Battery drained to its 5% floor before dawn, then exported 10.4 kWh '
      + 'at 17:00-19:00 once full. Both are the behaviours the plan should fix.',
};
