/// <reference lib="deno.ns" />

import { EnergyUsageCsvParseError, parseEnergyUsageCsv } from './energy-usage-parser.ts';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('parses the Swedish semicolon and decimal-comma export format', () => {
  const parsed = parseEnergyUsageCsv(`#Created: 2026-07-28
date;TS_735999102108382487.cons;
2026-06-02 00:00;0,1887;
2026-06-01 00:00;0,059;
`);

  assertEqual(parsed.delimiter, ';', 'delimiter');
  assertEqual(parsed.readings.length, 2, 'reading count');
  assertEqual(parsed.readings[0].readingDate, '2026-06-01', 'sorted first date');
  assertEqual(parsed.readings[0].consumptionKwh, 0.059, 'decimal comma');
  assertEqual(parsed.dateRange.end, '2026-06-02', 'date range end');
});

Deno.test('rejects duplicate daily readings instead of silently overwriting them', () => {
  let error: unknown;
  try {
    parseEnergyUsageCsv(`date;meter.cons
2026-06-01;12,5
2026-06-01;13,5
`);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof EnergyUsageCsvParseError, 'expected parser error');
  assert(String(error.message).includes('more than once'), 'duplicate error detail');
});

Deno.test('joins quoted comma-delimited files when a comma is the separator', () => {
  const parsed = parseEnergyUsageCsv(`date,"meter energy"
2026-01-01,"42.5"
`);
  assertEqual(parsed.delimiter, ',', 'delimiter');
  assertEqual(parsed.readings[0].consumptionKwh, 42.5, 'quoted number');
});
