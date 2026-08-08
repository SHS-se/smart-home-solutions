/// <reference lib="deno.ns" />

import type { EnergyDeviceReadingRecord } from './energy-device-readings.ts';
import type { EnergyUsageReadingRecord } from './energy-temperature-storage.ts';
import {
  resolveDailyUsageReadings,
  summariseUsageSources,
} from './energy-usage-resolution.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function imported(
  readingDate: string,
  readingKind: string,
  consumptionKwh: number,
): EnergyUsageReadingRecord {
  return {
    id: `import-${readingDate}-${readingKind}`,
    customer_id: 'customer-1',
    reading_date: readingDate,
    reading_kind: readingKind,
    consumption_kwh: consumptionKwh,
    source_import_id: 'batch-1',
    created_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-28T00:00:00Z',
  };
}

function pushed(
  readingDate: string,
  category: string,
  kwh: number,
): EnergyDeviceReadingRecord {
  return {
    id: `device-${readingDate}-${category}`,
    customer_id: 'customer-1',
    reading_date: readingDate,
    category,
    kwh,
    device_token_id: 'token-1',
    created_at: '2026-08-06T00:20:00Z',
    updated_at: '2026-08-06T00:20:00Z',
  };
}

Deno.test('an uploaded day wins over the same day from Home Assistant', () => {
  const resolved = resolveDailyUsageReadings(
    [imported('2026-07-26', 'grid_import', 4.87)],
    [pushed('2026-07-26', 'grid_import', 5.5)],
  );

  assertEqual(resolved.length, 1, 'row count');
  assertEqual(resolved[0].consumption_kwh, 4.87, 'uploaded value kept');
  assertEqual(resolved[0].source_import_id, 'batch-1', 'stays attributed to the upload');
});

Deno.test('days the upload never reached fall back to Home Assistant', () => {
  const resolved = resolveDailyUsageReadings(
    [imported('2026-07-26', 'grid_import', 4.87)],
    [
      pushed('2026-07-26', 'grid_import', 5.5),
      pushed('2026-08-01', 'grid_import', 3.2),
      pushed('2026-08-02', 'grid_import', 2.9),
    ],
  );

  assertEqual(resolved.length, 3, 'row count');
  assertEqual(resolved.at(-1)!.reading_date, '2026-08-02', 'series now reaches August');
  assertEqual(resolved.at(-1)!.source_import_id, null, 'marked as device-sourced');
  assertEqual(resolved.at(-1)!.consumption_kwh, 2.9, 'pushed value used');
});

Deno.test('the same day can be uploaded for one kind and pushed for the other', () => {
  const resolved = resolveDailyUsageReadings(
    [imported('2026-07-26', 'grid_import', 4.87)],
    [
      pushed('2026-07-26', 'grid_import', 5.5),
      pushed('2026-07-26', 'total_consumption', 41.3),
    ],
  );

  assertEqual(resolved.length, 2, 'row count');
  const total = resolved.find((row) => row.reading_kind === 'total_consumption');
  assertEqual(total?.consumption_kwh ?? 0, 41.3, 'total consumption filled in');
  const grid = resolved.find((row) => row.reading_kind === 'grid_import');
  assertEqual(grid?.consumption_kwh ?? 0, 4.87, 'grid import still authoritative');
});

Deno.test('categories outside the usage series are ignored', () => {
  const resolved = resolveDailyUsageReadings([], [
    pushed('2026-08-01', 'heating', 12),
    pushed('2026-08-01', 'ev_charging', 8),
    pushed('2026-08-01', 'grid_import', 3.2),
  ]);

  assertEqual(resolved.length, 1, 'only grid_import is usage data');
  assertEqual(resolved[0].reading_kind, 'grid_import', 'kind');
});

Deno.test('readings stay ordered by date once merged', () => {
  const resolved = resolveDailyUsageReadings(
    [imported('2026-07-26', 'grid_import', 4.87)],
    [pushed('2026-06-30', 'grid_import', 1.1), pushed('2026-08-01', 'grid_import', 3.2)],
  );

  assertEqual(
    resolved.map((row) => row.reading_date).join(','),
    '2026-06-30,2026-07-26,2026-08-01',
    'chronological',
  );
});

Deno.test('source coverage separates uploaded days from pushed days', () => {
  const summary = summariseUsageSources(resolveDailyUsageReadings(
    [imported('2026-07-25', 'grid_import', 4), imported('2026-07-26', 'grid_import', 5)],
    [pushed('2026-08-01', 'grid_import', 3.2), pushed('2026-08-05', 'grid_import', 2.4)],
  ));

  assertEqual(summary.importedDays, 2, 'uploaded days');
  assertEqual(summary.deviceDays, 2, 'pushed days');
  assertEqual(summary.lastImportedDate, '2026-07-26', 'last uploaded');
  assertEqual(summary.lastDeviceDate, '2026-08-05', 'last pushed');
});
