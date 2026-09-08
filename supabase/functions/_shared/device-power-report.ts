/** Inventory power is descriptive. Scheduling power is validated separately. */
export function devicePowerReport(value: unknown): {
  power: number | null;
  rejected: boolean;
} {
  if (value === null) return { power: null, rejected: false };
  if (
    typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= 100_000
  ) {
    return { power: value, rejected: false };
  }
  return { power: null, rejected: true };
}
