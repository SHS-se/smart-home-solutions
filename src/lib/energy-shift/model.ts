/**
 * Load-shift model at the canonical 900 s timestep.
 *
 * Two responsibilities, kept separate on purpose:
 *
 *   planX()    decides WHICH slots each deferrable load runs in, from forecasts.
 *   simulate() executes a schedule against device physics and reports the energy
 *              balance. It is the single source of truth and never trusts the
 *              planner - it clamps to SOC bounds, power limits and the grid
 *              envelope regardless of what was asked for.
 *
 * The planner emits an ordered surplus-allocation policy rather than a power
 * schedule, per ENERGY_OPTIMISATION_NOTES section 12e.
 */

import {
  PLANT, INITIAL, DEVICES, PV_FORECAST_W, BASE_LOAD_HOURLY_W,
  GRID_IMPORT_SEK, GRID_EXPORT_SEK, SPOT_SEK,
  SLOT_COUNT, SLOT_HOURS, BINDING_UNTIL_SLOT,
  HORIZON_START_DAY, HORIZON_START_QUARTER,
} from './inputs';

const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'];

export interface Slot {
  index: number;
  day: string;
  quarter: number;
  hour: number;
  minute: number;
  label: string;
  isoLocal: string;
  pvW: number;
  baseW: number;
  spotSek: number | null;
  importSek: number | null;
  exportSek: number | null;
  binding: boolean;
  surplusW: number;
}

export interface Schedule {
  pool: number[];
  boiler: number[];
  car: number[];
  batteryTargetBySlot?: (number | null)[];
  reservedW?: number[];
}

/** 288 quarter-hour slots from HORIZON_START_DAY / HORIZON_START_QUARTER. */
export function buildHorizon(): Slot[] {
  const slots: Slot[] = [];
  let dayIdx = DAYS.indexOf(HORIZON_START_DAY);
  let q = HORIZON_START_QUARTER;

  for (let i = 0; i < SLOT_COUNT; i++) {
    const day = DAYS[dayIdx];
    const hour = Math.floor(q / 4);
    const minute = (q % 4) * 15;
    const spot = SPOT_SEK[day]?.[q] ?? null;
    const pvW = PV_FORECAST_W[day]?.[q] ?? 0;
    // Base load is hourly; hold it flat across the four quarters of its hour
    // rather than interpolating structure the source does not have.
    const baseW = BASE_LOAD_HOURLY_W[hour];

    slots.push({
      index: i,
      day,
      quarter: q,
      hour,
      minute,
      label: `${day.slice(5)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      isoLocal: `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
      pvW,
      baseW,
      spotSek: spot,
      importSek: spot === null ? null : GRID_IMPORT_SEK + spot,
      exportSek: spot === null ? null : GRID_EXPORT_SEK + spot,
      binding: i < BINDING_UNTIL_SLOT,
      surplusW: Math.max(0, pvW - baseW),
    });

    q += 1;
    if (q === 96) { q = 0; dayIdx += 1; }
  }
  return slots;
}

