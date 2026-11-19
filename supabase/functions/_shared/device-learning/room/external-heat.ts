/** Reduced-form additional-heat evidence in interval-transition residuals.
 * A residual is already expressed in its own response family's coordinates.
 * These inferred contributions are degrees Celsius, never measured watts,
 * corrected thermometer facts, or a promise of future fireplace heat. */
export interface ExternalHeatResidual {
  residual_c: number;
  segment: number;
  /** Exact transition response to one unit of background forcing. */
  forcing_scale?: number;
  /** Elapsed clock time from the preceding residual; default one hour. */
  duration_h?: number;
  /** Measured next-interval duration class, with its own learned noise. */
  noise_class?: string;
}
export interface ExternalHeatParameters {
  sigma_c: number;
  sigma_by_class?: Record<string, number>;
  /** Fixed empirical variance reference, not measured sensor precision.
   * The caller supplies the common, candidate-independent calibration. A
   * proper scaled inverse-chi-square prior with nu=1 provides
   * one calibration sum of squares for every active noise variance. */
  noise_reference_c2?: number;
  /** Exponential mean in background-forcing coordinates, not necessarily C. */
  external_mean_c: number;
  /** One-hour transition matrix of a continuous-time two-state chain. */
  transition: [[number, number], [number, number]];
  initial: [number, number];
}
export interface ExternalHeatInference {
  expected_c: number[];
  second_moment_c2: number[];
  external_probability: number[];
  /** Scored before conditioning on this residual, even when smoothing. */
  predictive_log_density: number[];
  nll: number;
  noise_penalty: number;
  objective: number;
  transition_counts: [[number, number], [number, number]];
  initial_counts: [number, number];
  precision: number[];
  transition_counts_by_duration: { duration_h: number; counts: [[number, number], [number, number]] }[];
}

const LOG_SQRT_TWO_PI = .5 * Math.log(2 * Math.PI);
const LOG_HALF = Math.log(.5);
const log = (value: number) => value === 0 ? -Infinity : Math.log(value);
function logAdd(a: number, b: number): number {
  const maximum = Math.max(a, b);
  return maximum === -Infinity ? maximum : maximum + Math.log1p(Math.exp(Math.min(a, b) - maximum));
}

/** Fractional powers of the one-hour CTMC matrix preserve clock-time
 * persistence across hourly/quarterly joins. Identity/absorbing boundaries
 * stay exact; a mode with no observations never acquires invented changes. */
export function externalHeatTransition(parameters: Pick<ExternalHeatParameters, "transition">, duration: number): ExternalHeatParameters["transition"] {
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("Invalid external-heat transition duration");
  const matrix = parameters.transition;
  if (duration === 1) return matrix;
  const a = matrix[0][1], b = matrix[1][0], q = a + b;
  if (q === 0) return [[1, 0], [0, 1]];
  if (q > 1 + 64 * Number.EPSILON) throw new Error("External-heat persistence is not a continuous-time chain");
  const moved = q >= 1 ? 1 : -Math.expm1(duration * Math.log1p(-q));
  const toExternal = a / q * moved, toClean = b / q * moved;
  return [[1 - toExternal, toExternal], [toClean, 1 - toClean]];
}

type TransitionCounts = ExternalHeatInference["transition_counts_by_duration"];
function transitionObjective(matrix: ExternalHeatParameters["transition"], groups: TransitionCounts): number {
  let result = 0;
  for (const group of groups) {
    const at = externalHeatTransition({ transition: matrix }, group.duration_h);
    for (let from = 0; from < 2; from++) for (let to = 0; to < 2; to++) {
      const count = group.counts[from][to];
      if (count > 0) result -= count * log(at[from][to]);
    }
  }
  return result;
}

function transitionFromCoordinates(point: number[]): ExternalHeatParameters["transition"] {
  const p = point[0] >= 0 ? 1 / (1 + Math.exp(-point[0])) : Math.exp(point[0]) / (1 + Math.exp(point[0]));
  const moved = -Math.expm1(-Math.exp(point[1]));
  return [[1 - p * moved, p * moved], [(1 - p) * moved, 1 - (1 - p) * moved]];
}

