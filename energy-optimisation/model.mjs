/**
 * Load-shifting model.
 *
 * Two responsibilities, kept separate on purpose:
 *
 *   planX()    decides WHICH hours each deferrable load runs, using forecasts.
 *   simulate() executes a schedule against real device physics and reports the
 *              resulting energy balance. It is the single source of truth and
 *              it never trusts the planner - it clamps to SOC bounds, power
 *              limits and the grid envelope.
 *
 * The planner emits an ordered surplus-allocation policy rather than a power
 * schedule, which is the output shape argued for in ENERGY_OPTIMISATION_NOTES
 * section 12e and ENERGY_OPTIMISATION_ARCHITECTURE section 5.4.
 */

import {
  PLANT, INITIAL, DEVICES, PV_FORECAST_W, BASE_LOAD_W,
  GRID_IMPORT_SEK, GRID_EXPORT_SEK, SPOT_SEK,
  SLOT_COUNT, BINDING_UNTIL_SLOT,
} from './inputs.mjs';

const DAYS = ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12'];

/** Build the 72 hourly slots starting 2026-08-09T23:00 local. */
export function buildHorizon() {
  const slots = [];
  let dayIdx = 0;
  let hour = 23;

  for (let i = 0; i < SLOT_COUNT; i++) {
    const day = DAYS[dayIdx];
    const spot = SPOT_SEK[day][hour];
    slots.push({
      index: i,
      day,
      hour,
      label: `${day.slice(5)} ${String(hour).padStart(2, '0')}:00`,
      pvW: PV_FORECAST_W[day][hour],
      baseW: BASE_LOAD_W[hour],
      spotSek: spot,
      importSek: spot === null ? null : GRID_IMPORT_SEK + spot,
      exportSek: spot === null ? null : GRID_EXPORT_SEK + spot,
      binding: i < BINDING_UNTIL_SLOT,
      // Daylight is where a solar-first policy can act at all.
      surplusW: Math.max(0, PV_FORECAST_W[day][hour] - BASE_LOAD_W[hour]),
    });

    hour += 1;
    if (hour === 24) { hour = 0; dayIdx += 1; }
  }
  return slots;
}