export function groupByDay(slots: Slot[]): Map<string, number[]> {
  const days = new Map<string, number[]>();
  for (const s of slots) {
    if (!days.has(s.day)) days.set(s.day, []);
    days.get(s.day)!.push(s.index);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export interface SimSlot extends Slot {
  poolW: number; boilerW: number; carW: number; loadW: number;
  battChargeW: number; battDischargeW: number;
  importW: number; exportW: number; curtailedW: number;
  soc: number;
  importCost: number | null;
  exportRevenue: number | null;
}

export interface SimTotals {
  pvKwh: number; loadKwh: number; baseKwh: number;
  poolKwh: number; boilerKwh: number; carKwh: number;
  importKwh: number; exportKwh: number; curtailedKwh: number;
  importCost: number; exportRevenue: number; netCost: number;
  unpricedImportKwh: number; unpricedExportKwh: number;
  socStart: number; socEnd: number;
}

export function simulate(
  slots: Slot[],
  schedule: Partial<Schedule>,
  opts: { batterySoc?: number; batteryTargetBySlot?: (number | null)[]; reservedW?: number[] } = {},
): { slots: SimSlot[]; totals: SimTotals } {
  const cap = PLANT.batteryCapacityKwh;
  const H = SLOT_HOURS;
  let soc = opts.batterySoc ?? INITIAL.batterySoc;

  const out: SimSlot[] = [];
  const totals: SimTotals = {
    pvKwh: 0, loadKwh: 0, baseKwh: 0, poolKwh: 0, boilerKwh: 0, carKwh: 0,
    importKwh: 0, exportKwh: 0, curtailedKwh: 0,
    importCost: 0, exportRevenue: 0, netCost: 0,
    unpricedImportKwh: 0, unpricedExportKwh: 0,
    socStart: soc, socEnd: soc,
  };

  for (const s of slots) {
    const i = s.index;
    const poolW = (schedule.pool?.[i] ?? 0) * DEVICES.pool.powerW;
    const boilerW = (schedule.boiler?.[i] ?? 0) * DEVICES.boiler.powerW;
    const carW = (schedule.car?.[i] ?? 0) * DEVICES.car.powerW;
    const loadW = s.baseW + poolW + boilerW + carW;

    let battChargeW = 0;
    let battDischargeW = 0;
    let importW = 0;
    let exportW = 0;
    let curtailedW = 0;

    const socTarget = opts.batteryTargetBySlot?.[i] ?? null;
    const roomKwh = (PLANT.socMax - soc) * cap;
    const availKwh = (soc - PLANT.socMin) * cap;
    // Convert energy headroom to a power limit over ONE SLOT, not one hour.
    const maxChargeW = Math.min(PLANT.batteryChargeMaxW, (roomKwh / PLANT.chargeEff) * 1000 / H);
    const maxDischargeW = Math.min(PLANT.batteryDischargeMaxW, availKwh * PLANT.dischargeEff * 1000 / H);

    // Rank 1 first: the battery takes its reserved share of PV before any load
    // sees it, capped at the real surplus over base load so a reservation can
    // never cause an import purely to charge.
    //
    // Capped at PV minus the WHOLE load, not just base load. Capping at base
    // load alone let the reserve claim watts the scheduled deferrables were
    // already consuming, and the slot then had to charge and discharge at the
    // same instant - which the verifier correctly rejects as unphysical. The
    // reservation's real work happens in the planner, which keeps lower-ranked
    // sinks out of these slots; here it is only ever physics.
    const reserveW = opts.reservedW?.[i] ?? 0;
    const reserveTakeW = Math.min(reserveW, Math.max(0, s.pvW - loadW), maxChargeW);
    battChargeW = reserveTakeW;
    const netW = (s.pvW - reserveTakeW) - loadW;

    if (netW > 0) {
      const extraW = Math.min(netW, maxChargeW - battChargeW);
      battChargeW += extraW;
      const toGridW = netW - extraW;
      exportW = Math.min(toGridW, PLANT.gridExportMaxW);
      curtailedW = toGridW - exportW;
    } else if (netW < 0) {
      const deficitW = -netW;
      let allowedDischargeW = maxDischargeW;
      if (socTarget !== null) {
        const protectedKwh = Math.max(0, (soc - socTarget) * cap);
        allowedDischargeW = Math.min(allowedDischargeW, protectedKwh * PLANT.dischargeEff * 1000 / H);
      }
      battDischargeW = Math.min(deficitW, allowedDischargeW);
      importW = Math.min(deficitW - battDischargeW, PLANT.gridImportMaxW);
    }

    soc += ((battChargeW * PLANT.chargeEff - battDischargeW / PLANT.dischargeEff) / 1000) * H / cap;
    soc = Math.min(PLANT.socMax, Math.max(PLANT.socMin, soc));

    const rec: SimSlot = {
      ...s,
      poolW, boilerW, carW, loadW,
      battChargeW, battDischargeW, importW, exportW, curtailedW, soc,
      importCost: s.importSek === null ? null : (importW / 1000) * H * s.importSek,
      exportRevenue: s.exportSek === null ? null : (exportW / 1000) * H * s.exportSek,
    };
    out.push(rec);

    totals.pvKwh += (s.pvW / 1000) * H;
    totals.baseKwh += (s.baseW / 1000) * H;
    totals.loadKwh += (loadW / 1000) * H;
    totals.poolKwh += (poolW / 1000) * H;
    totals.boilerKwh += (boilerW / 1000) * H;
    totals.carKwh += (carW / 1000) * H;
    totals.importKwh += (importW / 1000) * H;
    totals.exportKwh += (exportW / 1000) * H;
    totals.curtailedKwh += (curtailedW / 1000) * H;
    if (rec.importCost === null) totals.unpricedImportKwh += (importW / 1000) * H;
    else totals.importCost += rec.importCost;
    if (rec.exportRevenue === null) totals.unpricedExportKwh += (exportW / 1000) * H;
    else totals.exportRevenue += rec.exportRevenue;
  }

  totals.netCost = totals.importCost - totals.exportRevenue;
  totals.socEnd = soc;
  return { slots: out, totals };
}

// ---------------------------------------------------------------------------
// Requirements - derived from live state, never configured
// ---------------------------------------------------------------------------

export interface DayRequirement {
  poolKwh: number; boilerKwh: number; carKwh: number;
  slots: number[]; firstDay: boolean; partial: boolean;
}

export function deriveRequirements(slots: Slot[]): Record<string, DayRequirement> {
  const days = groupByDay(slots);
  const dayKeys = [...days.keys()];
  const req: Record<string, DayRequirement> = {};
  let carPlaced = false;

  for (const [day, idxs] of days) {
    const firstDay = day === dayKeys[0];
    // Both the first and last day are partial here (the horizon starts at 09:30
    // and ends at 09:15 three days later). Only the FIRST carries work already
    // done today; a short tail is just a truncated horizon.
    const truncatedTail = !firstDay && idxs.length < 96;
    const share = idxs.length / 96;

    let poolKwh = DEVICES.pool.dailyRequirementKwh;
    if (firstDay) {
      // Pool cycle is NOT complete today and the meters read 0, so the full
      // requirement remains - but only the part of the day still ahead of us.
      poolKwh = INITIAL.poolCompleteToday
        ? 0
        : Math.max(0, DEVICES.pool.dailyRequirementKwh - INITIAL.poolDoneTodayKwh);
    } else if (truncatedTail) {
      poolKwh *= share;
    }

    let boilerKwh = DEVICES.boiler.dailyRequirementKwh;
    if (firstDay) {
      boilerKwh = Math.max(0, boilerKwh - INITIAL.boilerDoneTodayKwh);
    } else if (truncatedTail) {
      boilerKwh *= share;
    }

    // Car: a ONE-OFF shortfall, not a daily quota - the pack does not empty
    // itself overnight. Scheduled only if the cable is actually connected; if
    // it is not, the requirement stays 0 and no arrival is assumed.
    //
    // Placed on the FIRST day so it lands inside the binding window. There is
    // no departure-time entity, so the planner may not defer it to a sunnier
    // advisory day on the assumption the car will still be here.
    let carKwh = 0;
    if (INITIAL.carConnected && INITIAL.carAtHome && !carPlaced) {
      const shortfall = Math.max(0, DEVICES.car.targetSoc - INITIAL.carSoc);
      carKwh = (shortfall * DEVICES.car.batteryKwh) / DEVICES.car.chargeEff;
      carPlaced = true;
    }

    req[day] = { poolKwh, boilerKwh, carKwh, slots: idxs, firstDay, partial: truncatedTail };
  }
  return req;
}

// ---------------------------------------------------------------------------
// Baseline - what the house does today
// ---------------------------------------------------------------------------

export function planBaseline(slots: Slot[], req: Record<string, DayRequirement>): Schedule {
  const pool = new Array(SLOT_COUNT).fill(0);
  const boiler = new Array(SLOT_COUNT).fill(0);
  const car = new Array(SLOT_COUNT).fill(0);
  const H = SLOT_HOURS;

  for (const r of Object.values(req)) {
    // Car: charges the moment it is plugged in, at full power, sun or not.
    let remaining = r.carKwh;
    for (const i of r.slots) {
      if (remaining <= 1e-9) break;
      const perSlot = (DEVICES.car.powerW / 1000) * H;
      const frac = Math.min(1, remaining / perSlot);
      car[i] = frac;
      remaining -= frac * perSlot;
    }

    // Pool: fixed midday block, as observed on 2026-08-01.
    remaining = r.poolKwh;
    for (const i of r.slots) {
      if (remaining <= 1e-9) break;
      if (slots[i].hour < 12) continue;
      const perSlot = (DEVICES.pool.powerW / 1000) * H;
      const frac = Math.min(1, remaining / perSlot);
      pool[i] = frac;
      remaining -= frac * perSlot;
    }

    // Boiler: trickles across waking hours.
    remaining = r.boilerKwh;
    const wake = r.slots.filter((i) => slots[i].hour >= 6 && slots[i].hour <= 23);
    if (wake.length) {
      const perSlotEnergy = remaining / wake.length;
      for (const i of wake) {
        boiler[i] = Math.min(1, perSlotEnergy / ((DEVICES.boiler.powerW / 1000) * H));
      }
    }
  }
  return { pool, boiler, car };
}

// ---------------------------------------------------------------------------
// Optimised - the customer's summer priority stack
// ---------------------------------------------------------------------------

export interface OptPlan extends Schedule {
  batteryTargetBySlot: (number | null)[];
  reservedW: number[];
  unmet: Record<string, number>;
  rank1: Record<string, {
    neededKwh: number; reservedKwh: number; shortfallKwh: number;
    achievable: boolean; noSolar?: boolean; daySurplusKwh?: number;
  }>;
}

/**
 * Plan, simulate, feed the observed dawn SOC back in, replan.
 *
 * The reservation is sized from SOC at dawn, but SOC at dawn depends on what
 * the plan scheduled overnight - and phase B deliberately puts grid top-up in
 * the cheapest night slots. Sizing against a base-load-only night therefore
 * under-books on exactly the days that matter. Iterating resolves it without
 * another heuristic; it converges by the second pass on this data.
 */
export function planOptimisedIterative(
  slots: Slot[],
  req: Record<string, DayRequirement>,
  opts: { reserveBattery?: boolean } = {},
  passes = 3,
): OptPlan {
  let dawnSoc: Record<string, number> | null = null;
  let plan = planOptimised(slots, req, dawnSoc, opts);

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
      dawnSoc[day] = firstSun > 0 ? run.slots[firstSun - 1].soc : INITIAL.batterySoc;
    }
    plan = planOptimised(slots, req, dawnSoc, opts);
  }
  return plan;
}

