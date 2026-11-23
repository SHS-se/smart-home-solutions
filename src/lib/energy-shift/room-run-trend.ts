/**
 * A smooth trend through scattered per-run measurements.
 *
 * Each run is one noisy experiment. Weighted least squares trusts a run by its
 * own stated uncertainty; when runs scatter more than those uncertainties
 * allow, the extra spread widens the trend's band instead of being ignored.
 * Among the shapes physics allows (see TrendShape), small-sample AICc picks
 * the simplest one that is not clearly worse than a more complex one.
 */
export interface TrendPoint { x: number; y: number; se?: number | null }

export interface Trend {
  degree: number;
  /** Coefficients in powers of (x − centre). */
  coefficients: number[];
  covariance: number[][];
  centre: number;
  n: number;
  minX: number;
  maxX: number;
  /** The straight fit broke the shape physics allows, so the trend is flat. */
  constrained?: true;
  /** For runs with stated uncertainties: their spread around the trend in
   * units of those uncertainties. About 1 is honest noise; much more means the
   * runs disagree for a reason their own error bars do not cover. */
  excessScatter?: number;
}

/** A curve needs this many more points than it has coefficients. */
const SPARE_POINTS = 2;
/** A straight or curved shape needs runs spread over this many degrees. */
const MIN_SPAN_C = 3;
/** AICc units a more complex shape must win by; below this, prefer simpler. */
const PARSIMONY = 2;

function solve(matrix: number[][], vector: number[]): { solution: number[]; inverse: number[][] } | null {
  const size = vector.length;
  const work = matrix.map((row, i) => [...row, ...vector.slice(i, i + 1), ...Array.from({ length: size }, (_, j) => i === j ? 1 : 0)]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    const scale = Math.max(...matrix.map(row => Math.abs(row[column])));
    if (!(Math.abs(work[pivot][column]) > 1e-12 * Math.max(1, scale))) return null;
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const lead = work[column][column];
    for (let j = 0; j < work[column].length; j++) work[column][j] /= lead;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = work[row][column];
      for (let j = 0; j < work[row].length; j++) work[row][j] -= factor * work[column][j];
    }
  }
  return { solution: work.map(row => row[size]), inverse: work.map(row => row.slice(size + 1)) };
}

function fitDegree(points: readonly TrendPoint[], weights: number[], centre: number, degree: number, weighted: boolean) {
  const size = degree + 1;
  const normal = Array.from({ length: size }, () => Array(size).fill(0));
  const target = Array(size).fill(0);
  points.forEach((point, i) => {
    const powers = Array.from({ length: size }, (_, j) => (point.x - centre) ** j);
    for (let a = 0; a < size; a++) {
      target[a] += weights[i] * powers[a] * point.y;
      for (let b = 0; b < size; b++) normal[a][b] += weights[i] * powers[a] * powers[b];
    }
  });
  const solved = solve(normal, target);
  if (!solved) return null;
  const residual = points.reduce((sum, point, i) => sum + weights[i] *
    (point.y - solved.solution.reduce((total, c, j) => total + c * (point.x - centre) ** j, 0)) ** 2, 0);
  const n = points.length, k = size + 1;
  const freedom = n - size;
  // Excess scatter beyond stated uncertainties widens the band (Birge ratio);
  // without stated uncertainties the observed scatter is the only noise estimate.
  const scatter = freedom > 0 ? residual / freedom : weighted ? 1 : Infinity;
  const scale = weighted ? Math.max(1, scatter) : scatter;
  const aicc = n * Math.log(Math.max(residual, Number.MIN_VALUE) / n) + 2 * k + (2 * k * (k + 1)) / Math.max(1, n - k - 1);
  return { coefficients: solved.solution, covariance: solved.inverse.map(row => row.map(v => v * scale)), aicc, residual, freedom };
}

/**
 * The shapes physics allows each per-run measurement to take.
 * - `response`: heater °C/kWh. It is 1 ÷ the room's heat capacity, which does
 *   not depend on outdoor temperature, so the trend is always flat. When runs
 *   scatter beyond their own uncertainty, `excessScatter` says by how much;
 *   that spread is the evidence of misattributed losses, not a slope.
 * - `cooling`: cool-down °C/h against outdoor temperature. It falls with
 *   warmer weather and never rises, and may only bow steeper in the cold (air
 *   leakage grows faster than the temperature difference). Flat is only the
 *   bound for runs whose straight fit rises.
 */
export type TrendShape = 'response' | 'cooling';

const MAX_DEGREE: Record<TrendShape, number> = { response: 0, cooling: 2 };

