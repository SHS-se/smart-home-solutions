import { buildEnergyBillingSeries, type EnergyBillingDocumentForSeries } from './energy-billing-series';
import type { EnergySupplierDailyCostRecord } from './energy-supplier-series';

export type ContractKind = 'fixed' | 'monthly' | 'quarterly' | 'mixed';
export type PricingMethod = 'quote' | 'components' | 'profile';
export interface RoiMonth {
  month: string;
  days: number;
  monthFraction: number;
  importKwh: number;
  importCostSek: number;
}
export interface RoiHistory {
  months: RoiMonth[];
  excluded: number;
}

const DAY_MS = 86_400_000;
const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Count the local day's hours, including 23/25-hour daylight-saving days. */
export function hoursInDay(day: string, timeZone: string): number {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const start = Date.parse(`${day}T00:00:00Z`);
  let hours = 0;
  for (let offset = -14; offset < 38; offset++) {
    const parts = format.formatToParts(new Date(start + offset * 3_600_000));
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    if (`${part('year')}-${part('month')}-${part('day')}` === day) hours++;
  }
  return hours;
}

/** Only complete, priced days: never expand a sparse date range into coverage. */
export function supplierRoiHistory(rows: readonly EnergySupplierDailyCostRecord[], timeZone: string): RoiHistory {
  const months = new Map<string, RoiMonth>();
  const seen = new Set<string>();
  let excluded = 0;
  for (const row of rows) {
    if (seen.has(row.cost_date)) throw new Error('Duplicate supplier cost date');
    seen.add(row.cost_date);
    if (row.priced_hours !== hoursInDay(row.cost_date, timeZone)
      || !Number.isFinite(row.import_kwh) || row.import_kwh < 0 || !Number.isFinite(row.import_cost_sek)) {
      excluded++;
      continue;
    }
    const key = row.cost_date.slice(0, 7);
    const month = months.get(key) ?? { month: key, days: 0, monthFraction: 0, importKwh: 0, importCostSek: 0 };
    month.days++;
    month.monthFraction = month.days / daysInMonth(key);
    month.importKwh += row.import_kwh;
    month.importCostSek += row.import_cost_sek;
    months.set(key, month);
  }
  return { months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)), excluded };
}

/** Invoice kWh and costs must cover the same full month. Export credit is held constant. */
export function invoiceRoiHistory(documents: EnergyBillingDocumentForSeries[]): RoiHistory {
  const invoices = documents.filter(d => d.documentKind === 'electricity');
  // Do not silently add overlapping bills (including re-issued invoices).
  const overlaps = new Set<string>();
  for (let i = 0; i < invoices.length; i++) {
    for (let j = i + 1; j < invoices.length; j++) {
      const start = invoices[i].periodStart > invoices[j].periodStart ? invoices[i].periodStart : invoices[j].periodStart;
      const end = invoices[i].periodEnd < invoices[j].periodEnd ? invoices[i].periodEnd : invoices[j].periodEnd;
      for (let cursor = Date.parse(`${start}T00:00:00Z`); cursor <= Date.parse(`${end}T00:00:00Z`); cursor += DAY_MS) {
        overlaps.add(new Date(cursor).toISOString().slice(0, 7));
      }
    }
  }
  const series = buildEnergyBillingSeries(invoices);
  const months = series.filter(m => m.electricityCoverage === 'complete' && !overlaps.has(m.monthKey)
    && m.electricityConsumptionKwh !== null && m.electricityConsumptionKwh >= 0 && m.electricityCostSek !== null)
    .map(m => ({
      month: m.monthKey, days: m.daysInMonth, monthFraction: 1,
      importKwh: m.electricityConsumptionKwh!,
      importCostSek: m.electricityCostSek! - m.exportNetSek,
    }));
  return { months, excluded: series.length - months.length };
}

export interface ComparisonContract {
  kind: ContractKind;
  method: PricingMethod;
  rateOre: number;
  monthlyFeeSek: number;
  variableRateOre: number;
  fixedSharePercent: number;
  markupDifferenceOre: number;
  monthlyRates: Record<string, number>;
  monthlyMarkupPercent: number;
}
export interface RoiInvestment {
  equipmentSek: number;
  installationSek: number;
  subscriptionSek: number;
  currentMonthlyFeeSek: number;
}

