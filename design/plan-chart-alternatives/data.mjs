// One day of a real house, on the 15-minute grid the planner actually uses.
//
// This is a *simulation*, not an export: the portal's own day lives behind a
// login, and pulling it out of Home Assistant a sensor at a time costs more
// than it is worth for a drawing exercise. So the shapes here are fitted to
// the day in the screenshot — 2026-08-25 at Phil's house — and everything is
// then solved so it balances: load equals solar plus import minus export plus
// discharge minus charge, in every single quarter. A chart that is meant to
// show conservation of energy can only be judged on data that conserves it.
//
// Deterministic: same seed, same numbers, every run. Swap `buildDataset` for a
// loader over a real export with the same row shape and every chart in this
// folder redraws from real measurements without another line changing.

/** Stockholm is UTC+2 through August; fixing it keeps output machine-independent. */
export const TZ_OFFSET_MIN = 120;
export const SLOT_MIN = 15;
export const SLOTS_PER_HOUR = 60 / SLOT_MIN;

/** Midnight local on the day in the screenshot. */
const DAY_START_MS = Date.UTC(2026, 7, 25, 0, 0) - TZ_OFFSET_MIN * 60_000;

/** 36 hours: the whole measured day, plus enough plan to be worth drawing. */
export const SLOT_COUNT = 36 * SLOTS_PER_HOUR;

/** 21:45, the moment the screenshot was taken. */
export const NOW_INDEX = 21 * SLOTS_PER_HOUR + 3;

/** What the portal reported for the measured day, in kWh and SEK. */
export const SCREENSHOT_TOTALS = {
  solarKwh: 32.8,
  loadKwh: 35.7,
  importKwh: 2.9,
  exportKwh: 1.0,
  netCostSek: 5.29,
};

const HOME_BATTERY_KWH = 18.08; // Sigen plant rated capacity
const HOME_CHARGE_LIMIT_W = 8_800;
const SURPLUS_CHARGE_CAP_W = 2_750;
const HOME_DISCHARGE_LIMIT_W = 9_600;
const ROUND_TRIP = 0.94;
const EV_BATTERY_KWH = 75;

/** Deterministic noise, so "run it again" means the same picture. */
const mulberry32 = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const random = (() => {
  let seed = 20260825;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return mulberry32(seed)();
  };
})();

/** Local hour-of-day as a float, e.g. 13.75, independent of the host timezone. */
const hourOf = index => ((index * SLOT_MIN) / 60) % 24;
const dayOf = index => Math.floor((index * SLOT_MIN) / 60 / 24);

/** Piecewise-linear read of {hour: value} control points, wrapping at midnight. */
const curve = points => {
  const keys = Object.keys(points).map(Number).sort((a, b) => a - b);
  return hour => {
    if (hour <= keys[0]) return points[keys[0]];
    for (let i = 1; i < keys.length; i += 1) {
      if (hour <= keys[i]) {
        const span = keys[i] - keys[i - 1];
        const t = span === 0 ? 0 : (hour - keys[i - 1]) / span;
        return points[keys[i - 1]] * (1 - t) + points[keys[i]] * t;
      }
    }
    return points[keys[keys.length - 1]];
  };
};

/** True while the local clock sits inside any [from, to) hour window. */
const within = (hour, windows) =>
  windows.some(([from, to]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to));

// ---------------------------------------------------------------------------
// Devices
//
// The names are the meters in the screenshot's legend. `group` is the one thing
// the original chart never had: nineteen meters cannot each own a colour, but
// seven kinds of load can.
// ---------------------------------------------------------------------------

/**
 * Six kinds of load, in stack order, bottom first.
 *
 * Nineteen meters cannot each own a colour — eight distinguishable hues is the
 * ceiling, and the current chart cycles a palette of eight across nineteen
 * series, so three meters share every colour. Grouping is not a simplification
 * here; it is the only way a stack this tall can be read. Steady loads sit at
 * the bottom, so the moving top edge belongs to the things the planner moves.
 */
export const GROUPS = [
  { key: 'base', label: 'Base load & ventilation', short: 'Base' },
  { key: 'plugs', label: 'Media & office', short: 'Media' },
  { key: 'kitchen', label: 'Kitchen & cold', short: 'Kitchen' },
  { key: 'pool', label: 'Pool', short: 'Pool' },
  { key: 'ev', label: 'EV charging', short: 'EV' },
  { key: 'hotwater', label: 'Hot water', short: 'Hot water' },
];