function slopeAt(coefficients: number[], centre: number, x: number): number {
  return coefficients.reduce((sum, c, j) => j === 0 ? sum : sum + j * c * (x - centre) ** (j - 1), 0);
}
function valueAt(coefficients: number[], centre: number, x: number): number {
  return coefficients.reduce((sum, c, j) => sum + c * (x - centre) ** j, 0);
}

/** Cool-down never rises with warmer weather and only bows steeper in the cold.
 * The slope of a quadratic is linear, so both ends bound it everywhere between. */
function admissible(coefficients: number[], centre: number, minX: number, maxX: number): boolean {
  const tolerance = 1e-12;
  return (coefficients[2] ?? 0) >= -tolerance &&
    slopeAt(coefficients, centre, minX) <= tolerance && slopeAt(coefficients, centre, maxX) <= tolerance;
}

export function fitTrend(input: readonly TrendPoint[], shape: TrendShape): Trend | null {
  const points = input.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y) &&
    (point.se == null || (Number.isFinite(point.se) && point.se > 0)));
  if (!points.length) return null;
  const weighted = points.every(point => point.se != null);
  const weights = points.map(point => weighted ? 1 / point.se! ** 2 : 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const centre = points.reduce((sum, point, i) => sum + weights[i] * point.x, 0) / total;
  const xs = points.map(point => point.x);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const candidates: { degree: number; fit: NonNullable<ReturnType<typeof fitDegree>> }[] = [];
  let straightRejected = false;
  for (let degree = 0; degree <= MAX_DEGREE[shape]; degree++) {
    if (degree > 0 && (points.length < degree + 1 + SPARE_POINTS || maxX - minX < MIN_SPAN_C)) continue;
    const fit = fitDegree(points, weights, centre, degree, weighted);
    if (!fit) continue;
    // A flat trend is always physical; a shape physics rules out is never shown.
    if (degree > 0 && !admissible(fit.coefficients, centre, minX, maxX)) { straightRejected ||= degree === 1; continue; }
    candidates.push({ degree, fit });
  }
  if (!candidates.length) return null;
  // A room always loses some heat to outdoors, so a falling line is the
  // weakest cool-down physics allows; flat is only the bound for rising runs.
  if (shape === 'cooling' && candidates.some(candidate => candidate.degree > 0)) {
    candidates.splice(0, candidates.length, ...candidates.filter(candidate => candidate.degree > 0));
  }
  const best = Math.min(...candidates.map(candidate => candidate.fit.aicc));
  const chosen = candidates.find(candidate => candidate.fit.aicc <= best + PARSIMONY)!;
  const excess = weighted && chosen.fit.freedom > 0 ? Math.sqrt(chosen.fit.residual / chosen.fit.freedom) : null;
  return { degree: chosen.degree, coefficients: chosen.fit.coefficients, covariance: chosen.fit.covariance,
    centre, n: points.length, minX, maxX, ...(straightRejected && chosen.degree === 0 ? { constrained: true as const } : {}),
    ...(excess !== null ? { excessScatter: excess } : {}) };
}

/** Inside the measured runs, the fitted shape. Beyond them the line continues
 * along its edge tangent: a curve fitted to the data is not evidence of where
 * it would bend next. The band is only meaningful inside the measured runs. */
export function trendAt(trend: Trend, x: number): { y: number; se: number } {
  const edge = Math.min(trend.maxX, Math.max(trend.minX, x));
  const powers = trend.coefficients.map((_, j) => (edge - trend.centre) ** j);
  const y = valueAt(trend.coefficients, trend.centre, edge) + slopeAt(trend.coefficients, trend.centre, edge) * (x - edge);
  const variance = powers.reduce((sum, a, i) => sum + powers.reduce((inner, b, j) => inner + a * b * trend.covariance[i][j], 0), 0);
  return { y, se: Math.sqrt(Math.max(0, variance)) };
}

/** Slope of the trend at x, per unit of x. */
export function trendSlopeAt(trend: Trend, x: number): number {
  return slopeAt(trend.coefficients, trend.centre, Math.min(trend.maxX, Math.max(trend.minX, x)));
}

/** Where the trend crosses zero inside [from, to], scanning from cold to warm. */
export function trendZero(trend: Trend, from: number, to: number): number | null {
  const steps = 400;
  let previousX = from, previous = trendAt(trend, from).y;
  for (let i = 1; i <= steps; i++) {
    const x = from + (to - from) * i / steps, value = trendAt(trend, x).y;
    if (previous === 0) return previousX;
    if (Math.sign(value) !== Math.sign(previous)) return previousX + (x - previousX) * previous / (previous - value);
    previousX = x; previous = value;
  }
  return null;
}
