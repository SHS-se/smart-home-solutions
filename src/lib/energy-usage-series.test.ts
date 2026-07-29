/// <reference lib="deno.ns" />

import {
  buildMonthlyEnergyFlows,
  buildRollingAnnualEnergyProfile,
  selectEfficiencyReadings,
  type DailyEnergyReading,
} from './energy-usage-series.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('efficiency readings prefer whole-home load over grid import on the same day', () => {
  const selected = selectEfficiencyReadings([
    { readingDate: '2026-05-02', consumptionKwh: 8, readingKind: 'grid_import' },
    { readingDate: '2026-05-01', consumptionKwh: 40, readingKind: 'grid_import' },
    { readingDate: '2026-05-02', consumptionKwh: 52, readingKind: 'total_consumption' },
    { readingDate: '2026-05-03', consumptionKwh: 7, readingKind: 'grid_import' },
  ]);

  assertEqual(selected.length, 2, 'selected day count');
  assertEqual(selected[0].readingKind, 'grid_import', 'pre-solar proxy kind');
  assertEqual(selected[1].readingKind, 'total_consumption', 'preferred kind');
  assertEqual(selected[1].consumptionKwh, 52, 'preferred value');
});

Deno.test('monthly energy flow compares grid, whole-home load, and behind-meter supply', () => {
  const flows = buildMonthlyEnergyFlows([
    { readingDate: '2026-05-01', consumptionKwh: 10, readingKind: 'grid_import' },
    { readingDate: '2026-05-01', consumptionKwh: 40, readingKind: 'total_consumption' },
    { readingDate: '2026-05-02', consumptionKwh: 20, readingKind: 'grid_import' },
    { readingDate: '2026-05-02', consumptionKwh: 50, readingKind: 'total_consumption' },
  ]);

  assertEqual(flows.length, 1, 'month count');
  assertEqual(flows[0].gridImportAverageKwh, 15, 'grid daily average');
  assertEqual(flows[0].totalConsumptionAverageKwh, 45, 'whole-home daily average');
  assertEqual(flows[0].selfSuppliedAverageKwh, 30, 'behind-meter daily average');
  assertEqual(flows[0].pairedDays, 2, 'paired days');
});

Deno.test('rolling annual profile combines real whole-home load with earlier grid proxy', () => {
  const readings: DailyEnergyReading[] = [];
  for (let day = 0; day < 365; day += 1) {
    const readingDate = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
    readings.push({ readingDate, consumptionKwh: 30, readingKind: 'grid_import' });
    if (day >= 300) {
      readings.push({ readingDate, consumptionKwh: 50, readingKind: 'total_consumption' });
    }
  }

  const profile = buildRollingAnnualEnergyProfile(readings);
  assertEqual(profile.gridImportDays, 365, 'grid coverage');
  assertEqual(profile.efficiencyDays, 365, 'merged coverage');
  assertEqual(profile.actualTotalConsumptionDays, 65, 'actual whole-home days');
  assertEqual(profile.annualGridImportKwh, 10_950, 'annual grid import');
  assertEqual(profile.annualWholeHomeKwh, 12_250, 'merged annual whole-home load');
  assertEqual(profile.averageSelfSuppliedKwhPerDay, 20, 'paired-day average supply');
});

Deno.test('rolling annual profile does not substitute grid import after whole-home data starts', () => {
  const readings: DailyEnergyReading[] = [
    { readingDate: '2026-05-01', consumptionKwh: 30, readingKind: 'grid_import' },
    { readingDate: '2026-05-02', consumptionKwh: 12, readingKind: 'grid_import' },
    { readingDate: '2026-05-02', consumptionKwh: 50, readingKind: 'total_consumption' },
    { readingDate: '2026-05-03', consumptionKwh: 10, readingKind: 'grid_import' },
  ];

  const profile = buildRollingAnnualEnergyProfile(readings);
  assertEqual(profile.gridImportDays, 3, 'grid coverage');
  assertEqual(profile.efficiencyDays, 2, 'technical coverage');
  assertEqual(profile.actualTotalConsumptionDays, 1, 'whole-home coverage');
});