/** Slot indices belonging to each calendar day present in the horizon. */
export function groupByDay(slots) {
  const days = new Map();
  for (const s of slots) {
    if (!days.has(s.day)) days.set(s.day, []);
    days.get(s.day).push(s.index);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/**
 * Execute a schedule.
 *
 * @param slots     horizon from buildHorizon()
 * @param schedule  { pool: number[], boiler: number[], car: number[] }
 *                  each entry is the RUN FRACTION of that slot, 0..1
 * @param opts      { batterySoc, batteryTargetBySlot }
 *                  batteryTargetBySlot[i] = desired minimum SOC fraction by
 *                  the end of slot i, or null for "no requirement"
 */
export function simulate(slots, schedule, opts = {}) {
  const cap = PLANT.batteryCapacityKwh;
  let soc = opts.batterySoc ?? INITIAL.batterySoc;

  const out = [];
  let totals = {
    pvKwh: 0, loadKwh: 0, importKwh: 0, exportKwh: 0,
    importCost: 0, exportRevenue: 0,
    poolKwh: 0, boilerKwh: 0, carKwh: 0, baseKwh: 0,
    curtailedKwh: 0, unpricedImportKwh: 0, unpricedExportKwh: 0,
  };

  for (const s of slots) {
    const i = s.index;
    const poolW = (schedule.pool?.[i] ?? 0) * DEVICES.pool.powerW;
    const boilerW = (schedule.boiler?.[i] ?? 0) * DEVICES.boiler.powerW;
    const carW = (schedule.car?.[i] ?? 0) * DEVICES.car.powerW;

    const loadW = s.baseW + poolW + boilerW + carW;
    let netW = s.pvW - loadW;

    let battChargeW = 0;
    let battDischargeW = 0;
    let importW = 0;
    let exportW = 0;
    let curtailedW = 0;

    // Headroom expressed as grid-side watts over one hour.
    const socTarget = opts.batteryTargetBySlot?.[i] ?? null;
    const roomKwh = (PLANT.socMax - soc) * cap;
    const availKwh = (soc - PLANT.socMin) * cap;
    const maxChargeW = Math.min(PLANT.batteryChargeMaxW, (roomKwh / PLANT.chargeEff) * 1000);
    const maxDischargeW = Math.min(PLANT.batteryDischargeMaxW, availKwh * PLANT.dischargeEff * 1000);

    // Rank 1 first: the battery takes its reserved share of the PV before any
    // load sees it. Capped at the real surplus over base load, so a reservation
    // can never cause an import purely to charge the battery - that would be
    // buying at 0.92 to store something worth 0.92, minus round-trip losses.
    const reserveW = opts.reservedW?.[i] ?? 0;
    const reserveTakeW = Math.min(reserveW, Math.max(0, s.pvW - s.baseW), maxChargeW);
    const pvForLoadW = s.pvW - reserveTakeW;
    netW = pvForLoadW - loadW;
    battChargeW = reserveTakeW;

    if (netW > 0) {
      // Remaining surplus. Battery still has first claim, then export.
      battChargeW += Math.min(netW, maxChargeW - battChargeW);
      const toGridW = netW - (battChargeW - reserveTakeW);
      exportW = Math.min(toGridW, PLANT.gridExportMaxW);
      curtailedW = toGridW - exportW;
    } else if (netW < 0) {
      const deficitW = -netW;
      // Discharge to cover the deficit, but never below a slot's SOC floor.
      let allowedDischargeW = maxDischargeW;
      if (socTarget !== null) {
        const protectedKwh = Math.max(0, (soc - socTarget) * cap);
        allowedDischargeW = Math.min(allowedDischargeW, protectedKwh * PLANT.dischargeEff * 1000);
      }
      battDischargeW = Math.min(deficitW, allowedDischargeW);
      importW = Math.min(deficitW - battDischargeW, PLANT.gridImportMaxW);
    }

    // Charge the battery from cheap grid if the plan asked for it.
    const gridChargeW = (schedule.batteryGridCharge?.[i] ?? 0);
    if (gridChargeW > 0 && battChargeW < maxChargeW) {
      const extraW = Math.min(gridChargeW, maxChargeW - battChargeW,
                              PLANT.gridImportMaxW - importW);
      battChargeW += extraW;
      importW += extraW;
    }

    soc += (battChargeW * PLANT.chargeEff - battDischargeW / PLANT.dischargeEff) / 1000 / cap;
    soc = Math.min(PLANT.socMax, Math.max(PLANT.socMin, soc));

    const rec = {
      ...s,
      poolW, boilerW, carW, loadW,
      battChargeW, battDischargeW, importW, exportW, curtailedW,
      soc,
      importCost: s.importSek === null ? null : (importW / 1000) * s.importSek,
      exportRevenue: s.exportSek === null ? null : (exportW / 1000) * s.exportSek,
    };
    out.push(rec);

    totals.pvKwh += s.pvW / 1000;
    totals.baseKwh += s.baseW / 1000;
    totals.loadKwh += loadW / 1000;
    totals.poolKwh += poolW / 1000;
    totals.boilerKwh += boilerW / 1000;
    totals.carKwh += carW / 1000;
    totals.importKwh += importW / 1000;
    totals.exportKwh += exportW / 1000;
    totals.curtailedKwh += curtailedW / 1000;
    if (rec.importCost === null) totals.unpricedImportKwh += importW / 1000;
    else totals.importCost += rec.importCost;
    if (rec.exportRevenue === null) totals.unpricedExportKwh += exportW / 1000;
    else totals.exportRevenue += rec.exportRevenue;
  }

  totals.netCost = totals.importCost - totals.exportRevenue;
  totals.socStart = opts.batterySoc ?? INITIAL.batterySoc;
  totals.socEnd = soc;
  return { slots: out, totals };
}

// ---------------------------------------------------------------------------
// Requirement derivation
//
// Requirements are DERIVED from live state, never configured. This is the single
// biggest source of nonsense schedules per notes section 12b: a fixed quota will
// happily schedule work that is already done, or charge a car that is not here.
// ---------------------------------------------------------------------------

export function deriveRequirements(slots) {
  const days = groupByDay(slots);
  const req = {};

  const dayKeys = [...days.keys()];
  let carPlaced = false;
  for (const [day, idxs] of days) {
    // Only the FIRST day carries work already done. A short LAST day is simply
    // a truncated horizon, not a day with completed service - conflating the
    // two silently zeroed the final day's pool requirement.
    const isFirstDay = day === dayKeys[0];
    const isTruncatedTail = !isFirstDay && idxs.length < 24;

    // Pool: cycle already reported complete for 2026-08-09, so nothing remains
    // on day one. This is the state-derived requirement from notes 12b - a flat
    // quota would re-run work the thermostat has already finished.
    let poolKwh = DEVICES.pool.dailyRequirementKwh;
    if (isFirstDay && INITIAL.poolCompleteToday) poolKwh = 0;
    if (isTruncatedTail) poolKwh *= idxs.length / 24;

    // Boiler: 7.07 kWh already delivered today against a 4.1 kWh requirement,
    // so day one needs nothing further.
    let boilerKwh = DEVICES.boiler.dailyRequirementKwh;
    if (isFirstDay) boilerKwh = Math.max(0, boilerKwh - 7.07);
    if (isTruncatedTail) boilerKwh *= idxs.length / 24;

    // Car: a ONE-OFF shortfall, not a daily quota - the pack does not empty
    // itself overnight the way the pool and the tank lose heat. Charged only if
    // the cable is actually connected; if it is not, the requirement stays 0 and
    // is never assumed to arrive.
    //
    // Placed on the first FULL day so it lands inside the binding window. There
    // is no departure-time entity, so the planner may not defer it to a sunnier
    // advisory day on the assumption the car will still be here.
    let carKwh = 0;
    if (INITIAL.carConnected && !isFirstDay && !carPlaced) {
      const shortfallSoc = Math.max(0, DEVICES.car.targetSoc - INITIAL.carSoc);
      carKwh = (shortfallSoc * DEVICES.car.batteryKwh) / DEVICES.car.chargeEff;
      carPlaced = true;
    }

    req[day] = {
      poolKwh, boilerKwh, carKwh, slots: idxs,
      firstDay: isFirstDay, truncated: isTruncatedTail,
    };
  }
  return req;
}

// ---------------------------------------------------------------------------
// Baseline plan - what the house does today
//
// Reproduces the observed 2026-08-01 behaviour: pool runs a fixed midday block
// regardless of forecast, boiler trickles across the day, battery is passive
// (charges from whatever is left over, discharges on demand). This is the
// "maximum self consumption" inverter behaviour with no planning on top.
// ---------------------------------------------------------------------------

export function planBaseline(slots, req) {
  const pool = new Array(SLOT_COUNT).fill(0);
  const boiler = new Array(SLOT_COUNT).fill(0);
  const car = new Array(SLOT_COUNT).fill(0);

  for (const [, r] of Object.entries(req)) {
    // Pool: fixed 12:00 start, as observed.
    let remaining = r.poolKwh;
    for (const i of r.slots) {
      if (remaining <= 0) break;
      if (slots[i].hour < 12) continue;
      const frac = Math.min(1, remaining / (DEVICES.pool.powerW / 1000));
      pool[i] = frac;
      remaining -= frac * DEVICES.pool.powerW / 1000;
    }

    // Car: naive behaviour is to charge as soon as it is plugged in, at full
    // power, regardless of sun or price.
    remaining = r.carKwh;
    for (const i of r.slots) {
      if (remaining <= 1e-6) break;
      const frac = Math.min(1, remaining / (DEVICES.car.powerW / 1000));
      car[i] = frac;
      remaining -= frac * DEVICES.car.powerW / 1000;
    }

    // Boiler: spread thinly across waking hours, as observed.
    remaining = r.boilerKwh;
    const wake = r.slots.filter((i) => slots[i].hour >= 6 && slots[i].hour <= 23);
    const perSlot = wake.length ? remaining / wake.length : 0;
    for (const i of wake) {
      boiler[i] = Math.min(1, perSlot / (DEVICES.boiler.powerW / 1000));
    }
  }
  return { pool, boiler, car };
}

// ---------------------------------------------------------------------------
// Optimised plan - the customer's priority stack
//
// Pass 1: reserve surplus for the battery until it reaches its end-of-solar-day
//         target. Battery is rank 1 in summer, so it gets first claim.
// Pass 2: rank the remaining hours by the MARGINAL cost of the energy a load
//         would consume there:
//            - an hour with leftover surplus costs the forgone export price
//            - an hour without surplus costs the all-in import price
//         This is the avoided-import versus forgone-export spread from
//         architecture section 8.1, and it is why solar hours win by such a
//         margin in summer: 0.15 forgone versus 0.92 avoided is a 6x gap.
// Pass 3: fill pool, then car, then let the remainder export.
// ---------------------------------------------------------------------------

/**
 * Plan, simulate, feed the observed dawn SOC back in, replan. Three passes.
 *
 * Needed because the reservation is sized from SOC at dawn, but SOC at dawn
 * depends on what the plan scheduled overnight - and phase B deliberately puts
 * grid top-up in the cheapest night hours. Sizing the reservation against a
 * base-load-only night therefore under-books on exactly the days that matter.
 * Iterating to a fixed point resolves it without another heuristic.
 */
export function planOptimisedIterative(slots, req, stack = 'summer', passes = 3, opts = {}) {
  let dawnSoc = null;
  let plan = planOptimised(slots, req, stack, dawnSoc, opts);

  for (let p = 1; p < passes; p++) {
    const run = simulate(slots, plan, {
      batterySoc: INITIAL.batterySoc,
      batteryTargetBySlot: plan.batteryTargetBySlot,
      reservedW: plan.reservedW,
    });

    dawnSoc = {};
    for (const [day, idxs] of groupByDay(slots)) {
      const firstSun = idxs.find((i) => slots[i].pvW > 200);
      if (firstSun === undefined) continue;
      // SOC entering the first sunlit slot of the day.
      dawnSoc[day] = firstSun > 0 ? run.slots[firstSun - 1].soc : INITIAL.batterySoc;
    }
    plan = planOptimised(slots, req, stack, dawnSoc, opts);
  }
  return plan;
}

export function planOptimised(slots, req, stack = 'summer', dawnSocOverride = null, opts = {}) {
  // reserveBattery=false expresses the cost-led reading of the objective: the
  // battery takes leftover surplus rather than having it held back for it.
  // Architecture section 8.2 flags this as an unresolved product decision, so
  // both readings are produced rather than one being chosen silently.
  const reserveBattery = opts.reserveBattery !== false;
  const pool = new Array(SLOT_COUNT).fill(0);
  const boiler = new Array(SLOT_COUNT).fill(0);
  const car = new Array(SLOT_COUNT).fill(0);
  const batteryTargetBySlot = new Array(SLOT_COUNT).fill(null);

  // --- Pass 1: battery reservation -----------------------------------------
  // Target 80% by the end of each solar day. Protect that SOC from being
  // discharged into evening base load before the target is met.
  const days = groupByDay(slots);
  for (const [day, idxs] of days) {
    const solarEnd = [...idxs].reverse().find((i) => slots[i].pvW > 200);
    if (solarEnd === undefined) continue;
    for (const i of idxs) {
      if (i <= solarEnd) batteryTargetBySlot[i] = null;
    }
    // From the end of the solar day onward, hold at least 80%.
    for (const i of idxs) {
      if (i > solarEnd) batteryTargetBySlot[i] = 0.80;
    }
  }

  // --- Pass 2: rank hours by marginal cost ---------------------------------
  //
  // Rank against RAW solar surplus (PV minus base load), not against what is
  // left after the battery has charged. Using the post-battery residual was a
  // bug: the battery is rank 1 and charges greedily, so it consumed the whole
  // surplus in the probe, every solar hour then looked "no surplus", and the
  // pool got scheduled into cheap NIGHT hours on grid import instead. The
  // battery only has first claim up to its 80% target - beyond that the pool
  // outranks it, and the simulator already enforces that ordering because
  // scheduled loads are subtracted before the battery sees the surplus.
  const rank = slots.map((s, i) => {
    const hasSurplus = s.surplusW > 100;
    let cost;
    if (s.importSek === null) {
      // Advisory slot: no published price. Solar-first is the only defensible
      // ranking. Non-solar advisory hours rank below every priced hour so the
      // planner never moves work into an unpriced night on a guess.
      cost = hasSurplus ? 0.10 - Math.min(0.09, s.surplusW / 100000) : 9.99;
    } else {
      // Consuming a surplus watt costs the forgone export price; consuming a
      // non-surplus watt costs the full import price. In August that is
      // roughly 0.19 versus 0.92 - a 5x gap that pulls work into daylight.
      cost = hasSurplus ? s.exportSek : s.importSek;
    }
    return { i, cost, surplusW: s.surplusW, day: s.day };
  });

  // --- Pass 3: fill sinks in priority order --------------------------------
  //
  // Two phases per load. Phase A spends real forecast surplus and is capped by
  // how much surplus each hour actually has - packing a 3.66 kW pool into an
  // hour holding 176 W of surplus is not solar heating, it is a battery raid
  // dressed up as one. Phase B places whatever is left into the cheapest
  // PRICED import hours, which is honest grid top-up.

  const surplusLeftW = slots.map((s) => s.surplusW);
  const slotPowerW = new Array(SLOT_COUNT).fill(0); // concurrency accounting

  // Battery is rank 1 in summer: reserve its shortfall to the 80% target from
  // the earliest surplus, because that is what the inverter physically does.
  const days2 = groupByDay(slots);
  const reservedW = new Array(SLOT_COUNT).fill(0);
  const rank1 = {}; // per-day report: can the battery target actually be met?

  const dayList = [...days2.entries()];
  let socProbe = INITIAL.batterySoc;

  for (let d = 0; d < dayList.length; d++) {
    const [day, idxs] = dayList[d];
    const daySurplusKwh = idxs.reduce((a, i) => a + surplusLeftW[i] / 1000, 0);

    // A day with no usable surplus (here: the 1-slot 2026-08-09 tail) cannot
    // charge anything. Carry SOC forward across it instead of booking a
    // reservation that can never be filled, which is what made every later day
    // believe it started at 80%.
    if (daySurplusKwh < 0.5) {
      const drainKwh = idxs.reduce((a, i) => a + slots[i].baseW / 1000, 0);
      socProbe = Math.max(PLANT.socMin, socProbe - drainKwh / PLANT.batteryCapacityKwh);
      rank1[day] = { neededKwh: 0, reservedKwh: 0, shortfallKwh: 0, achievable: true, noSolar: true };
      continue;
    }

    // Size the reservation from SOC at DAWN, not at midnight. The pack spends
    // the pre-dawn hours covering base load, so a need computed at 00:00
    // under-books by however much the night costs - roughly 9 SOC points here,
    // which is why the battery kept finishing the solar day near 29% while the
    // feasibility report happily said the 80% target was met.
    const firstSun = idxs.find((i) => slots[i].pvW > 200) ?? idxs[0];
    let preDawnKwh = 0;
    for (const i of idxs) { if (i >= firstSun) break; preDawnKwh += slots[i].baseW / 1000; }
    // A measured dawn SOC from the previous iteration beats the analytic guess,
    // because it already accounts for whatever the plan scheduled overnight.
    const socAtDawn = dawnSocOverride?.[day] !== undefined
      ? dawnSocOverride[day]
      : Math.max(PLANT.socMin, socProbe - preDawnKwh / PLANT.batteryCapacityKwh);

    const needKwh0 = reserveBattery
      ? Math.max(0, (0.80 - socAtDawn) * PLANT.batteryCapacityKwh) / PLANT.chargeEff
      : 0;
    let needKwh = needKwh0;

    // Reserve CHRONOLOGICALLY across the surplus hours, which is what the
    // inverter physically does - the battery takes the morning sun as it
    // arrives. Reserving from the largest-surplus hour instead concentrated the
    // whole allocation into a single late slot and left the pack sitting at its
    // floor through eight hours of daylight, which satisfies the letter of
    // "80% by end of solar day" while destroying the resilience it is for.
    for (const i of idxs) {
      if (needKwh <= 1e-6) break;
      const takeW = Math.min(surplusLeftW[i], PLANT.batteryChargeMaxW, needKwh * 1000);
      if (takeW <= 0) continue;
      surplusLeftW[i] -= takeW;
      reservedW[i] += takeW;
      needKwh -= takeW / 1000;
    }

    // Rank 1 is "battery to 80% by end of solar day". If the day's surplus
    // cannot cover it, say so - do not silently under-serve the top priority.
    rank1[day] = {
      neededKwh: needKwh0,
      reservedKwh: needKwh0 - needKwh,
      shortfallKwh: needKwh,
      achievable: needKwh <= 1e-3,
      daySurplusKwh,
    };

    // Carry SOC to the NEXT dawn: what the battery actually reached, less the
    // base load it must cover between this day's last sun and the next day's
    // first. Previously this assumed 80% every morning, which hid the fact that
    // an 18 kWh pack loses roughly 29 SOC points to an 5.3 kWh Swedish night.
    const achievedSoc = Math.min(0.80,
      socAtDawn + ((needKwh0 - needKwh) * PLANT.chargeEff) / PLANT.batteryCapacityKwh);

    // Carry only to the END OF THIS DAY. The next day's own pre-dawn drain is
    // handled by its own socAtDawn, so counting the whole night here would
    // double-charge it.
    const lastSun = [...idxs].reverse().find((i) => slots[i].pvW > 200) ?? idxs[idxs.length - 1];
    let eveningKwh = 0;
    for (const i of idxs) { if (i > lastSun) eveningKwh += slots[i].baseW / 1000; }
    socProbe = Math.max(PLANT.socMin, achievedSoc - eveningKwh / PLANT.batteryCapacityKwh);
  }

  // Reserved watts are not available to any lower-ranked sink, in any phase.
  const headroomW = (i) => Math.max(
    0,
    Math.min(PLANT.gridImportMaxW, PLANT.plantMaxActiveW)
      - slots[i].baseW - slotPowerW[i] - reservedW[i],
  );

  const fill = (target, requiredKwh, device, dayIdxs) => {
    let remaining = requiredKwh;
    const inDay = new Set(dayIdxs);

    // Phase A - solar surplus, cheapest first, capped by available surplus.
    const solar = rank
      .filter((r) => inDay.has(r.i) && surplusLeftW[r.i] > 100)
      .sort((a, b) => a.cost - b.cost || b.surplusW - a.surplusW || a.i - b.i);

    for (const c of solar) {
      if (remaining <= 1e-6) break;
      const capW = Math.min(device.powerW, surplusLeftW[c.i], headroomW(c.i));
      if (capW <= 100) continue;
      const frac = Math.min(capW / device.powerW, remaining / (device.powerW / 1000),
                            1 - (target[c.i] ?? 0));
      if (frac <= 1e-6) continue;
      const takenW = frac * device.powerW;
      target[c.i] = (target[c.i] ?? 0) + frac;
      slotPowerW[c.i] += takenW;
      surplusLeftW[c.i] -= takenW;
      remaining -= takenW / 1000;
    }

    // Phase B - grid top-up, cheapest PRICED hours only, and ONLY in hours with
    // no unclaimed surplus left. Without that second filter this phase drops
    // load straight into the middle of the solar day and cannibalises the
    // battery's reservation, which is how the plan ended 08-10 at 22% while
    // reporting its rank-1 target as met. Unpriced advisory hours are never
    // used for grid work; that would be guessing.
    const grid = rank
      .filter((r) => inDay.has(r.i) && slots[r.i].importSek !== null
                     && reservedW[r.i] <= 100)
      .sort((a, b) => slots[a.i].importSek - slots[b.i].importSek || a.i - b.i);

    for (const c of grid) {
      if (remaining <= 1e-6) break;
      const capW = Math.min(device.powerW, headroomW(c.i));
      if (capW <= 100) continue;
      const frac = Math.min(capW / device.powerW, remaining / (device.powerW / 1000),
                            1 - (target[c.i] ?? 0));
      if (frac <= 1e-6) continue;
      const takenW = frac * device.powerW;
      target[c.i] = (target[c.i] ?? 0) + frac;
      slotPowerW[c.i] += takenW;
      remaining -= takenW / 1000;
    }

    // Phase C - unpriced days have no import ranking, so fall back to spreading
    // the remainder across that day's daylight hours at whatever power fits.
    if (remaining > 1e-6) {
      const anyDaylight = [...dayIdxs]
        .filter((i) => slots[i].pvW > 0 && (target[i] ?? 0) < 1)
        .sort((a, b) => slots[b].pvW - slots[a].pvW);
      for (const i of anyDaylight) {
        if (remaining <= 1e-6) break;
        const capW = Math.min(device.powerW, headroomW(i));
        if (capW <= 100) continue;
        const frac = Math.min(capW / device.powerW, remaining / (device.powerW / 1000),
                              1 - (target[i] ?? 0));
        if (frac <= 1e-6) continue;
        target[i] = (target[i] ?? 0) + frac;
        slotPowerW[i] += frac * device.powerW;
        remaining -= frac * device.powerW / 1000;
      }
    }

    return remaining;
  };

  const unmet = {};
  for (const [day, r] of Object.entries(req)) {
    // Hot water first: a hard service commitment, not an optimisation sink.
    unmet[`${day}:boiler`] = fill(boiler, r.boilerKwh, DEVICES.boiler, r.slots);
    unmet[`${day}:pool`] = fill(pool, r.poolKwh, DEVICES.pool, r.slots);
    unmet[`${day}:car`] = fill(car, r.carKwh, DEVICES.car, r.slots);
  }

  return { pool, boiler, car, batteryTargetBySlot, unmet, rank1, reservedW };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verify(result) {
  const problems = [];
  const TOL = 1e-6;

  for (const r of result.slots) {
    const inW = r.pvW + r.importW + r.battDischargeW;
    const outW = r.loadW + r.exportW + r.battChargeW + r.curtailedW;
    if (Math.abs(inW - outW) > 1) {
      problems.push(`slot ${r.index} (${r.label}): energy balance off by ${(inW - outW).toFixed(1)} W`);
    }
    if (r.soc < PLANT.socMin - TOL || r.soc > PLANT.socMax + TOL) {
      problems.push(`slot ${r.index}: SOC ${(r.soc * 100).toFixed(1)}% outside [${PLANT.socMin * 100}, ${PLANT.socMax * 100}]`);
    }
    if (r.importW > PLANT.gridImportMaxW + TOL) {
      problems.push(`slot ${r.index}: import ${r.importW.toFixed(0)} W exceeds ${PLANT.gridImportMaxW} W`);
    }
    if (r.importW > 0 && r.exportW > 0) {
      problems.push(`slot ${r.index}: importing and exporting simultaneously`);
    }
    if (r.battChargeW > 0 && r.battDischargeW > 0) {
      problems.push(`slot ${r.index}: charging and discharging simultaneously`);
    }
  }
  return problems;
}
