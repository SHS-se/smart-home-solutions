/** Home Assistant reports its input health beside its runtime; the cloud only validates and stores it. */
export const INPUT_CHECKS = ['prices', 'solar_forecast', 'sensors', 'measurements', 'battery'] as const;
type InputGrade = 'green' | 'lime' | 'yellow' | 'orange' | 'red';
export interface InputCheck {
  key: typeof INPUT_CHECKS[number]; percentage: number | null; grade: InputGrade | null; issues: string[];
  /** Live checks: healthy readings over expected readings; battery: charge targets reached over measured. */
  healthy?: number; expected?: number;
  /** Prices: the cloud's latest comparison of estimates with published prices. */
  quarters?: number; calculated_at?: string | null;
}
/** The headline averages the checks that have a score. */
export interface InputAccuracy {
  version: 1; observed_at: string; percentage: number | null; grade: InputGrade | null; checks: InputCheck[];
}

const GRADES = ['green', 'lime', 'yellow', 'orange', 'red'];
const percent = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 100;
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isoTime = (v: unknown) => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const score = (r: Record<string, unknown>) =>
  r.percentage === null ? r.grade === null : percent(r.percentage) && GRADES.includes(r.grade as string);

function validInputCheck(value: unknown, seen: Set<string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (!INPUT_CHECKS.includes(c.key as typeof INPUT_CHECKS[number]) || seen.has(c.key as string)) return false;
  seen.add(c.key as string);
  const counted = c.healthy === undefined && c.expected === undefined ||
    count(c.healthy) && count(c.expected) && (c.expected as number) > 0 && (c.healthy as number) <= (c.expected as number);
  return score(c) && counted && (c.quarters === undefined || count(c.quarters)) &&
    (c.calculated_at === undefined || c.calculated_at === null || isoTime(c.calculated_at)) &&
    Array.isArray(c.issues) && c.issues.length <= 10 &&
    c.issues.every(issue => typeof issue === 'string' && issue.length > 0 && issue.length <= 200);
}

export function validInputAccuracy(value: unknown): value is InputAccuracy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>, seen = new Set<string>();
  return a.version === 1 && isoTime(a.observed_at) && score(a) &&
    Array.isArray(a.checks) && a.checks.length <= INPUT_CHECKS.length && a.checks.every(check => validInputCheck(check, seen));
}