export const DEVICES = [
  { key: 'hot_water', label: 'Hot water energy', group: 'hotwater', short: 'Hot water', ratedW: 2_400 },
  { key: 'ev', label: 'Tesla Model Y Charge energy added', group: 'ev', short: 'EV charging', ratedW: 7_400 },
  { key: 'pool_heater', label: 'Pool heater energy', group: 'pool', short: 'Pool heater', ratedW: 3_000 },
  { key: 'pool_pump', label: 'Pool pump energy', group: 'pool', short: 'Pool pump', ratedW: 750 },
  { key: 'stove', label: 'Stove energy', group: 'kitchen', short: 'Stove', ratedW: 2_200 },
  { key: 'dishwasher', label: 'Dishwasher energy', group: 'kitchen', short: 'Dishwasher', ratedW: 1_900 },
  { key: 'microwave', label: 'Microwave energy', group: 'kitchen', short: 'Microwave', ratedW: 1_100 },
  { key: 'extractor', label: 'Extractor fan energy', group: 'kitchen', short: 'Extractor fan', ratedW: 150 },
  { key: 'fridge', label: 'Fridge energy', group: 'kitchen', short: 'Fridge', ratedW: 90 },
  { key: 'freezer', label: 'Freezer energy', group: 'kitchen', short: 'Freezer', ratedW: 110 },
  { key: 'ftx', label: 'FTX energy', group: 'base', short: 'FTX', ratedW: 95 },
  { key: 'tradfri', label: 'TRÅDFRI bulbs energy', group: 'base', short: 'TRÅDFRI bulbs', ratedW: 120 },
  { key: 'internet', label: 'Internet outlet Energy', group: 'plugs', short: 'Internet outlet', ratedW: 165 },
  { key: 'office', label: "Phil's office outlet Energy", group: 'plugs', short: "Phil's office", ratedW: 190 },
  { key: 'tv', label: 'TV outlet Energy', group: 'plugs', short: 'TV outlet', ratedW: 130 },
  { key: 'kef', label: 'KEF speakers Energy', group: 'plugs', short: 'KEF speakers', ratedW: 65 },
  { key: 'living_pp', label: 'Living room power point Energy', group: 'plugs', short: 'Living room socket', ratedW: 55 },
  { key: 'sophia', label: "Sophia's room power point Energy", group: 'plugs', short: "Sophia's room", ratedW: 45 },
  { key: 'powerpoint', label: 'Power point Energy', group: 'plugs', short: 'Power point', ratedW: 30 },
];

/** Which meters the planner may actually move. The rest are just observed. */
export const DISPATCHABLE = ['hot_water', 'ev', 'pool_heater', 'pool_pump'];

// ---------------------------------------------------------------------------
// Prices
//
// Nord Pool SE3 shaped by hand, then dressed as the customer sees it: the buy
// price carries transfer, energy tax and VAT; the sell price carries only the
// grid benefit. Two very different numbers from one spot curve, which is
// exactly why they belong on the same axis and nothing else does.
// ---------------------------------------------------------------------------

const IMPORT_MARKUP = 0.726; // påslag + överföring + energiskatt, SEK/kWh
const IMPORT_VAT = 1.25;
const EXPORT_BENEFIT = 0.09; // nätnytta, SEK/kWh

const SPOT_DAY_1 = curve({
  0: 1.05, 2: 1.02, 3.5: 1.0, 5: 1.12, 6: 1.35, 7: 1.28, 8: 1.02,
  9: 0.75, 10: 0.58, 11: 0.42, 13: 0.28, 14: 0.4, 15: 0.78,
  16: 1.35, 17: 1.82, 18: 2.1, 19: 1.88, 20: 1.55, 21: 1.34, 22: 1.24, 24: 1.15,
});
const SPOT_DAY_2 = curve({
  0: 0.92, 1: 0.58, 2: 0.38, 3: 0.31, 4: 0.34, 5: 0.62,
  6: 1.24, 7: 1.78, 8: 1.66, 9: 1.12, 10: 0.72, 11: 0.5, 12: 0.44, 24: 0.44,
});

const spotAt = index => (dayOf(index) === 0 ? SPOT_DAY_1 : SPOT_DAY_2)(hourOf(index));

// ---------------------------------------------------------------------------
// Solar
// ---------------------------------------------------------------------------

const SUNRISE = 5.9;
const SUNSET = 20.2;

