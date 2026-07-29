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
  assertEqual(parsed.readingKind, 'grid_import', 'reading kind');
  assertEqual(parsed.sourceFormat, 'daily_grid_consumption', 'source format');
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
  const parsed = parseEnergyUsageCsv(`date,"consumption"
2026-01-01,"42.5"
`);
  assertEqual(parsed.delimiter, ',', 'delimiter');
  assertEqual(parsed.readings[0].consumptionKwh, 42.5, 'quoted number');
});

Deno.test('recognizes the Swedish förbrukning column advertised by the upload form', () => {
  const parsed = parseEnergyUsageCsv(`datum;förbrukning
2026-01-01;42,5
`);

  assertEqual(parsed.readings[0].consumptionKwh, 42.5, 'Swedish consumption column');
});

Deno.test('rejects an ambiguous production CSV instead of labelling it as grid import', () => {
  let error: unknown;
  try {
    parseEnergyUsageCsv(`date;production_kwh
2026-01-01;42,5
`);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof EnergyUsageCsvParseError, 'expected parser error');
  assert(String(error.message).includes('unrecognized energy CSV'), 'format error detail');
});

Deno.test('recognizes Sigenergy total-load history and converts cumulative MWh to complete Stockholm days', () => {
  const parsed = parseEnergyUsageCsv(`entity_id,state,last_changed
sensor.sigen_plant_total_load_consumption,1.000,2026-05-01T22:00:00Z
sensor.sigen_plant_total_load_consumption,unknown,2026-05-02T10:00:00Z
sensor.sigen_plant_total_load_consumption,1.024,2026-05-02T22:00:00Z
sensor.sigen_plant_total_load_consumption,1.060,2026-05-03T22:00:00Z
sensor.sigen_plant_total_load_consumption,1.108,2026-05-04T22:00:00Z
`, 'history.csv');

  assertEqual(parsed.readingKind, 'total_consumption', 'reading kind');
  assertEqual(parsed.sourceFormat, 'home_assistant_sigenergy_total_load', 'source format');
  assertEqual(parsed.ignoredSourceRows, 1, 'ignored unavailable state');
  assertEqual(parsed.readings.length, 1, 'only complete interior day');
  assertEqual(parsed.readings[0].readingDate, '2026-05-03', 'Stockholm day');
  assertEqual(parsed.readings[0].consumptionKwh, 36, 'MWh delta converted to kWh');
});

Deno.test('rejects a different Home Assistant entity instead of guessing its semantics', () => {
  let error: unknown;
  try {
    parseEnergyUsageCsv(`entity_id,state,last_changed
sensor.some_other_meter,1.000,2026-05-01T22:00:00Z
sensor.some_other_meter,1.024,2026-05-02T22:00:00Z
sensor.some_other_meter,1.060,2026-05-03T22:00:00Z
sensor.some_other_meter,1.108,2026-05-04T22:00:00Z
`);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof EnergyUsageCsvParseError, 'expected parser error');
  assert(String(error.message).includes('unsupported Home Assistant entity'), 'entity error detail');
});

Deno.test('rejects cumulative meter rollbacks', () => {
  let error: unknown;
  try {
    parseEnergyUsageCsv(`entity_id,state,last_changed
sensor.sigen_plant_total_load_consumption,1.000,2026-05-01T22:00:00Z
sensor.sigen_plant_total_load_consumption,1.024,2026-05-02T22:00:00Z
sensor.sigen_plant_total_load_consumption,1.010,2026-05-03T22:00:00Z
sensor.sigen_plant_total_load_consumption,1.108,2026-05-04T22:00:00Z
`);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof EnergyUsageCsvParseError, 'expected parser error');
  assert(String(error.message).includes('meter decreased'), 'rollback error detail');
});
