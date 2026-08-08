import type { EnergyBillingChange } from './energy-billing-changes';
import type { EnergyBillingMonth } from './energy-billing-series';

const SAMPLE_MONTHS = [
  { key: '2025-07', consumption: 1380, exported: 245, energy: 620, fees: 184, transfer: 96, peak: 340, tax: 752 },
  { key: '2025-08', consumption: 1460, exported: 190, energy: 680, fees: 194, transfer: 102, peak: 350, tax: 796 },
  { key: '2025-09', consumption: 1710, exported: 96, energy: 865, fees: 222, transfer: 120, peak: 410, tax: 932 },
  { key: '2025-10', consumption: 2260, exported: 34, energy: 1320, fees: 288, transfer: 158, peak: 520, tax: 1232 },
  { key: '2025-11', consumption: 3180, exported: 8, energy: 2420, fees: 398, transfer: 223, peak: 710, tax: 1734 },
  { key: '2025-12', consumption: 4060, exported: 0, energy: 3320, fees: 500, transfer: 284, peak: 875, tax: 2213 },
  { key: '2026-01', consumption: 4380, exported: 0, energy: 4010, fees: 538, transfer: 307, peak: 945, tax: 2387 },
  { key: '2026-02', consumption: 3720, exported: 0, energy: 2940, fees: 458, transfer: 260, peak: 820, tax: 2028 },
  { key: '2026-03', consumption: 2680, exported: 40, energy: 1710, fees: 340, transfer: 188, peak: 605, tax: 1461 },
  { key: '2026-04', consumption: 1920, exported: 118, energy: 1090, fees: 249, transfer: 134, peak: 455, tax: 1046 },
  { key: '2026-05', consumption: 1510, exported: 210, energy: 730, fees: 198, transfer: 106, peak: 365, tax: 823 },
  { key: '2026-06', consumption: 1280, exported: 275, energy: 590, fees: 174, transfer: 90, peak: 320, tax: 698 },
] as const;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const ENERGY_HISTORY_SAMPLE_SERIES: EnergyBillingMonth[] = SAMPLE_MONTHS.map((sample) => {
  const [year, month] = sample.key.split('-').map(Number);
  const days = daysInMonth(year, month);
  const gridFixedSek = 915;
  const exportNetSek = -Math.round(sample.exported * 0.38);
  const gridCostSek = gridFixedSek + sample.transfer + sample.peak + sample.tax;
  const electricityCostSek = sample.energy + sample.fees + exportNetSek;

  return {
    monthKey: sample.key,
    year,
    month,
    daysInMonth: days,
    gridCoverageDays: days,
    electricityCoverageDays: days,
    gridCoverage: 'complete',
    electricityCoverage: 'complete',
    consumptionSource: 'grid',
    exportSource: 'electricity',
    consumptionKwh: sample.consumption,
    exportedKwh: sample.exported,
    gridConsumptionKwh: sample.consumption,
    electricityConsumptionKwh: sample.consumption,
    gridCostSek,
    electricityCostSek,
    totalCostSek: gridCostSek + electricityCostSek,
    peakDemandKw: Number((sample.peak / 100).toFixed(1)),
    electricityEnergySek: sample.energy,
    electricityFeesSek: sample.fees,
    // Sample amounts read as VAT-inclusive, so only the monthly subscription is
    // separated out; the rest of the fee bucket follows the kWh.
    electricityFixedSek: 49,
    electricityVatSek: 0,
    gridFixedSek,
    gridTransferSek: sample.transfer,
    gridPeakSek: sample.peak,
    gridVatSek: 0,
    energyTaxSek: sample.tax,
    exportNetSek,
  };
});

export const ENERGY_HISTORY_SAMPLE_CHANGES: EnergyBillingChange[] = [
  {
    id: 'sample-price-2026-01',
    date: '2026-01-01',
    monthKey: '2026-01',
    documentKind: 'grid',
    type: 'price',
    titleSv: 'Nätavgiften justerades',
    titleEn: 'Grid charges were adjusted',
    detailSv: 'Exempel på hur en bestående prisändring visas i historiken.',
    detailEn: 'An example of how a lasting price change appears in your history.',
  },
  {
    id: 'sample-provider-2026-06',
    date: '2026-06-01',
    monthKey: '2026-06',
    documentKind: 'electricity',
    type: 'provider',
    titleSv: 'Elhandlare byttes',
    titleEn: 'Electricity provider changed',
    detailSv: 'Exempel på hur ett leverantörsbyte markeras i diagrammen.',
    detailEn: 'An example of how a provider change is marked in the charts.',
  },
];