/** Clear-sky bell, then a slow-moving cloud field so the day is not a textbook. */
const solarShape = index => {
  const hour = hourOf(index);
  if (dayOf(index) > 0 || hour <= SUNRISE || hour >= SUNSET) return 0;
  const t = (hour - SUNRISE) / (SUNSET - SUNRISE);
  const clear = Math.sin(Math.PI * t) ** 1.35;
  // Three drifting cloud bands; the afternoon is cloudier than the morning.
  const cloud =
    0.88
    + 0.12 * Math.sin(index / 7.3 + 1.1)
    - 0.22 * Math.max(0, Math.sin(index / 21 - 2.4)) ** 2
    - 0.3 * Math.max(0, Math.sin(index / 5.1 - 0.7)) ** 4 * (hour > 14 ? 1 : 0.35);
  return Math.max(0, clear * Math.max(0.12, cloud));
};

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/** Fixed appliances: what the house does whether or not anyone optimises it. */
const uncontrolledW = (index, device) => {
  const hour = hourOf(index);
  const day = dayOf(index);
  const jitter = 0.9 + 0.2 * random();
  switch (device.key) {
    case 'fridge':
      // Compressor duty cycle: on roughly two quarters in five.
      return (index + 1) % 5 < 2 ? device.ratedW * jitter : 0;
    case 'freezer':
      return (index + 3) % 7 < 3 ? device.ratedW * jitter : 0;
    case 'ftx':
      return device.ratedW * (within(hour, [[7, 22]]) ? 1 : 0.62) * jitter;
    case 'tradfri':
      return within(hour, [[5.5, 7.5], [19.5, 23.5]]) ? device.ratedW * jitter : 0;
    case 'internet':
      return device.ratedW * jitter;
    case 'powerpoint':
      return device.ratedW * jitter;
    case 'office':
      return within(hour, [[8, 17.5]]) && day === 0 ? device.ratedW * jitter : device.ratedW * 0.12;
    case 'tv':
      return within(hour, [[19, 23]]) ? device.ratedW * jitter : device.ratedW * 0.06;
    case 'kef':
      return within(hour, [[17, 23]]) ? device.ratedW * jitter : device.ratedW * 0.05;
    case 'living_pp':
      return within(hour, [[16, 23]]) ? device.ratedW * jitter : device.ratedW * 0.3;
    case 'sophia':
      return within(hour, [[15, 21.5]]) ? device.ratedW * jitter : device.ratedW * 0.2;
    case 'stove':
      return within(hour, [[17.5, 18.75]]) && day === 0 ? device.ratedW * (0.55 + 0.6 * random()) : 0;
    case 'extractor':
      return within(hour, [[17.5, 19]]) && day === 0 ? device.ratedW * jitter : 0;
    case 'microwave':
      return (within(hour, [[7.5, 7.75]]) || within(hour, [[12.25, 12.5]])) ? device.ratedW * jitter : 0;
    case 'dishwasher':
      // One cycle, started by the planner when the panels were still ahead.
      return day === 0 && within(hour, [[13, 13.75]]) ? device.ratedW * (0.4 + 0.9 * random()) : 0;
    default:
      return 0;
  }
};

/**
 * The four loads the planner owns. Each is expressed as *how much it wants*
 * per quarter, so alternative 4 can draw the decision rather than the outcome.
 */
const dispatchPlan = index => {
  const hour = hourOf(index);
  const day = dayOf(index);
  const spot = spotAt(index);
  const plan = { hot_water: 0, ev: 0, pool_heater: 0, pool_pump: 0 };

  // Hot water. The tank is a modulating heat pump, not a resistive element, so
  // the overnight reheat is a long low run — 0.54 kW at 03:30 in the screenshot
  // — while a midday top-up opens the valve wide because the sun is paying.
  if (day === 0 && within(hour, [[1, 5]])) plan.hot_water = 550;
  if (day === 0 && within(hour, [[11.5, 12.25]])) plan.hot_water = 2_400;
  if (day === 1 && within(hour, [[1, 5]])) plan.hot_water = 550;

  // EV: a surplus top-up in the afternoon, then the deep cheap window after 01:00.
  if (day === 0 && within(hour, [[14.5, 15.25]])) plan.ev = 3_700;
  if (day === 1 && within(hour, [[1.25, 4.75]])) plan.ev = 3_700;

  // Pool heater rides surplus only, and only while the sun is genuinely up.
  if (day === 0 && within(hour, [[10.75, 11.5]])) plan.pool_heater = 3_000;

  // Pump: filtration hours, deliberately parked on the cheapest daylight.
  if (day === 0 && within(hour, [[9.5, 11.5]])) plan.pool_pump = 750;
  if (day === 1 && within(hour, [[10, 11.5]])) plan.pool_pump = 750;

  // Spot above three kronor is never worth a discretionary kilowatt.
  if (spot > 1.95) { plan.hot_water = 0; plan.pool_heater = 0; plan.pool_pump = 0; }
  return plan;
};

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