/** The CTMC M-step has only two unknowns. Maximize its expected likelihood
 * over logit(stationary occupancy), log(clock decay), without a physical
 * timescale cap. The fixed numerical iteration budget bounds solver work. */
function updateTransitions(previous: ExternalHeatParameters["transition"], groups: TransitionCounts): ExternalHeatParameters["transition"] {
  if (!groups.length) return previous;
  if (groups.length === 1) {
    const { counts, duration_h } = groups[0], at = externalHeatTransition({ transition: previous }, duration_h);
    const n0 = counts[0][0] + counts[0][1], n1 = counts[1][0] + counts[1][1];
    let a = n0 ? counts[0][1] / n0 : at[0][1], b = n1 ? counts[1][0] / n1 : at[1][0];
    if (a + b > 1) {
      // The unconstrained maximum is anti-persistent. On the CTMC boundary
      // both rows equal the empirical next-state occupancy (infinite rate).
      a = (counts[0][1] + counts[1][1]) / (n0 + n1); b = 1 - a;
    }
    return externalHeatTransition({ transition: [[1 - a, a], [b, 1 - b]] }, 1 / duration_h);
  }
  const q = previous[0][1] + previous[1][0];
  const p = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, q ? previous[0][1] / q : .5));
  const rate = -Math.log1p(-Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, q)));
  const start = [Math.log(p / (1 - p)), Math.log(rate)];
  const evaluate = (point: number[]) => ({ point, objective: transitionObjective(transitionFromCoordinates(point), groups) });
  let simplex = [evaluate(start), evaluate([start[0] + 1, start[1]]), evaluate([start[0], start[1] + 1])];
  for (let iteration = 0; iteration < 240; iteration++) {
    simplex.sort((a, b) => a.objective - b.objective);
    const [best, middle, worst] = simplex;
    const spread = Math.max(...simplex.map(value => Math.abs(value.objective - best.objective)));
    const width = Math.max(...simplex.flatMap(value => value.point.map((x, j) => Math.abs(x - best.point[j]))));
    if (spread <= 1e-10 * (1 + Math.abs(best.objective)) && width <= 1e-6) break;
    const center = best.point.map((x, j) => (x + middle.point[j]) / 2);
    const reflected = evaluate(center.map((x, j) => 2 * x - worst.point[j]));
    if (reflected.objective < best.objective) {
      const expanded = evaluate(center.map((x, j) => x + 2 * (reflected.point[j] - x)));
      simplex[2] = expanded.objective < reflected.objective ? expanded : reflected;
    } else if (reflected.objective < middle.objective) simplex[2] = reflected;
    else {
      const outside = reflected.objective < worst.objective;
      const contracted = evaluate(center.map((x, j) => x + .5 * ((outside ? reflected : worst).point[j] - x)));
      if (contracted.objective < (outside ? reflected.objective : worst.objective)) simplex[2] = contracted;
      else simplex = [best, ...simplex.slice(1).map(value => evaluate(value.point.map((x, j) => (x + best.point[j]) / 2)))];
    }
  }
  simplex.sort((a, b) => a.objective - b.objective);
  const oldObjective = transitionObjective(previous, groups);
  // Keeping an exact boundary is essential when no expected switches exist.
  return simplex[0].objective < oldObjective ? transitionFromCoordinates(simplex[0].point) : previous;
}

/** Inverse Mills ratio at a negative normal variate. Laplace's continued
 * fraction avoids subtracting two nearly equal tail probabilities. */
function negativeTail(a: number) {
  let fraction = 0;
  for (let j = 80; j >= 2; j--) fraction = j / (a + fraction);
  const delta = 1 / (a + fraction);
  return { mills: a + delta, delta };
}

