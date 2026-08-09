export type EnergyHistoryPeriod = '12' | '24' | '36' | 'all';

export function energyHistoryPeriodStart(
  latestMonth: string | null,
  period: EnergyHistoryPeriod,
): string | null {
  if (!latestMonth || period === 'all') return null;
  const [year, month] = latestMonth.split('-').map(Number);
  if (!year || !month) throw new Error(`Invalid energy-history month: ${latestMonth}`);
  return new Date(Date.UTC(year, month - Number(period), 1)).toISOString().slice(0, 7);
}