const quarterKwh = watts => watts / 4_000;

export const buildDataset = () => {
  const rows = [];

  // 1. Solar, scaled so the measured day totals what the portal reported.
  const shapes = Array.from({ length: SLOT_COUNT }, (_, i) => solarShape(i));
  const day1ShapeKwh = shapes.slice(0, 96).reduce((sum, s) => sum + quarterKwh(s), 0);
  const solarScaleW = SCREENSHOT_TOTALS.solarKwh / day1ShapeKwh;

  // 2. Loads.
  const rawDeviceW = [];
  for (let i = 0; i < SLOT_COUNT; i += 1) {
    const plan = dispatchPlan(i);
    const deviceW = {};
    for (const device of DEVICES) {
      deviceW[device.key] = DISPATCHABLE.includes(device.key)
        ? plan[device.key] ?? 0
        : uncontrolledW(i, device);
    }
    rawDeviceW.push(deviceW);
  }

  // 3. Base load: the remainder, shaped like a house and scaled so the measured
  //    day matches the reported total. 0.33 kW at 03:30 is the screenshot's own
  //    tooltip, so the shape is anchored there rather than guessed.
  const baseShape = curve({
    0: 0.35, 3: 0.33, 5: 0.34, 7: 0.44, 9: 0.48, 12: 0.46,
    15: 0.47, 17: 0.54, 19: 0.58, 21: 0.5, 23: 0.4, 24: 0.35,
  });
  const rawBaseW = Array.from({ length: SLOT_COUNT }, (_, i) =>
    baseShape(hourOf(i)) * 1_000 * (0.94 + 0.12 * random()));

  const day1DeviceKwh = rawDeviceW.slice(0, 96)
    .reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + quarterKwh(b), 0), 0);
  const day1BaseKwh = rawBaseW.slice(0, 96).reduce((sum, w) => sum + quarterKwh(w), 0);
  const baseScale = Math.max(0.2, (SCREENSHOT_TOTALS.loadKwh - day1DeviceKwh) / day1BaseKwh);

  // 4. Battery, grid and state of charge, quarter by quarter.
  let homeKwh = 0.5 * HOME_BATTERY_KWH; // half full at midnight
  let evKwh = 0.5 * EV_BATTERY_KWH;

  for (let i = 0; i < SLOT_COUNT; i += 1) {
    const spot = spotAt(i);
    const importPrice = (spot + IMPORT_MARKUP) * IMPORT_VAT;
    const exportPrice = spot + EXPORT_BENEFIT;
    const solarW = shapes[i] * solarScaleW;
    const deviceW = rawDeviceW[i];
    const baseW = rawBaseW[i] * baseScale;
    const loadW = baseW + Object.values(deviceW).reduce((a, b) => a + b, 0);

    // Surplus first: anything the panels make that the house is not using goes
    // into the battery before it goes to the grid.
    const surplusW = Math.max(0, solarW - loadW);
    const deficitW = Math.max(0, loadW - solarW);
    const socFraction = homeKwh / HOME_BATTERY_KWH;

    let chargeW = 0;
    let dischargeW = 0;

    if (surplusW > 0) {
      const headroomW = ((HOME_BATTERY_KWH - homeKwh) * 4_000) / ROUND_TRIP;
      // The plan reserves inverter headroom for the car, so the last kilowatt of
      // a bright quarter spills to the grid rather than into the cells. That
      // reserve is the whole of the day's export.
      chargeW = Math.min(surplusW, SURPLUS_CHARGE_CAP_W, Math.max(0, headroomW));
    } else if (deficitW > 0) {
      // Hold a floor overnight so the morning peak still has something to spend.
      const floor = spot > 1.5 ? 0.05 : 0.1;
      const availableW = Math.max(0, (homeKwh - floor * HOME_BATTERY_KWH) * 4_000);
      dischargeW = Math.min(deficitW, HOME_DISCHARGE_LIMIT_W, availableW);
    }

    // Cheap-hour grid charging: the plan buys when spot is in the trough and
    // the battery cannot be filled by sun alone before the evening peak.
    // ...but never while the car is drawing. The service has one fuse, and a
    // plan that fed both at once put a 10 kW spike on every flow axis.
    if (spot < 0.45 && socFraction < 0.9 && surplusW === 0 && deviceW.ev === 0) {
      const headroomW = ((HOME_BATTERY_KWH - homeKwh) * 4_000) / ROUND_TRIP;
      chargeW = Math.min(HOME_CHARGE_LIMIT_W * 0.4, Math.max(0, headroomW));
    }

    const netW = loadW - solarW + chargeW - dischargeW;
    const gridImportW = Math.max(0, netW);
    const gridExportW = Math.max(0, -netW);

    homeKwh += quarterKwh(chargeW) * ROUND_TRIP - quarterKwh(dischargeW);
    homeKwh = Math.min(HOME_BATTERY_KWH, Math.max(0, homeKwh));
    evKwh = Math.min(EV_BATTERY_KWH, evKwh + quarterKwh(deviceW.ev) * 0.92);

    rows.push({
      index: i,
      ms: DAY_START_MS + i * SLOT_MIN * 60_000,
      measured: i < NOW_INDEX,
      hour: hourOf(i),
      day: dayOf(i),
      solarW,
      loadW,
      baseW,
      deviceW,
      gridImportW,
      gridExportW,
      batteryChargeW: chargeW,
      batteryDischargeW: dischargeW,
      homeSoc: homeKwh / HOME_BATTERY_KWH,
      evSoc: evKwh / EV_BATTERY_KWH,
      spotSekPerKwh: spot,
      importPriceSekPerKwh: importPrice,
      exportPriceSekPerKwh: exportPrice,
      dispatch: dispatchPlan(i),
      costSek: quarterKwh(gridImportW) * importPrice - quarterKwh(gridExportW) * exportPrice,
    });
  }

  return { rows, devices: DEVICES, groups: GROUPS };
};