function logNormalCdf(z: number): number {
  if (z > 0) return Math.log1p(-Math.exp(logNormalCdf(-z)));
  if (z === 0) return LOG_HALF;
  if (z < -4) return -.5 * z * z - LOG_SQRT_TWO_PI - Math.log(negativeTail(-z).mills);
  // Integral of exp(-t²/2), whose alternating series converges on [0,4].
  const a = -z;
  let term = a, sum = a;
  for (let j = 1; j < 100; j++) {
    term *= -a * a / (2 * j);
    const next = term / (2 * j + 1);
    sum += next;
    if (Math.abs(next) <= Number.EPSILON * Math.abs(sum)) break;
  }
  return Math.log(.5 - Math.exp(-LOG_SQRT_TWO_PI) * sum);
}

/** Analytic convolution and conditional first/second moments of S, where
 * R=S+epsilon, S~Exponential(mean), epsilon~Normal(0,sigma²). */
export function externalHeatEmission(residual: number, sigma: number, mean: number) {
  const standardized = residual / sigma, ratio = sigma / mean;
  const z = standardized - ratio;
  if (z < -4) {
    const a = -z, tail = negativeTail(a);
    // Rewriting cancels the two large exponential terms analytically.
    const log_density = -Math.log(mean) - .5 * standardized * standardized -
      LOG_SQRT_TWO_PI - Math.log(tail.mills);
    const first = sigma * tail.delta;
    // For extreme tails, avoid cancellation in 1-a*delta.
    const inverseSquare = 1 / (a * a);
    const second = sigma * sigma * (a > 100
      ? inverseSquare * (2 + inverseSquare * (-10 + inverseSquare * (74 - 706 * inverseSquare)))
      : Math.max(0, 1 - a * tail.delta));
    return { log_density, mean_c: first, second_moment_c2: second };
  }
  const logCdf = logNormalCdf(z);
  const mills = Math.exp(-.5 * z * z - LOG_SQRT_TWO_PI - logCdf);
  const first = sigma * (z + mills);
  return { log_density: -Math.log(mean) + .5 * ratio * ratio - standardized * ratio + logCdf,
    mean_c: first, second_moment_c2: sigma * sigma * (1 + z * (z + mills)) };
}

function validate(rows: readonly ExternalHeatResidual[], parameters?: ExternalHeatParameters): void {
  if (!rows.length || rows.some(row => !Number.isFinite(row.residual_c) || !Number.isFinite(row.segment) ||
    (row.forcing_scale !== undefined && (!(row.forcing_scale > 0) || !Number.isFinite(row.forcing_scale))) ||
    (row.duration_h !== undefined && (!(row.duration_h > 0) || !Number.isFinite(row.duration_h))) ||
    (row.noise_class !== undefined && (typeof row.noise_class !== "string" || !row.noise_class.length)))) {
    throw new Error("Invalid external-heat residual evidence");
  }
  if (parameters && (!(parameters.sigma_c > 0) || !Number.isFinite(parameters.sigma_c) ||
    !(parameters.external_mean_c > 0) || !Number.isFinite(parameters.external_mean_c) ||
    (parameters.sigma_by_class !== undefined && Object.values(parameters.sigma_by_class).some(sigma => !(sigma > 0) || !Number.isFinite(sigma))) ||
    (parameters.noise_reference_c2 !== undefined && (!(parameters.noise_reference_c2 > 0) || !Number.isFinite(parameters.noise_reference_c2))) ||
    [parameters.initial, ...parameters.transition].some(probabilities => probabilities.length !== 2 ||
      probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
      Math.abs(probabilities[0] + probabilities[1] - 1) > 64 * Number.EPSILON))) {
    throw new Error("Invalid external-heat parameters");
  }
}

/** A numerical arithmetic floor, scaled to the supplied residuals. It is not
 * a temperature trigger, noise admission gate, or physical lower bound. */
function arithmeticFloor(rows: readonly ExternalHeatResidual[]) {
  return Math.sqrt(Number.EPSILON) * Math.max(1, Math.sqrt(rows.reduce((sum, row) => sum + row.residual_c ** 2, 0) / rows.length));
}

