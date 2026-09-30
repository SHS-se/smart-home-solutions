/** Reachable one-quarter search actions. Energy goals never quantize physical state. */
import {
  type Conversion,
  convertedFlows,
  gridPower,
  outputPower,
  solarCapacity,
} from "./planner/battery-conversion.ts";
import type { HouseholdCandidate, HouseholdProblem } from "./planner/household-case.ts";

export type BatteryAction = Extract<
  HouseholdCandidate["actions"][string][number],
  { kind: "battery" }
>;
export type BatterySearchScope = { kind: "physical" } | {
  kind: "pv_first";
  house_supply_max_w: readonly number[];
  export_eligible: readonly boolean[];
  export_reserve_kwh: number;
};
export type BatteryStep = { action: BatteryAction; curtail_w: number };
type Piece = {
  charge: boolean;
  lo: number;
  hi: number;
  openLo: boolean;
  slope: number;
  constant: number;
  exporting: boolean;
};
const EPS = 1e-7;
const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

export function batteryAction(
  charge: number,
  discharge: number,
  pv: number,
  load: number,
  conversion?: Conversion,
): BatteryAction {
  const f = conversion
    ? convertedFlows(conversion, charge, discharge, pv, load)
    : null;
  return {
    kind: "battery",
    charge_w: charge,
    discharge_w: discharge,
    solar_charge_w: f ? f.solar : Math.min(charge, pv),
    export_w: f
      ? Math.max(0, f.discharge - Math.max(0, load - pv))
      : Math.max(0, discharge - load),
  };
}