/** Group totals for one window, largest first — the ordering every chart uses. */
export const groupSeries = (rows, from = 0, to = rows.length) => {
  const view = rows.slice(from, to);
  const byGroup = new Map(GROUPS.map(g => [g.key, new Array(view.length).fill(0)]));
  view.forEach((row, i) => {
    for (const device of DEVICES) {
      byGroup.get(device.group)[i] += row.deviceW[device.key] ?? 0;
    }
    byGroup.get('base')[i] += row.baseW;
  });
  return GROUPS.map(group => ({
    ...group,
    values: byGroup.get(group.key),
    kwh: byGroup.get(group.key).reduce((sum, w) => sum + quarterKwh(w), 0),
  }));
};

/** Per-meter totals for one window, largest first — used by the heatmap. */
export const deviceSeries = (rows, from = 0, to = rows.length) => {
  const view = rows.slice(from, to);
  return DEVICES
    .map(device => {
      const values = view.map(row => row.deviceW[device.key] ?? 0);
      return { ...device, values, kwh: values.reduce((sum, w) => sum + quarterKwh(w), 0) };
    })
    .concat([{
      key: 'base',
      label: 'Base load',
      short: 'Base load',
      group: 'base',
      values: view.map(row => row.baseW),
      kwh: view.reduce((sum, row) => sum + quarterKwh(row.baseW), 0),
    }])
    .sort((a, b) => b.kwh - a.kwh);
};

export const totals = (rows, from = 0, to = rows.length) => {
  const view = rows.slice(from, to);
  const sum = pick => view.reduce((acc, row) => acc + quarterKwh(pick(row)), 0);
  return {
    solarKwh: sum(r => r.solarW),
    loadKwh: sum(r => r.loadW),
    importKwh: sum(r => r.gridImportW),
    exportKwh: sum(r => r.gridExportW),
    chargeKwh: sum(r => r.batteryChargeW),
    dischargeKwh: sum(r => r.batteryDischargeW),
    netCostSek: view.reduce((acc, row) => acc + row.costSek, 0),
  };
};

export const label = (ms, withDay = false) => {
  const local = new Date(ms + TZ_OFFSET_MIN * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  if (!withDay) return `${hh}:${mm}`;
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mo = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${mo}/${dd} ${hh}:${mm}`;
};
