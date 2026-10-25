/** Cross-runtime comparison for inert learning qualification only. Selected
 * models, state and selection scores remain exact. ECMAScript exponentiation
 * may differ by one ULP between runtimes in diagnostic recovery-grid profiles. */
const DIAGNOSTIC_PATH = /^p_model\.(?:thermal_dynamics|last_fit_attempt\.thermal_response)\.recovery_evidence\.profile\.\d+\.(?:rmse_c|recovery_rate_per_h)$/;

function ulpDistance(a: number, b: number): bigint | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.sign(a) !== Math.sign(b)) return null;
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setFloat64(0, a);
  const first = view.getBigUint64(0);
  view.setFloat64(0, b);
  const second = view.getBigUint64(0);
  return first >= second ? first - second : second - first;
}

/** No tolerance applies outside the two explicitly named profile diagnostics. */
export function compareLearningPublications(expected: unknown, actual: unknown): { path: string; ulps: number }[] {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object"
    || !Object.hasOwn(expected, "p_model") || !Object.hasOwn(actual, "p_model")) {
    throw new Error("Learning publication missing at root");
  }
  const diagnostics: { path: string; ulps: number }[] = [];
  const compare = (a: unknown, b: unknown, path: string): void => {
    if (Object.is(a, b)) return;
    if (typeof a === "number" && typeof b === "number" && DIAGNOSTIC_PATH.test(path)) {
      const ulps = ulpDistance(a, b);
      if (ulps !== null && ulps <= 2n) { diagnostics.push({ path, ulps: Number(ulps) }); return; }
    }
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
      const keys = Object.keys(left), otherKeys = Object.keys(right);
      if (keys.length === otherKeys.length && keys.every(key => Object.hasOwn(right, key))) {
        for (const key of keys) compare(left[key], right[key], path ? `${path}.${key}` : key);
        return;
      }
    }
    throw new Error(`Learning publication mismatch at ${path || "root"}`);
  };
  compare(expected, actual, "");
  return diagnostics;
}