export function initializeExternalHeat(rows: readonly ExternalHeatResidual[]): ExternalHeatParameters {
  validate(rows);
  const minimum = arithmeticFloor(rows);
  const negative = rows.filter(row => row.residual_c < 0);
  const positive = rows.filter(row => row.residual_c > 0);
  const sigma = Math.sqrt((negative.length ? negative : rows).reduce((sum, row) => sum + row.residual_c ** 2, 0) /
    (negative.length || rows.length));
  const external = positive.reduce((sum, row) => sum + row.residual_c / (row.forcing_scale ?? 1), 0) / (positive.length || 1);
  // Both states initially have support; subsequent EM may place a state on
  // its zero-probability likelihood boundary.
  const p = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, positive.length / rows.length));
  const transitionCounts: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  const groups = new Map<number, TransitionCounts[number]>();
  for (let i = 1; i < rows.length; i++) if (rows[i].segment === rows[i - 1].segment) {
    const from = rows[i - 1].residual_c > 0 ? 1 : 0, to = rows[i].residual_c > 0 ? 1 : 0;
    transitionCounts[from][to]++;
    const duration_h = rows[i].duration_h ?? 1;
    let group = groups.get(duration_h);
    if (!group) { group = { duration_h, counts: [[0, 0], [0, 0]] }; groups.set(duration_h, group); }
    group.counts[from][to]++;
  }
  for (const counts of transitionCounts) {
    const total = counts[0] + counts[1];
    // Empirical zero counts are an initialization artifact, not a learned
    // impossible transition. EM cannot reopen an exactly zero HMM edge.
    if (total) {
      counts[0] = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, counts[0] / total));
      counts[1] = 1 - counts[0];
    }
    else { counts[0] = 1 - p; counts[1] = p; }
  }
  // A sign initializer may be anti-persistent because ordinary Gaussian
  // noise changes sign. Start inside the CTMC domain, then fit clock time.
  const changes = transitionCounts[0][1] + transitionCounts[1][0];
  const moved = Math.min(1 - Number.EPSILON, changes);
  const occupancy = changes > 0 ? transitionCounts[0][1] / changes : p;
  const seed: ExternalHeatParameters["transition"] = [[1 - occupancy * moved, occupancy * moved],
    [(1 - occupancy) * moved, 1 - (1 - occupancy) * moved]];
  const fitted = updateTransitions(seed, [...groups.values()]);
  const a = Math.max(Number.EPSILON, fitted[0][1]), b = Math.max(Number.EPSILON, fitted[1][0]);
  const fraction = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, a / (a + b)));
  const total = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, a + b));
  const transition: ExternalHeatParameters["transition"] = [[1 - fraction * total, fraction * total],
    [(1 - fraction) * total, 1 - (1 - fraction) * total]];
  const classes = new Map<string, ExternalHeatResidual[]>();
  for (const row of rows) if (row.noise_class !== undefined) {
    const members = classes.get(row.noise_class) ?? []; members.push(row); classes.set(row.noise_class, members);
  }
  const sigma_by_class = Object.fromEntries([...classes].map(([name, members]) => {
    const below = members.filter(row => row.residual_c < 0), selected = below.length ? below : members;
    return [name, Math.max(arithmeticFloor(members), Math.sqrt(selected.reduce((sum, row) => sum + row.residual_c ** 2, 0) / selected.length))];
  }));
  const noise_reference_c2 = Math.max(minimum * minimum,
    rows.reduce((sum, row) => sum + row.residual_c ** 2, 0) / rows.length);
  return { sigma_c: Math.max(minimum, sigma), ...(classes.size ? { sigma_by_class } : {}), noise_reference_c2,
    external_mean_c: Math.max(minimum, external),
    transition, initial: [1 - p, p] };
}

/** Forward likelihood is causal. The default backward pass is training-only
 * smoothing; causal=true returns filtered attribution without future inputs.
 * A segment change resets the state and contributes no transition count. */
