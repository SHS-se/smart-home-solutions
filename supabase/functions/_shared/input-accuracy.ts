/** Home Assistant reports its live input health beside its runtime; the cloud only validates and stores it. */
export const INPUT_CHECKS = ['prices', 'solar_forecast', 'sensors', 'measurements'] as const;
type InputGrade = 'green' | 'lime' | 'yellow' | 'orange' | 'red';
export interface InputCheck {
  key: typeof INPUT_CHECKS[number]; percentage: number; grade: InputGrade;
  healthy: number; expected: number; issues: string[];
  published_until?: string | null; first_missing?: string | null;
}
/** Home Assistant's live input health: each check is healthy over expected readings. */
export interface InputAccuracy {
  version: 1; observed_at: string; percentage: number | null; grade: InputGrade | null; checks: InputCheck[];
}

const GRADES = ['green', 'lime', 'yellow', 'orange', 'red'];
const percent = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 100;
const isoTime = (v: unknown) => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

function validInputCheck(value: unknown, seen: Set<string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const optionalTime = (v: unknown) => v === undefined || v === null || isoTime(v);
  if (!INPUT_CHECKS.includes(c.key as typeof INPUT_CHECKS[number]) || seen.has(c.key as string)) return false;
  seen.add(c.key as string);
  return percent(c.percentage) && GRADES.includes(c.grade as string) &&
    Number.isSafeInteger(c.healthy) && Number.isSafeInteger(c.expected) &&
    (c.healthy as number) >= 0 && (c.expected as number) > 0 && (c.healthy as number) <= (c.expected as number) &&
    Array.isArray(c.issues) && c.issues.length <= 10 &&
    c.issues.every(issue => typeof issue === 'string' && issue.length > 0 && issue.length <= 200) &&
    optionalTime(c.published_until) && optionalTime(c.first_missing);
}

export function validInputAccuracy(value: unknown): value is InputAccuracy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>, seen = new Set<string>();
  return a.version === 1 && isoTime(a.observed_at) &&
    (a.percentage === null ? a.grade === null : percent(a.percentage) && GRADES.includes(a.grade as string)) &&
    Array.isArray(a.checks) && a.checks.length <= INPUT_CHECKS.length && a.checks.every(check => validInputCheck(check, seen));
}
