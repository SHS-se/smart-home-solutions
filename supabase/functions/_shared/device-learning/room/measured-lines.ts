/** Published descriptive regressions; no planner coefficients are inferred here. */
import { isEquilibrium, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";
import { ROOM_MEASURED_POLICY, ROOM_MEASUREMENT_METHOD, measuredRoomLineAt, measuredPointStatus,
  type MeasuredPointStatus, type MeasuredRoomLine, type MeasuredRoomRun, type MeasuredRoomAssessment, type MeasuredRoomCalibration,
} from "../../planner/models/room/measured-evidence.ts";
export interface WeightedPoint { x: number; y: number; weight: number }
const median = (values: number[]) => {
  const sorted = values.sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[mid] + sorted[Math.max(0, mid - (sorted.length % 2 === 0 ? 1 : 0))]) / 2 : 0;
};
export function robustResidualScale(residuals: readonly number[]): number {
  const center = median([...residuals]);
  return 1.4826 * median(residuals.map(value => Math.abs(value - center)));
}
export function huberWeight(residual: number, scale: number): number {
  return Math.abs(residual) <= 1.345 * scale ? 1 : 1.345 * scale / Math.abs(residual);
}

/** Every measured point stays in the ledger and contributes positive weight. */
export function fitMeasuredLine(points: readonly WeightedPoint[], constraint: MeasuredRoomLine["constraint"], units: MeasuredRoomLine["units"]): MeasuredRoomLine | null {
  if (!points.length) return null;
  const sumWeight = points.reduce((sum, p) => sum + p.weight, 0);
  if (!(sumWeight > 0)) return null;
  const reference = points.reduce((sum, p) => sum + p.x * p.weight, 0) / sumWeight;
  let weights = points.map(p => p.weight), intercept = 0, slope = 0, scale = 0;
  for (let iteration = 0; iteration < 30; iteration++) {
    const total = weights.reduce((a, b) => a + b, 0);
    const xMean = points.reduce((sum, p, i) => sum + (p.x - reference) * weights[i], 0) / total;
    const yMean = points.reduce((sum, p, i) => sum + p.y * weights[i], 0) / total;
    let xx = 0, xy = 0;
    points.forEach((p, i) => { const dx = p.x - reference - xMean; xx += weights[i] * dx * dx; xy += weights[i] * dx * (p.y - yMean); });
    const nextSlope = xx > 0 ? (constraint === "rises" ? Math.max(0, xy / xx) : Math.min(0, xy / xx)) : 0;
    const nextIntercept = yMean - nextSlope * xMean;
    const residuals = points.map(p => p.y - nextIntercept - nextSlope * (p.x - reference));
    const arithmetic = Number.EPSILON * 64 * Math.max(1, ...points.map(p => Math.abs(p.y)));
    scale = Math.max(arithmetic, robustResidualScale(residuals));
    const change = Math.abs(nextIntercept - intercept) + Math.abs(nextSlope - slope);
    intercept = nextIntercept; slope = nextSlope;
    weights = points.map((p, i) => p.weight * huberWeight(residuals[i], scale));
    if (iteration > 0 && change <= arithmetic) break;
  }
  const total = weights.reduce((a, b) => a + b, 0), squares = weights.reduce((sum, w) => sum + w * w, 0);
  return { reference_outdoor_c: reference, intercept, slope_per_c: slope, robust_scale: scale,
    points: points.length, effective_points: total * total / squares, constraint, units };
}

export function assessMeasuredRuns(runs: readonly MeasuredRoomRun[], model: ThermalZoneModel | null): {
  runs: MeasuredRoomAssessment[]; calibration: Omit<MeasuredRoomCalibration, "fitted_observations" | "residual_degrees_of_freedom" | "validation">;
} {
  const reference = { room_c: 20, house_c: 20 };
  const dynamic = model && !isEquilibrium(model) ? model : null;
  const rows: MeasuredRoomAssessment[] = runs.map(run => {
    const h = run.heating, c = run.cooling, kOut = dynamic?.cooling_constant_per_h ?? 0, kHouse = dynamic?.house_coupling_per_h ?? 0;
    const heatMove = dynamic && h && (kHouse === 0 || h.house_c !== null)
      ? ((kOut + kHouse) * (h.room_mean_c - 20) + kHouse * (20 - (h.house_c ?? 20))) * h.hours / h.energy_kwh : null;
    const coolMove = dynamic && c && (kHouse === 0 || c.house_c !== null)
      ? -((kOut + kHouse) * (c.room_c - 20) + kHouse * (20 - (c.house_c ?? 20))) : null;
    return { ...run, reference_heating_c_per_kwh: h && heatMove !== null ? h.c_per_kwh + heatMove : null,
      reference_cooling_c_per_h: c && coolMove !== null ? c.c_per_h + coolMove : null,
      heating_residual: null, cooling_residual: null, heating_status: null, cooling_status: null };
  });
  // Each measure has its own population and weights. Heating precision grows
  // with delivered energy; a fall rate's with its own heater-off window.
  const points = (kind: "heating" | "cooling", adjusted: boolean): WeightedPoint[] => rows.flatMap(row => {
    const y = kind === "heating" ? adjusted ? row.reference_heating_c_per_kwh : row.heating?.c_per_kwh
      : adjusted ? row.reference_cooling_c_per_h : row.cooling?.c_per_h;
    const at = kind === "heating" ? row.heating : row.cooling;
    const weight = kind === "heating" ? row.heating?.energy_kwh : row.cooling?.hours;
    return at && y != null && weight != null ? [{ x: at.outdoor_c, y, weight }] : [];
  });
  const lines = { heating: fitMeasuredLine(points("heating", false), "rises", "c_per_kwh"),
    cooling: fitMeasuredLine(points("cooling", false), "falls", "c_per_h"),
    reference_heating: fitMeasuredLine(points("heating", true), "rises", "c_per_kwh"),
    reference_cooling: fitMeasuredLine(points("cooling", true), "falls", "c_per_h") };
  // A point is judged only against the published line of its own measure.
  for (const row of rows) {
    if (row.heating && lines.heating) {
      row.heating_residual = row.heating.c_per_kwh - measuredRoomLineAt(lines.heating, row.heating.outdoor_c);
      row.heating_status = measuredPointStatus(lines.heating, row.heating.outdoor_c, row.heating.c_per_kwh);
    }
    if (row.cooling && lines.cooling) {
      row.cooling_residual = row.cooling.c_per_h - measuredRoomLineAt(lines.cooling, row.cooling.outdoor_c);
      row.cooling_status = measuredPointStatus(lines.cooling, row.cooling.outdoor_c, row.cooling.c_per_h);
    }
  }
  const flagged = (status: MeasuredPointStatus | null) => status === "above_line" || status === "below_line";
  return { runs: rows, calibration: { policy: ROOM_MEASURED_POLICY, measurement_method: ROOM_MEASUREMENT_METHOD,
    observed_runs: rows.length, heating_runs: rows.filter(row => row.heating).length, cooling_runs: rows.filter(row => row.cooling).length,
    heating_flagged_runs: rows.filter(row => flagged(row.heating_status)).length,
    cooling_flagged_runs: rows.filter(row => flagged(row.cooling_status)).length,
    unmeasured_runs: rows.filter(row => !row.heating && !row.cooling).length, reference, lines } };
}
