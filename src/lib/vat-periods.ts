export interface VatPeriodFilingState {
  year: number;
  quarter: number;
  filing_confirmation_path?: string | null;
  filing_confirmed_at?: string | null;
  status?: string | null;
}

export interface AccountingPeriodState {
  year: number;
  month: number;
}

export function getQuarterMonths(quarter: number): number[] {
  const firstMonth = (quarter - 1) * 3 + 1;
  return [firstMonth, firstMonth + 1, firstMonth + 2];
}

export function getQuarterForMonth(month: number): number {
  return Math.ceil(month / 3);
}

export function hasVatFilingConfirmation(vatPeriod: VatPeriodFilingState | null | undefined): boolean {
  if (!vatPeriod) return false;
  return Boolean(vatPeriod.filing_confirmation_path && vatPeriod.filing_confirmed_at);
}

export const ARCHIVED_VAT_STATUSES = new Set(['filed', 'locked']);

export interface VatPeriodLike {
  year: number;
  quarter: number;
  status: string;
}

/**
 * The active VAT period is the earliest chronological quarter that has not
 * yet been filed or locked. Overview, VatPeriodsList and VatDeclarationFlow
 * all derive the "next declaration" from this.
 */
export function getActiveVatPeriod<T extends VatPeriodLike>(vatPeriods: T[]): T | null {
  return vatPeriods
    .filter((vp) => !ARCHIVED_VAT_STATUSES.has(vp.status))
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter)[0] || null;
}

export function isAccountingPeriodLockedByVatFiling(
  period: AccountingPeriodState,
  vatPeriods: VatPeriodFilingState[],
): boolean {
  const quarter = getQuarterForMonth(period.month);
  return vatPeriods.some((vatPeriod) =>
    vatPeriod.year === period.year &&
    vatPeriod.quarter === quarter &&
    hasVatFilingConfirmation(vatPeriod),
  );
}
