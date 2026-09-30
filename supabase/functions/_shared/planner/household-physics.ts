import { convertedFlows } from "./battery-conversion.ts";
/** Deterministic materialisation. No prices, preferences or utility are read here. */
import type {
  Equipment,
  HouseholdCandidate,
  HouseholdPlant,
  Violation,
} from "./household-case.ts";

export interface PhysicalInterval {
  import_w: number;
  export_w: number;
  curtailed_w: number;
  load_w: number;
  equipment_w: Record<string, number>;
  heat_w: Record<string, number>;
  charge_kwh: Record<string, number>;
  discharge_kwh: Record<string, number>;
  starts: string[];
}
export interface PhysicalTrajectory {
  intervals: PhysicalInterval[];
  state: Record<string, number[]>;
  violations: Violation[];
}
const EPS = 1e-7;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const legalLevel = (levels: number[], value: number) =>
  levels.some((v) => Math.abs(v - value) <= EPS);

type Battery = Extract<Equipment, { kind: "battery" }>;
type BatteryAction = Extract<
  HouseholdCandidate["actions"][string][number],
  { kind: "battery" }
>;
type Check = (condition: boolean, path: string, message: string) => void;

/** State-independent battery physics, shared by full trajectories and search. */
function batteryFlow(
  e: Battery,
  a: BatteryAction,
  i: number,
  h: number,
  load: number,
  pv: number,
  curtailed: number,
  equipmentCount: number,
  path: string,
  check: Check,
) {
  check(
    !e.conversion || equipmentCount === 1,
    path,
    "DC conversion requires materialized nonbattery residual loads",
  );
  check(
    !e.conversion || curtailed === 0,
    path,
    "PV First DC operation does not authorize solar curtailment",
  );
  check(
    a.charge_w <= e.charge_max_w + EPS &&
      a.discharge_w <= e.discharge_max_w + EPS,
    path,
    "battery exceeds rated power",
  );
  check(
    a.charge_w <= EPS || a.discharge_w <= EPS,
    path,
    "simultaneous charge and discharge",
  );
  check(
    e.available[i] || a.charge_w + a.discharge_w <= EPS,
    path,
    "battery unavailable",
  );
  check(
    !!e.conversion || a.solar_charge_w <= a.charge_w + EPS,
    path,
    "solar allocation exceeds charge",
  );
  check(
    a.export_w <= a.discharge_w + EPS,
    path,
    "export allocation exceeds discharge",
  );
  const f = e.conversion
    ? convertedFlows(
      e.conversion,
      a.charge_w,
      a.discharge_w,
      pv - curtailed,
      load,
    )
    : null;
  check(
    e.grid_charge_allowed[i] ||
      (f ? f.charge : a.charge_w) - a.solar_charge_w <= EPS,
    path,
    "grid charging not permitted",
  );
  check(
    e.export_allowed[i] || a.export_w <= EPS,
    path,
    "battery export not permitted",
  );
  if (f) {
    check(
      Math.abs(a.solar_charge_w - f.solar) <= EPS,
      path,
      "DC model solar attribution mismatch",
    );
    check(
      Math.abs(
        a.export_w -
          Math.max(0, f.discharge - Math.max(0, load - pv + curtailed)),
      ) <= EPS,
      path,
      "DC model export attribution mismatch",
    );
  }
  const charge = f ? f.charge : a.charge_w,
    discharge = f ? f.discharge : a.discharge_w;
  const charged = charge * h / 1000, discharged = discharge * h / 1000;
  // Preserve the exact arithmetic order used by complete trajectory scoring.
  const nextEnergy = f
    ? (before: number) => before + (a.charge_w - a.discharge_w) * h / 1000
    : (before: number) =>
      before + charged * e.charge_efficiency -
      discharged / e.discharge_efficiency;
  return {
    charge,
    discharge,
    charged,
    discharged,
    idle: f ? f.idle : 0,
    equipment_w: f
      ? f.charge - f.discharge + f.idle
      : a.charge_w - a.discharge_w,
    nextEnergy,
  };
}
function checkEnergy(
  value: number,
  e: Exclude<Equipment, { kind: "heater" }>,
  path: string,
  check: Check,
) {
  check(
    Number.isFinite(value) && value >= e.state_kwh.min - EPS &&
      value <= e.state_kwh.max + EPS,
    `${path}.state_kwh`,
    `state ${value} outside physical bounds`,
  );
}
function gridBalance(
  plant: HouseholdPlant,
  i: number,
  load: number,
  charge: number,
  discharge: number,
  solarCharge: number,
  batteryExport: number,
  curtailed: number,
  prefix: string,
  check: Check,
) {
  const pv = plant.pv_w[i] - curtailed;
  check(
    curtailed <= plant.pv_w[i] + EPS,
    prefix,
    "curtailment exceeds available PV",
  );
  const net = load + charge - discharge - pv;
  const imported = Math.max(0, net), exported = Math.max(0, -net);
  check(
    Number.isFinite(imported) && imported <= plant.grid.import_limit_w + EPS,
    prefix,
    "grid import limit exceeded",
  );
  check(
    Number.isFinite(exported) && exported <= plant.grid.export_limit_w + EPS,
    prefix,
    "grid export limit exceeded; curtailment must be explicit",
  );
  check(solarCharge <= pv + EPS, prefix, "solar charging exceeds available PV");
  check(
    charge - solarCharge <= imported + EPS,
    prefix,
    "claimed grid charging is not supplied by grid import",
  );
  check(
    batteryExport <= exported + EPS,
    prefix,
    "claimed battery export exceeds grid export",
  );
  check(
    exported - batteryExport <= pv - solarCharge + EPS,
    prefix,
    "unattributed battery export",
  );
  check(
    discharge - batteryExport <= load + EPS,
    prefix,
    "battery supply exceeds household load; battery-to-battery routing unsupported",
  );
  return { imported, exported };
}

