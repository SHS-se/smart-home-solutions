/// <reference lib="deno.ns" />

import {
  buildIndicativeEnergyPerformance,
  classifyEnergyPerformance,
  smallHouseNewBuildRequirement,
} from './indicative-energy-performance.ts';
import type { DailyEnergyReading } from './energy-usage-series.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('maps Boverket requirement percentages to A-G boundary values', () => {
  assertEqual(classifyEnergyPerformance(50), 'A', 'A upper bound');
  assertEqual(classifyEnergyPerformance(50.01), 'B', 'B lower bound');
  assertEqual(classifyEnergyPerformance(75), 'B', 'B upper bound');
  assertEqual(classifyEnergyPerformance(100), 'C', 'C upper bound');
  assertEqual(classifyEnergyPerformance(135), 'D', 'D upper bound');
  assertEqual(classifyEnergyPerformance(180), 'E', 'E upper bound');
  assertEqual(classifyEnergyPerformance(235), 'F', 'F upper bound');
  assertEqual(classifyEnergyPerformance(235.01), 'G', 'G lower bound');
});

Deno.test('uses the BBR 31 small-house new-build requirement for heated area', () => {
  assertEqual(smallHouseNewBuildRequirement(50), null, '50 square metres');
  assertEqual(smallHouseNewBuildRequirement(90), 100, '90 square metres');
  assertEqual(smallHouseNewBuildRequirement(130), 95, '130 square metres');
  assertEqual(smallHouseNewBuildRequirement(131), 90, 'over 130 square metres');
});

Deno.test('builds a solar-aware indicative primary-energy estimate from daily sources', () => {
  const readings: DailyEnergyReading[] = [];
  for (let day = 0; day < 365; day += 1) {
    const readingDate = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
    readings.push({ readingDate, consumptionKwh: 30, readingKind: 'grid_import' });
    readings.push({ readingDate, consumptionKwh: 50, readingKind: 'total_consumption' });
  }

  const result = buildIndicativeEnergyPerformance(readings, 150);
  assertEqual(result.unavailableReason, null, 'available result');
  assertEqual(result.profile.annualGridImportKwh, 10_950, 'annual grid import');
  assertEqual(result.profile.annualWholeHomeKwh, 18_250, 'annual whole-home load');
  assertEqual(result.estimatedHouseholdElectricityKwh, 4_500, 'standard household energy');
  assertEqual(
    Math.round(result.estimatedDeliveredBuildingElectricityKwh ?? 0),
    8_250,
    'proportionally allocated delivered building electricity',
  );
  assertEqual(Math.round((result.primaryEnergyKwhM2 ?? 0) * 10) / 10, 99, 'primary energy');
  assertEqual(result.grade, 'D', 'indicative grade');
});

Deno.test('withholds the estimate until daily coverage is sufficient', () => {
  const readings: DailyEnergyReading[] = Array.from({ length: 20 }, (_, day) => ({
    readingDate: new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10),
    consumptionKwh: 30,
    readingKind: 'grid_import' as const,
  }));

  const result = buildIndicativeEnergyPerformance(readings, 150);
  assertEqual(result.grade, null, 'no grade');
  assertEqual(result.unavailableReason, 'insufficient_daily_data', 'coverage reason');
});

Deno.test('withholds a solar-home estimate when only grid import is available', () => {
  const readings: DailyEnergyReading[] = Array.from({ length: 365 }, (_, day) => ({
    readingDate: new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10),
    consumptionKwh: 30,
    readingKind: 'grid_import' as const,
  }));

  const result = buildIndicativeEnergyPerformance(readings, 150, true);
  assertEqual(result.grade, null, 'no grade');
  assertEqual(
    result.unavailableReason,
    'solar_requires_total_consumption',
    'solar evidence reason',
  );
});
