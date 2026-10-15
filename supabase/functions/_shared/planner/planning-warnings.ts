/** Data quality affects estimates and visibility, never household admission. */
export interface PlanningWarning {
  code: string;
  scope: string;
  severity: "warning" | "error";
  message: string;
  consequence: string;
  evidence?: Record<string, string | number | null>;
  entity_id?: string;
}

export function mergePlanningWarnings(...groups: Array<readonly PlanningWarning[] | null | undefined>): PlanningWarning[] {
  const warnings = new Map<string, PlanningWarning>();
  for (const group of groups) for (const warning of Array.isArray(group) ? group : []) {
    if (!warning || typeof warning !== "object" ||
      ![warning.code, warning.scope, warning.message, warning.consequence].every(value => typeof value === "string") ||
      !["warning", "error"].includes(warning.severity)) continue;
    warnings.set(`${warning.scope}:${warning.code}`, warning);
  }
  return [...warnings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, warning]) => warning);
}

export function planningWarning(code: string, scope: string, message: string, consequence: string,
  evidence?: PlanningWarning["evidence"], severity: PlanningWarning["severity"] = "warning"): PlanningWarning {
  return { code, scope, severity, message, consequence, ...(evidence ? { evidence } : {}) };
}