export function inferExternalHeat(rows: readonly ExternalHeatResidual[], parameters: ExternalHeatParameters,
  options: { causal?: boolean } = {}): ExternalHeatInference {
  validate(rows, parameters);
  const n = rows.length;
  const sigmas = rows.map(row => row.noise_class !== undefined && parameters.sigma_by_class && Object.hasOwn(parameters.sigma_by_class, row.noise_class)
    ? parameters.sigma_by_class[row.noise_class] : parameters.sigma_c);
  const precision = sigmas.map(sigma => 1 / (sigma * sigma));
  const activeVariances = new Map<string, number>();
  rows.forEach((row, i) => {
    const classed = row.noise_class !== undefined && parameters.sigma_by_class && Object.hasOwn(parameters.sigma_by_class, row.noise_class);
    activeVariances.set(classed ? `class:${row.noise_class}` : "default", sigmas[i] ** 2);
  });
  // IG(alpha=.5,beta=.5*reference) is proper and vanishes at variance=0.
  // Unlike a half-Cauchy scale prior, it removes the mixture's unbounded
  // likelihood at a zero-noise clean component. Its normalized density and
  // nu=1 policy enter the objective; these are not extra measured samples.
  const reference = parameters.noise_reference_c2;
  const noise_penalty = reference === undefined ? 0 : [...activeVariances.values()].reduce((sum, variance) =>
    sum + 1.5 * Math.log(variance) + .5 * reference / variance + .5 * Math.log(Math.PI) - .5 * Math.log(.5 * reference), 0);
  const emission = rows.map((row, i) => externalHeatEmission(row.residual_c, sigmas[i], parameters.external_mean_c * (row.forcing_scale ?? 1)));
  const clean = rows.map((row, i) => -.5 * row.residual_c ** 2 * precision[i] - Math.log(sigmas[i]) - LOG_SQRT_TWO_PI);
  const alpha: [number, number][] = [];
  const predictive: number[] = [];
  const clocks = new Map<number, number[][]>();
  const transitions = rows.map(row => {
    const duration = row.duration_h ?? 1;
    let matrix = clocks.get(duration);
    if (!matrix) { matrix = externalHeatTransition(parameters, duration).map(pair => pair.map(log)); clocks.set(duration, matrix); }
    return matrix;
  });
  for (let i = 0; i < n; i++) {
    const reset = i === 0 || rows[i].segment !== rows[i - 1].segment;
    const prior = reset ? parameters.initial.map(log) : [0, 1].map(state =>
      logAdd(alpha[i - 1][0] + transitions[i][0][state], alpha[i - 1][1] + transitions[i][1][state]));
    const a = prior[0] + clean[i], b = prior[1] + emission[i].log_density;
    const density = logAdd(a, b);
    if (!Number.isFinite(density)) throw new Error("External-heat likelihood is not finite");
    predictive.push(density);
    alpha.push([a - density, b - density]);
  }
  const probability = Array<number>(n), expected = Array<number>(n), second = Array<number>(n);
  const transitionCounts: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  const initialCounts: [number, number] = [0, 0];
  const durationCounts = new Map<number, TransitionCounts[number]>();
  let beta: [number, number] = [0, 0];
  for (let i = n - 1; i >= 0; i--) {
    const end = i === n - 1 || rows[i].segment !== rows[i + 1].segment;
    if (end || options.causal) beta = [0, 0];
    const normalizer = logAdd(alpha[i][0] + beta[0], alpha[i][1] + beta[1]);
    const p = Math.exp(alpha[i][1] + beta[1] - normalizer);
    probability[i] = p;
    expected[i] = p * emission[i].mean_c;
    second[i] = p * emission[i].second_moment_c2;
    if (i === 0 || rows[i].segment !== rows[i - 1].segment) {
      initialCounts[0] += 1 - p; initialCounts[1] += p;
    }
    if (i > 0 && rows[i].segment === rows[i - 1].segment && !options.causal) {
      const likelihood = [clean[i], emission[i].log_density];
      const joint = [0, 1].map(from => [0, 1].map(to =>
        alpha[i - 1][from] + transitions[i][from][to] + likelihood[to] + beta[to]));
      const total = logAdd(logAdd(joint[0][0], joint[0][1]), logAdd(joint[1][0], joint[1][1]));
      const duration_h = rows[i].duration_h ?? 1;
      let group = durationCounts.get(duration_h);
      if (!group) { group = { duration_h, counts: [[0, 0], [0, 0]] }; durationCounts.set(duration_h, group); }
      for (let from = 0; from < 2; from++) for (let to = 0; to < 2; to++) {
        const count = Math.exp(joint[from][to] - total);
        transitionCounts[from][to] += count;
        group.counts[from][to] += count;
      }
      beta = [0, 1].map(from => logAdd(transitions[i][from][0] + likelihood[0] + beta[0],
        transitions[i][from][1] + likelihood[1] + beta[1]) - predictive[i]) as [number, number];
    }
  }
  const nll = -predictive.reduce((sum, value) => sum + value, 0);
  return { expected_c: expected, second_moment_c2: second, external_probability: probability,
    predictive_log_density: predictive, nll, noise_penalty, objective: nll + noise_penalty,
    transition_counts: transitionCounts, initial_counts: initialCounts, precision,
    transition_counts_by_duration: [...durationCounts.values()] };
}

