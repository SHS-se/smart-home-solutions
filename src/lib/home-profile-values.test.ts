/// <reference lib="deno.ns" />

import {
  normalizeHomeProfileBoolean,
  normalizeHomeProfileNumber,
} from './home-profile-values.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('normalizes numeric home-profile answers without accepting invalid values', () => {
  assertEqual(normalizeHomeProfileNumber(160), 160, 'numeric answer');
  assertEqual(normalizeHomeProfileNumber('160,5'), 160.5, 'decimal-comma answer');
  assertEqual(normalizeHomeProfileNumber('not a number'), null, 'invalid answer');
});

Deno.test('normalizes boolean home-profile answers without guessing other strings', () => {
  assertEqual(normalizeHomeProfileBoolean(true), true, 'boolean true');
  assertEqual(normalizeHomeProfileBoolean('false'), false, 'string false');
  assertEqual(normalizeHomeProfileBoolean('yes'), null, 'ambiguous string');
});