/** Prepare an immutable physical action once; only stored energy varies by path.
 * Structural validation belongs to the caller, just as for materializeHousehold.
 */
export function prepareBatteryInterval(
  plant: HouseholdPlant,
  hours: number,
  i: number,
  action: BatteryAction,
  curtailed: number,
) {
  const equipment = plant.equipment[0];
  if (
    equipment.kind !== "battery" || plant.equipment.length !== 1 ||
    plant.thermal_stores.length
  ) {
    throw new Error(
      "Battery interval requires one battery and no thermal stores",
    );
  }
  const prefix = `intervals.${i}`, path = `${prefix}.${equipment.id}`;
  const beforeState: Violation[] = [], afterState: Violation[] = [];
  const checkBefore: Check = (ok, path, message) => {
    if (!ok) beforeState.push({ path, message });
  };
  const checkAfter: Check = (ok, path, message) => {
    if (!ok) afterState.push({ path, message });
  };
  const load = sum(plant.residual_loads.map((l) => l.power_w[i]));
  const flow = batteryFlow(
    equipment,
    action,
    i,
    hours,
    load,
    plant.pv_w[i],
    curtailed,
    1,
    path,
    checkBefore,
  );
  const totalLoad = load + flow.idle;
  const { imported, exported } = gridBalance(
    plant,
    i,
    totalLoad,
    flow.charge,
    flow.discharge,
    action.solar_charge_w,
    action.export_w,
    curtailed,
    prefix,
    checkAfter,
  );
  const physical: PhysicalInterval = {
    import_w: imported,
    export_w: exported,
    curtailed_w: curtailed,
    load_w: totalLoad,
    equipment_w: { [equipment.id]: flow.equipment_w },
    heat_w: {},
    charge_kwh: { [equipment.id]: flow.charged },
    discharge_kwh: { [equipment.id]: flow.discharged },
    starts: [],
  };
  const fixedViolations = [...beforeState, ...afterState];
  return {
    physical,
    advance(before: number) {
      const energy = flow.nextEnergy(before);
      let stateViolation: Violation | undefined;
      checkEnergy(energy, equipment, path, (ok, path, message) => {
        if (!ok) stateViolation = { path, message };
      });
      return {
        energy,
        violations: stateViolation
          ? [...beforeState, stateViolation, ...afterState]
          : fixedViolations,
      };
    },
  };
}

