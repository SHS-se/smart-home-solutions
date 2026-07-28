import { getEnergyCoverageIssues } from './energy-history-coverage.ts';
import type { EnergyBillingMonth } from './energy-billing-series.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function month(
  monthKey: string,
  daysInMonth: number,
  gridCoverageDays: number,
  electricityCoverageDays: number,
): EnergyBillingMonth {
  const [year, monthNumber] = monthKey.split('-').map(Number);
  const status = (days: number) => (
    days <= 0 ? 'missing' : days >= daysInMonth ? 'complete' : 'partial'
  ) as EnergyBillingMonth['gridCoverage'];
  return {
    monthKey,
    year,
    month: monthNumber,
    daysInMonth,
    gridCoverageDays,
    electricityCoverageDays,
    gridCoverage: status(gridCoverageDays),
    electricityCoverage: status(electricityCoverageDays),
    consumptionSource: null,
    exportSource: null,
    consumptionKwh: null,
    exportedKwh: null,
    gridConsumptionKwh: null,
    electricityConsumptionKwh: null,
    gridCostSek: null,
    electricityCostSek: null,
    totalCostSek: null,
    peakDemandKw: null,
    electricityEnergySek: 0,
    electricityFeesSek: 0,
    gridFixedSek: 0,
    gridTransferSek: 0,
    gridPeakSek: 0,
    energyTaxSek: 0,
    exportNetSek: 0,
  };
}

Deno.test('move-in date accepts complete coverage from the occupancy date', () => {
  const issues = getEnergyCoverageIssues([
    month('2021-03', 31, 19, 19),
    month('2021-04', 30, 30, 30),
  ], '2021-03-13');

  assert(issues.length === 0, 'the expected move-in partial month should not be an issue');
});

Deno.test('move-in month remains partial when invoices start after occupancy', () => {
  const issues = getEnergyCoverageIssues([
    month('2021-03', 31, 18, 19),
  ], '2021-03-13');

  assert(issues.length === 1, 'incomplete occupancy coverage should remain visible');
  assert(issues[0].gridCoverage === 'partial', 'grid coverage should remain partial');
  assert(issues[0].electricityCoverage === 'complete', 'electricity coverage should be accepted');
});

Deno.test('months between move-in and the first invoice are reported as missing', () => {
  const issues = getEnergyCoverageIssues([
    month('2021-05', 31, 31, 31),
  ], '2021-03-13');

  assert(issues.length === 2, 'March and April should be reported');
  assert(issues[0].monthKey === '2021-03', 'move-in month should be first');
  assert(issues[1].monthKey === '2021-04', 'intervening month should be included');
  assert(issues.every((issue) => issue.gridCoverage === 'missing'), 'leading months should be missing');
});

Deno.test('coverage behavior is unchanged when no move-in date is configured', () => {
  const issues = getEnergyCoverageIssues([
    month('2021-03', 31, 19, 19),
  ], null);

  assert(issues.length === 1, 'partial month should remain visible without a move-in date');
  assert(issues[0].gridCoverage === 'partial', 'original grid status should be retained');
  assert(issues[0].electricityCoverage === 'partial', 'original electricity status should be retained');
});