export function compareContract(months: readonly RoiMonth[], contract: ComparisonContract, investment: RoiInvestment) {
  const numbers = [contract.rateOre, contract.monthlyFeeSek, contract.variableRateOre, contract.fixedSharePercent,
    contract.markupDifferenceOre, contract.monthlyMarkupPercent, ...Object.values(contract.monthlyRates), ...Object.values(investment)];
  if (numbers.some(n => !Number.isFinite(n)) || contract.fixedSharePercent < 0 || contract.fixedSharePercent > 100
    || contract.monthlyMarkupPercent < 0 || contract.monthlyFeeSek < 0 || Object.values(investment).some(n => n < 0)) throw new Error('Invalid ROI inputs');
  if (months.length === 0) return null;
  const compared = months.map(month => {
    if (contract.kind === 'monthly' && contract.monthlyRates[month.month] === undefined) throw new Error('Monthly market price missing');
    const rate = contract.kind === 'monthly'
      ? contract.monthlyRates[month.month] * (1 + contract.monthlyMarkupPercent / 100)
      : contract.rateOre;
    const alternativeEnergy = contract.kind !== 'monthly' && contract.method === 'profile'
      ? month.importCostSek + month.importKwh * contract.markupDifferenceOre / 100
      : month.importKwh / 100 * (contract.kind === 'mixed' && contract.method === 'components'
        ? contract.rateOre * contract.fixedSharePercent / 100 + contract.variableRateOre * (1 - contract.fixedSharePercent / 100)
        : rate);
    const actual = month.importCostSek + investment.currentMonthlyFeeSek * month.monthFraction;
    const alternative = alternativeEnergy + (contract.method === 'quote' && contract.kind !== 'monthly' ? 0 : contract.monthlyFeeSek * month.monthFraction);
    const subscription = investment.subscriptionSek * month.monthFraction;
    return { ...month, actual, alternative, subscription, saving: alternative - actual, net: alternative - actual - subscription };
  });
  const sum = (key: 'actual' | 'alternative' | 'subscription' | 'saving' | 'net' | 'importKwh' | 'days' | 'monthFraction') => compared.reduce((s, m) => s + m[key], 0);
  const annualNet = sum('net') / sum('monthFraction') * 12;
  const investmentSek = investment.equipmentSek + investment.installationSek;
  return {
    months: compared, actual: sum('actual'), alternative: sum('alternative'), saving: sum('saving'),
    net: sum('net'), subscription: sum('subscription'), importKwh: sum('importKwh'), days: sum('days'),
    annualNet, annualSaving: sum('saving') / sum('monthFraction') * 12,
    investmentSek, paybackYears: annualNet > 0 ? investmentSek / annualNet : null,
    breakEvenOre: sum('importKwh') > 0 ? (sum('actual') + sum('subscription')) / sum('importKwh') * 100 : null,
  };
}

/** Transcribed user-provided screenshots, not a live offer feed. Headline rates include fees at 12,000 kWh/year. */
export const CONTRACT_EXAMPLES: { id: string; provider: string; kind: ContractKind; rate: number; years?: number }[] = [
  { id: 'svealand-5', provider: 'Svealands Elbolag', kind: 'fixed', rate: 113.28, years: 5 },
  { id: 'svealand-10', provider: 'Svealands Elbolag', kind: 'fixed', rate: 113.28, years: 10 },
  { id: 'eon-3', provider: 'E.ON', kind: 'fixed', rate: 114.15, years: 3 },
  { id: 'greenely-month', provider: 'Greenely', kind: 'monthly', rate: 80.75 },
  { id: 'cheap-month', provider: 'Cheap Energy', kind: 'monthly', rate: 80.76 },
  { id: 'tibber-month', provider: 'Tibber', kind: 'monthly', rate: 83.94 },
  { id: 'eon-month', provider: 'E.ON', kind: 'monthly', rate: 84.93 },
  { id: 'stockholm-month', provider: 'Stockholms Elbolag', kind: 'monthly', rate: 85.50 },
  { id: 'greenely-quarter', provider: 'Greenely', kind: 'quarterly', rate: 80.75 },
  { id: 'cheap-quarter', provider: 'Cheap Energy', kind: 'quarterly', rate: 80.76 },
  { id: 'tibber-quarter', provider: 'Tibber', kind: 'quarterly', rate: 82.94 },
  { id: 'eon-quarter', provider: 'E.ON', kind: 'quarterly', rate: 83.76 },
  { id: 'stockholm-quarter', provider: 'Stockholms Elbolag', kind: 'quarterly', rate: 85.50 },
  { id: 'vattenfall-mix', provider: 'Vattenfall', kind: 'mixed', rate: 114.08, years: 1 },
  { id: 'sevab-mix-3', provider: 'SEVAB', kind: 'mixed', rate: 115.83, years: 3 },
  { id: 'eskilstuna-mix', provider: 'Eskilstuna Energi & Miljö', kind: 'mixed', rate: 115.83, years: 3 },
  { id: 'svekraft-mix', provider: 'Svekraft', kind: 'mixed', rate: 118.49, years: 3 },
  { id: 'sevab-mix-2', provider: 'SEVAB', kind: 'mixed', rate: 118.95, years: 2 },
];

export function numericInput(value: string): number | null {
  return value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}
