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