/** One EM step. Undefined transitions retain their current parameter because
 * the evidence has no likelihood information about that transition row. */
export function updateExternalHeat(rows: readonly ExternalHeatResidual[], parameters: ExternalHeatParameters):
  { parameters: ExternalHeatParameters; inference: ExternalHeatInference } {
  const inference = inferExternalHeat(rows, parameters);
  const minimum = arithmeticFloor(rows);
  let variance = 0, external = 0, mass = 0;
  const classes = new Map<string, { variance: number; count: number; rows: ExternalHeatResidual[] }>();
  let defaultVariance = 0, defaultCount = 0;
  rows.forEach((row, i) => {
    const residualVariance = row.residual_c ** 2 - 2 * row.residual_c * inference.expected_c[i] + inference.second_moment_c2[i];
    variance += residualVariance;
    if (row.noise_class !== undefined) {
      let group = classes.get(row.noise_class);
      if (!group) { group = { variance: 0, count: 0, rows: [] }; classes.set(row.noise_class, group); }
      group.variance += residualVariance; group.count++; group.rows.push(row);
    } else { defaultVariance += residualVariance; defaultCount++; }
    external += inference.expected_c[i] / (row.forcing_scale ?? 1);
    mass += inference.external_probability[i];
  });
  const transition = updateTransitions(parameters.transition, inference.transition_counts_by_duration);
  const reference = parameters.noise_reference_c2;
  const estimateVariance = (sum: number, count: number) => Math.max(0,
    reference === undefined ? sum / count : (sum + reference) / (count + 3));
  const sigma_by_class = { ...parameters.sigma_by_class, ...Object.fromEntries([...classes].map(([name, group]) =>
    [name, Math.max(arithmeticFloor(group.rows), Math.sqrt(estimateVariance(group.variance, group.count)))])) };
  const totalInitial = inference.initial_counts[0] + inference.initial_counts[1];
  return { inference, parameters: { sigma_c: Math.max(minimum, Math.sqrt(estimateVariance(
    defaultCount ? defaultVariance : variance, defaultCount || rows.length))),
    ...(Object.keys(sigma_by_class).length ? { sigma_by_class } : {}),
    ...(reference === undefined ? {} : { noise_reference_c2: reference }),
    external_mean_c: mass > 0 ? Math.max(minimum, external / mass) : parameters.external_mean_c,
    transition, initial: [inference.initial_counts[0] / totalInitial, inference.initial_counts[1] / totalInitial] } };
}