export function materializeHousehold(
  plant: HouseholdPlant,
  hours: number[],
  candidate: HouseholdCandidate,
): PhysicalTrajectory {
  const state = Object.fromEntries([
    ...plant.thermal_stores.map((s) =>
      [s.id, [s.state_c.initial] as number[]] as const
    ),
    ...plant.equipment.flatMap((e) =>
      e.kind === "heater"
        ? []
        : [[e.id, [e.state_kwh.initial] as number[]] as const]
    ),
  ]);
  const intervals: PhysicalInterval[] = [];
  const violations: Violation[] = [];
  const running = new Map(
    plant.equipment.filter((e) => e.kind === "heater").map(
      (e) => [e.id, e.initially_running],
    ),
  );
  const check = (condition: boolean, path: string, message: string) => {
    if (!condition) violations.push({ path, message });
  };
  hours.forEach((h, i) => {
    const prefix = `intervals.${i}`;
    const heat = Object.fromEntries(plant.thermal_stores.map((s) => [s.id, 0]));
    const equipmentW: Record<string, number> = Object.create(null);
    const charged: Record<string, number> = Object.create(null);
    const discharged: Record<string, number> = Object.create(null);
    const starts: string[] = [];
    let load = sum(plant.residual_loads.map((l) => l.power_w[i]));
    let charge = 0, discharge = 0, solarCharge = 0, batteryExport = 0;
    for (const e of plant.equipment) {
      const a = candidate.actions[e.id][i];
      const path = `${prefix}.${e.id}`;
      if (e.kind === "battery" && a.kind === "battery") {
        const flow = batteryFlow(
          e,
          a,
          i,
          h,
          load,
          plant.pv_w[i],
          candidate.pv_curtail_w[i],
          plant.equipment.length,
          path,
          check,
        );
        charge += flow.charge;
        discharge += flow.discharge;
        load += flow.idle;
        solarCharge += a.solar_charge_w;
        batteryExport += a.export_w;
        charged[e.id] = flow.charged;
        discharged[e.id] = flow.discharged;
        state[e.id].push(flow.nextEnergy(state[e.id][i]));
        equipmentW[e.id] = flow.equipment_w;
      } else if (e.kind === "ev" && a.kind === "ev") {
        check(
          legalLevel(e.current_steps_a, a.current_a),
          path,
          "unsupported EV current step",
        );
        check(
          (e.available[i] && e.connected[i]) || a.current_a <= EPS,
          path,
          "EV unavailable or disconnected in this scenario",
        );
        const watts = a.current_a * e.watts_per_amp;
        equipmentW[e.id] = watts;
        load += watts;
        charged[e.id] = watts * h / 1000;
        discharged[e.id] = 0;
        state[e.id].push(state[e.id][i] + charged[e.id] * e.charge_efficiency);
      } else if (e.kind === "heater" && a.kind === "heater") {
        check(
          legalLevel(e.power_steps_w, a.power_w),
          path,
          "unsupported heater power step",
        );
        const on = a.power_w > EPS;
        check(e.available[i] || !on, path, "heater unavailable");
        check(
          on === (a.store_id !== null),
          path,
          "running heater needs exactly one route; off needs none",
        );
        const route = e.routes.find((r) => r.store_id === a.store_id);
        const watts = a.power_w + (on && route ? route.auxiliary_w : 0);
        equipmentW[e.id] = watts;
        load += watts;
        if (on && route) heat[route.store_id] += a.power_w * route.cop[i];
        if (on && !running.get(e.id) && e.technology === "heat_pump") {
          starts.push(e.id);
        }
        running.set(e.id, on);
      } else {
        throw new Error(
          "Candidate must pass structural validation before materialisation",
        );
      }
      if (e.kind !== "heater") {
        checkEnergy(state[e.id][i + 1], e, path, check);
      }
    }
    for (const s of plant.thermal_stores) {
      const before = state[s.id][i];
      const next = before + (h * (heat[s.id] / 1000 + s.background_kw[i] -
                s.loss_kw_per_c * (before - s.environment_c[i])) -
            s.withdrawal_kwh[i]) / s.capacity_kwh_per_c;
      state[s.id].push(next);
      check(
        Number.isFinite(next) && next >= s.state_c.min - EPS &&
          next <= s.state_c.max + EPS,
        `${prefix}.${s.id}.state_c`,
        `temperature ${next} outside physical bounds`,
      );
    }
    const curtailed = candidate.pv_curtail_w[i];
    const { imported, exported } = gridBalance(
      plant,
      i,
      load,
      charge,
      discharge,
      solarCharge,
      batteryExport,
      curtailed,
      prefix,
      check,
    );
    intervals.push({
      import_w: imported,
      export_w: exported,
      curtailed_w: curtailed,
      load_w: load,
      equipment_w: equipmentW,
      heat_w: heat,
      charge_kwh: charged,
      discharge_kwh: discharged,
      starts,
    });
  });
  return { intervals, state, violations };
}
