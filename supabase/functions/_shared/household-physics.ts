import { convertedFlows } from "./battery-conversion.ts";
/** Deterministic materialisation. No prices, preferences or utility are read here. */
import type {
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
        check(!e.conversion || plant.equipment.length===1,path,"DC conversion requires materialized nonbattery residual loads");
        check(!e.conversion || candidate.pv_curtail_w[i]===0,path,"PV First DC operation does not authorize solar curtailment");
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
        check(
          e.grid_charge_allowed[i] || (e.conversion ? convertedFlows(e.conversion,a.charge_w,a.discharge_w,plant.pv_w[i]-candidate.pv_curtail_w[i],load).charge : a.charge_w) - a.solar_charge_w <= EPS,
          path,
          "grid charging not permitted",
        );
        check(
          e.export_allowed[i] || a.export_w <= EPS,
          path,
          "battery export not permitted",
        );
        const f = e.conversion ? convertedFlows(e.conversion, a.charge_w, a.discharge_w,
          plant.pv_w[i]-candidate.pv_curtail_w[i],load) : null;
        if (f) {
          check(Math.abs(a.solar_charge_w-f.solar)<=EPS,path,"DC model solar attribution mismatch");
          check(Math.abs(a.export_w-Math.max(0,f.discharge-Math.max(0,load-plant.pv_w[i]+candidate.pv_curtail_w[i])))<=EPS,path,"DC model export attribution mismatch");
        }
        charge += f ? f.charge : a.charge_w;
        discharge += f ? f.discharge : a.discharge_w;
        if (f) load += f.idle;
        solarCharge += a.solar_charge_w;
        batteryExport += a.export_w;
        charged[e.id] = (f ? f.charge : a.charge_w) * h / 1000;
        discharged[e.id] = (f ? f.discharge : a.discharge_w) * h / 1000;
        state[e.id].push(
          state[e.id][i] + (f ? (a.charge_w-a.discharge_w)*h/1000 : charged[e.id] * e.charge_efficiency -
            discharged[e.id] / e.discharge_efficiency),
        );
        equipmentW[e.id] = f ? f.charge-f.discharge+f.idle : a.charge_w - a.discharge_w;
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
        const value = state[e.id][i + 1];
        check(
          Number.isFinite(value) && value >= e.state_kwh.min - EPS &&
            value <= e.state_kwh.max + EPS,
          `${path}.state_kwh`,
          `state ${value} outside physical bounds`,
        );
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
    check(
      solarCharge <= pv + EPS,
      prefix,
      "solar charging exceeds available PV",
    );
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