export function planOptimised(
  slots: Slot[],
  req: Record<string, DayRequirement>,
  dawnSocOverride: Record<string, number> | null = null,
  opts: { reserveBattery?: boolean } = {},
): OptPlan {
  // reserveBattery=false expresses the cost-led reading of the objective: the
  // battery takes leftover surplus rather than having sun held back for it.
  // Architecture section 8.2 flags this as an open product decision, so both
  // readings are produced rather than one being chosen silently.
  const reserveBattery = opts.reserveBattery !== false;
  const H = SLOT_HOURS;

  const pool = new Array(SLOT_COUNT).fill(0);
  const boiler = new Array(SLOT_COUNT).fill(0);
  const car = new Array(SLOT_COUNT).fill(0);
  const batteryTargetBySlot: (number | null)[] = new Array(SLOT_COUNT).fill(null);
  const reservedW = new Array(SLOT_COUNT).fill(0);
  const surplusLeftW = slots.map((s) => s.surplusW);
  const slotPowerW = new Array(SLOT_COUNT).fill(0);
  const rank1: OptPlan['rank1'] = {};

  const days = groupByDay(slots);

  // Hold at least 80% from the end of each solar day onward.
  for (const [, idxs] of days) {
    const solarEnd = [...idxs].reverse().find((i) => slots[i].pvW > 200);
    if (solarEnd === undefined) continue;
    for (const i of idxs) if (i > solarEnd) batteryTargetBySlot[i] = 0.80;
  }

  // --- Pass 1: battery reservation -----------------------------------------
  const dayList = [...days.entries()];
  let socProbe = INITIAL.batterySoc;

  for (let d = 0; d < dayList.length; d++) {
    const [day, idxs] = dayList[d];
    const daySurplusKwh = idxs.reduce((a, i) => a + (surplusLeftW[i] / 1000) * H, 0);

    if (daySurplusKwh < 0.5) {
      const drainKwh = idxs.reduce((a, i) => a + (slots[i].baseW / 1000) * H, 0);
      socProbe = Math.max(PLANT.socMin, socProbe - drainKwh / PLANT.batteryCapacityKwh);
      rank1[day] = { neededKwh: 0, reservedKwh: 0, shortfallKwh: 0, achievable: true, noSolar: true };
      continue;
    }

    // Size from SOC at DAWN, not at midnight - the pack spends the pre-dawn
    // slots covering base load, and a need computed at 00:00 under-books by
    // however much the night costs.
    const firstSun = idxs.find((i) => slots[i].pvW > 200) ?? idxs[0];
    let preDawnKwh = 0;
    for (const i of idxs) { if (i >= firstSun) break; preDawnKwh += (slots[i].baseW / 1000) * H; }

    const socAtDawn = dawnSocOverride?.[day] !== undefined
      ? dawnSocOverride[day]
      : Math.max(PLANT.socMin, socProbe - preDawnKwh / PLANT.batteryCapacityKwh);

    const needKwh0 = reserveBattery
      ? Math.max(0, (0.80 - socAtDawn) * PLANT.batteryCapacityKwh) / PLANT.chargeEff
      : 0;
    let needKwh = needKwh0;

    // Reserve CHRONOLOGICALLY across surplus slots, which is what the inverter
    // physically does. Reserving from the largest-surplus slot instead put the
    // whole allocation into one late block and left the pack on its floor
    // through most of the daylight.
    for (const i of idxs) {
      if (needKwh <= 1e-9) break;
      const takeW = Math.min(surplusLeftW[i], PLANT.batteryChargeMaxW, (needKwh * 1000) / H);
      if (takeW <= 0) continue;
      surplusLeftW[i] -= takeW;
      reservedW[i] += takeW;
      needKwh -= (takeW / 1000) * H;
    }

    rank1[day] = {
      neededKwh: needKwh0,
      reservedKwh: needKwh0 - needKwh,
      shortfallKwh: needKwh,
      achievable: needKwh <= 1e-3,
      daySurplusKwh,
    };

    const achievedSoc = Math.min(0.80,
      socAtDawn + ((needKwh0 - needKwh) * PLANT.chargeEff) / PLANT.batteryCapacityKwh);
    const lastSun = [...idxs].reverse().find((i) => slots[i].pvW > 200) ?? idxs[idxs.length - 1];
    let eveningKwh = 0;
    for (const i of idxs) if (i > lastSun) eveningKwh += (slots[i].baseW / 1000) * H;
    socProbe = Math.max(PLANT.socMin, achievedSoc - eveningKwh / PLANT.batteryCapacityKwh);
  }

  // --- Pass 2: rank slots by marginal cost ---------------------------------
  //
  // Rank against RAW solar surplus, not the post-battery residual. Using the
  // residual was a bug: the battery is rank 1 and charges greedily, so it
  // consumed the whole surplus in the probe, every solar slot then looked
  // empty, and the pool got scheduled into cheap NIGHT slots on grid import.
  const rank = slots.map((s, i) => {
    const hasSurplus = s.surplusW > 100;
    let cost: number;
    if (s.importSek === null) {
      // Advisory slot: no published price. Solar-first is the only defensible
      // ranking, and non-solar advisory slots rank below every priced slot so
      // the planner never moves work into an unpriced night on a guess.
      cost = hasSurplus ? 0.10 - Math.min(0.09, s.surplusW / 100000) : 9.99;
    } else {
      // A surplus watt costs the forgone export price; a non-surplus watt costs
      // the full import price. In August that is ~0.24 against ~0.92.
      cost = hasSurplus ? s.exportSek! : s.importSek;
    }
    return { i, cost, surplusW: s.surplusW };
  });

  const headroomW = (i: number) => Math.max(
    0,
    Math.min(PLANT.gridImportMaxW, PLANT.plantMaxActiveW)
      - slots[i].baseW - slotPowerW[i] - reservedW[i],
  );

  // --- Pass 3: fill sinks in priority order --------------------------------
  const fill = (
    target: number[],
    requiredKwh: number,
    device: { powerW: number },
    dayIdxs: number[],
  ) => {
    let remaining = requiredKwh;
    const inDay = new Set(dayIdxs);
    const perSlotKwh = (device.powerW / 1000) * H;

    const place = (i: number, capW: number) => {
      if (capW <= 100 || remaining <= 1e-9) return;
      const frac = Math.min(capW / device.powerW, remaining / perSlotKwh, 1 - target[i]);
      if (frac <= 1e-9) return;
      target[i] += frac;
      slotPowerW[i] += frac * device.powerW;
      remaining -= frac * perSlotKwh;
    };

    // Phase A - solar surplus, cheapest first, capped by the surplus actually
    // present. Packing 3.66 kW into a slot holding 176 W of surplus is a
    // battery raid dressed up as solar heating.
    for (const c of rank
      .filter((r) => inDay.has(r.i) && surplusLeftW[r.i] > 100)
      .sort((a, b) => a.cost - b.cost || b.surplusW - a.surplusW || a.i - b.i)) {
      if (remaining <= 1e-9) break;
      const before = target[c.i];
      place(c.i, Math.min(device.powerW, surplusLeftW[c.i], headroomW(c.i)));
      surplusLeftW[c.i] -= (target[c.i] - before) * device.powerW;
    }

    // Phase B - grid top-up in the cheapest PRICED slots, excluding any slot
    // the battery has reserved. Without that exclusion this phase drops load
    // into the middle of the solar day and cannibalises the reservation.
    for (const c of rank
      .filter((r) => inDay.has(r.i) && slots[r.i].importSek !== null && reservedW[r.i] <= 100)
      .sort((a, b) => slots[a.i].importSek! - slots[b.i].importSek! || a.i - b.i)) {
      if (remaining <= 1e-9) break;
      place(c.i, Math.min(device.powerW, headroomW(c.i)));
    }

    // Phase C - advisory days have no price ranking; spread the remainder
    // across their brightest slots.
    if (remaining > 1e-9) {
      for (const i of [...dayIdxs]
        .filter((i) => slots[i].pvW > 0 && target[i] < 1)
        .sort((a, b) => slots[b].pvW - slots[a].pvW)) {
        if (remaining <= 1e-9) break;
        place(i, Math.min(device.powerW, headroomW(i)));
      }
    }
    return remaining;
  };

  const unmet: Record<string, number> = {};
  for (const [day, r] of Object.entries(req)) {
    // Hot water first: a hard service commitment, not an optimisation sink.
    unmet[`${day}:boiler`] = fill(boiler, r.boilerKwh, DEVICES.boiler, r.slots);
    unmet[`${day}:pool`] = fill(pool, r.poolKwh, DEVICES.pool, r.slots);
    unmet[`${day}:car`] = fill(car, r.carKwh, DEVICES.car, r.slots);
  }

  return { pool, boiler, car, batteryTargetBySlot, reservedW, unmet, rank1 };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verify(result: { slots: SimSlot[] }): string[] {
  const problems: string[] = [];
  const TOL = 1e-6;

  for (const r of result.slots) {
    const inW = r.pvW + r.importW + r.battDischargeW;
    const outW = r.loadW + r.exportW + r.battChargeW + r.curtailedW;
    if (Math.abs(inW - outW) > 1) {
      problems.push(`${r.label}: energy balance off by ${(inW - outW).toFixed(1)} W`);
    }
    if (r.soc < PLANT.socMin - TOL || r.soc > PLANT.socMax + TOL) {
      problems.push(`${r.label}: SOC ${(r.soc * 100).toFixed(1)}% out of bounds`);
    }
    if (r.importW > PLANT.gridImportMaxW + TOL) {
      problems.push(`${r.label}: import ${r.importW.toFixed(0)} W over limit`);
    }
    if (r.importW > 0 && r.exportW > 0) problems.push(`${r.label}: import and export together`);
    if (r.battChargeW > 0 && r.battDischargeW > 0) problems.push(`${r.label}: charge and discharge together`);
  }
  return problems;
}

/** Convenience: everything the UI needs, computed once. */
export function buildPlans() {
  const slots = buildHorizon();
  const req = deriveRequirements(slots);

  const basePlan = planBaseline(slots, req);
  const baseline = simulate(slots, basePlan, { batterySoc: INITIAL.batterySoc });

  const run = (p: OptPlan) => simulate(slots, p, {
    batterySoc: INITIAL.batterySoc,
    batteryTargetBySlot: p.batteryTargetBySlot,
    reservedW: p.reservedW,
  });

  const stackPlan = planOptimisedIterative(slots, req, { reserveBattery: true });
  const costPlan = planOptimisedIterative(slots, req, { reserveBattery: false });

  const stack = run(stackPlan);
  const cost = run(costPlan);

  return {
    slots, req,
    basePlan, baseline,
    stackPlan, stack,
    costPlan, cost,
    problems: [...verify(baseline), ...verify(stack), ...verify(cost)],
  };
}