export function createBatteryActionDomain(
  problem: HouseholdProblem,
  scope: BatterySearchScope = { kind: "physical" },
) {
  const equipment = problem.plant.equipment[0];
  if (equipment.kind !== "battery" || problem.plant.equipment.length !== 1) {
    throw new Error("Action domain requires one battery");
  }
  const b = equipment;
  if (
    scope.kind === "pv_first" &&
    (scope.house_supply_max_w.length !== problem.intervals.length ||
      scope.export_eligible.length !== problem.intervals.length ||
      scope.house_supply_max_w.some((x) => !Number.isFinite(x) || x < 0) ||
      !Number.isFinite(scope.export_reserve_kwh))
  ) throw new Error("Invalid native search scope");
  const rows = problem.intervals.map((interval, i) => ({
    hours: (Date.parse(interval.end) - Date.parse(interval.start)) / 3600000,
    load: problem.plant.residual_loads.reduce((s, l) => s + l.power_w[i], 0),
    pv: problem.plant.pv_w[i],
    pieces: new Map<number, Piece[]>(),
  }));
  const energyAfter = (i: number, energy: number, a: BatteryAction) =>
    energy + rows[i].hours / 1000 *
      (a.charge_w * (b.conversion ? 1 : b.charge_efficiency) -
        a.discharge_w / (b.conversion ? 1 : b.discharge_efficiency));

  // Additional native authority only. The household scorer remains the physical authority.
  function admits(
    i: number,
    before: number,
    a: BatteryAction,
    curtail: number,
  ): boolean {
    if (scope.kind === "physical") return true;
    const { load, pv } = rows[i], deficit = Math.max(0, load - pv);
    if (curtail !== 0 || (!b.available[i] && a.charge_w + a.discharge_w > 0)) {
      return false;
    }
    const solar = b.conversion
      ? solarCapacity(b.conversion, pv, load)
      : Math.max(0, pv - load);
    if (!b.grid_charge_allowed[i] && a.charge_w > solar + EPS) return false;
    const delivered = b.conversion
      ? outputPower(b.conversion.discharge, a.discharge_w)
      : a.discharge_w;
    if (Math.min(delivered, deficit) > scope.house_supply_max_w[i] + EPS) {
      return false;
    }
    if (
      delivered > deficit + EPS &&
      (!b.export_allowed[i] || !scope.export_eligible[i] ||
        before <= scope.export_reserve_kwh ||
        energyAfter(i, before, a) < scope.export_reserve_kwh - EPS)
    ) return false;
    return true;
  }

  function pieces(i: number, curtail: number): Piece[] {
    const row = rows[i], cached = row.pieces.get(curtail);
    if (cached) return cached;
    const result: Piece[] = [];
    if (
      !b.available[i] || curtail < 0 || curtail > row.pv ||
      (b.conversion && curtail !== 0) ||
      (scope.kind === "pv_first" && curtail !== 0)
    ) return result;
    const pv = row.pv - curtail,
      load = row.load,
      deficit = Math.max(0, load - pv),
      f = b.conversion;
    const net = (charge: boolean, p: number) =>
      f
        ? gridPower(f, charge ? p : 0, charge ? 0 : p, pv, load)
        : load - pv + (charge ? p : -p);
    // Discharge output has a zero plateau. Its positive-power ceiling includes it.
    const dischargeCeiling = (ac: number) =>
      f ? (ac + f.discharge.overhead_w) / f.discharge.gain : ac;
    const add = (
      charge: boolean,
      lo: number,
      hi: number,
      openLo: boolean,
      exporting = false,
    ) => {
      if (!(hi > lo) || hi <= 0) return;
      // Evaluate the affine grid account strictly inside each conversion regime.
      // This reuses the authoritative conversion, including activation overhead.
      const x = lo + (hi - lo) / 2;
      const slope = f
        ? (charge
          ? 1 /
            (x <= solarCapacity(f, pv, load)
              ? f.surplus_charge.gain
              : f.grid_charge.gain)
          : -f.discharge.gain)
        : charge
        ? 1
        : -1;
      const constant = net(charge, x) - slope * x;
      let lower = lo, upper = hi;
      const gridLo = -problem.plant.grid.export_limit_w,
        gridHi = problem.plant.grid.import_limit_w;
      if (slope > 0) {
        lower = Math.max(lower, (gridLo - constant) / slope);
        upper = Math.min(upper, (gridHi - constant) / slope);
      } else {
        lower = Math.max(lower, (gridHi - constant) / slope);
        upper = Math.min(upper, (gridLo - constant) / slope);
      }
      lower = Math.max(lo, lower);
      upper = Math.min(hi, upper);
      const open = lower === lo && openLo;
      if (upper < lower || (upper === lower && open)) return;
      result.push({
        charge,
        lo: lower,
        hi: upper,
        openLo: open,
        slope,
        constant,
        exporting,
      });
    };
    let chargeMax = b.charge_max_w;
    if (!b.grid_charge_allowed[i]) {
      chargeMax = Math.min(
        chargeMax,
        f
          ? solarCapacity(f, pv, load)
          : scope.kind === "pv_first"
          ? Math.max(0, pv - load)
          : pv,
      );
    }
    const solar = f ? solarCapacity(f, pv, load) : 0;
    if (solar > 0 && solar < chargeMax) {
      add(true, 0, solar, true);
      add(true, solar, chargeMax, true);
    } else add(true, 0, chargeMax, true);
    if (scope.kind === "pv_first") {
      const supply = Math.min(deficit, scope.house_supply_max_w[i]);
      add(
        false,
        0,
        Math.min(b.discharge_max_w, dischargeCeiling(supply)),
        true,
      );
      if (
        scope.house_supply_max_w[i] >= deficit && b.export_allowed[i] &&
        scope.export_eligible[i]
      ) {
        add(false, dischargeCeiling(deficit), b.discharge_max_w, true, true);
      }
    } else {add(
        false,
        0,
        Math.min(
          b.discharge_max_w,
          b.export_allowed[i] ? Infinity : dischargeCeiling(f ? deficit : load),
        ),
        true,
      );}
    row.pieces.set(curtail, result);
    return result;
  }

  function propose(
    i: number,
    energy: number,
    goals: readonly number[],
    fractions: readonly number[],
    previousImport: number | null,
  ): BatteryStep[] {
    const row = rows[i], f = b.conversion;
    const chargeRoom = Math.max(
      0,
      (b.state_kwh.max - energy) * 1000 / row.hours /
        (f ? 1 : b.charge_efficiency),
    );
    const dischargeRoom = Math.max(
      0,
      (energy - b.state_kwh.min) * 1000 / row.hours *
        (f ? 1 : b.discharge_efficiency),
    );
    const curtails = scope.kind === "pv_first" || f ? [0] : sorted([
      ...fractions.map((x) => x * row.pv),
      ...[energy, ...goals].map((goal) => {
        const c = Math.min(
          chargeRoom,
          b.charge_max_w,
          Math.max(0, goal - energy) * 1000 / row.hours / b.charge_efficiency,
        );
        const d = Math.min(
          dischargeRoom,
          b.discharge_max_w,
          Math.max(0, energy - goal) * 1000 / row.hours *
            b.discharge_efficiency,
        );
        return Math.max(
          0,
          row.pv + d - row.load - c - problem.plant.grid.export_limit_w,
        );
      }),
    ]);
    const result = new Map<string, BatteryStep>();
    const put = (charge: number, discharge: number, curtail: number) => {
      const action = batteryAction(
        charge,
        discharge,
        row.pv - curtail,
        row.load,
        f,
      );
      if (!admits(i, energy, action, curtail)) return;
      const key = JSON.stringify([charge, discharge, curtail]);
      result.set(key, { action, curtail_w: curtail });
    };
    for (const curtail of curtails) {
      if (curtail > row.pv) continue;
      put(0, 0, curtail);
      for (const piece of pieces(i, curtail)) {
        const room = piece.charge ? chargeRoom : Math.min(
          dischargeRoom,
          piece.exporting && scope.kind === "pv_first"
            ? Math.max(
              0,
              (energy -
                scope.export_reserve_kwh) *
                1000 / row.hours * (f ? 1 : b.discharge_efficiency),
            )
            : Infinity,
        );
        const hi = Math.min(piece.hi, room), lo = piece.lo;
        if (hi < lo || (hi === lo && piece.openLo)) continue;
        const values = [lo, hi, (lo + hi) / 2, -piece.constant / piece.slope];
        if (previousImport !== null) {
          values.push((previousImport - piece.constant) / piece.slope);
        }
        if (!piece.charge && f) {
          values.push(f.discharge.overhead_w / f.discharge.gain);
        }
        for (const goal of goals) {
          const delta = piece.charge ? goal - energy : energy - goal;
          if (delta <= 0) continue;
          const power = delta * 1000 / row.hours *
            (piece.charge
              ? 1 / (f ? 1 : b.charge_efficiency)
              : (f ? 1 : b.discharge_efficiency));
          values.push(Math.max(lo, Math.min(hi, power)));
        }
        for (const power of sorted(values)) {
          if (
            power <= 0 || power < lo || power > hi ||
            (power === lo && piece.openLo)
          ) continue;
          put(piece.charge ? power : 0, piece.charge ? 0 : power, curtail);
        }
      }
    }
    return [...result.values()];
  }

  return {
    propose,
    admits,
    energyAfter,
    // At most 2 charge + 2 discharge pieces, each goals + 6 structural points.
    proposalBound: (goals: number, fractions: number) =>
      (scope.kind === "pv_first" || b.conversion ? 1 : fractions + goals + 1) *
      (1 + 4 * (goals + 6)),
  };
}
