/// <reference lib="deno.ns" />

import { FUNCTION_REGION_PARAM, pinFunctionRegion } from './function-region.ts';

const FUNCTIONS = 'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1';
const REST = 'https://vxqpgbzseckgceopitpm.supabase.co/rest/v1';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('an Edge Function call is pinned to the database region', () => {
  assertEqual(
    pinFunctionRegion(`${FUNCTIONS}/energy-optimisation-replan`, 'eu-central-1'),
    `${FUNCTIONS}/energy-optimisation-replan?${FUNCTION_REGION_PARAM}=eu-central-1`,
    'replan',
  );
});

Deno.test('an existing query string is kept, not replaced', () => {
  assertEqual(
    pinFunctionRegion(`${FUNCTIONS}/unsubscribe?token=abc`, 'eu-central-1'),
    `${FUNCTIONS}/unsubscribe?token=abc&${FUNCTION_REGION_PARAM}=eu-central-1`,
    'unsubscribe',
  );
});

Deno.test('a caller that chose its own region keeps it', () => {
  const pinned = `${FUNCTIONS}/check-env?${FUNCTION_REGION_PARAM}=us-east-1`;
  assertEqual(pinFunctionRegion(pinned, 'eu-central-1'), pinned, 'explicit region');
});

Deno.test('PostgREST is never pinned', () => {
  // PostgREST reads unknown query parameters as column filters, so a pin here
  // would turn an ordinary table read into an error about a missing column.
  const table = `${REST}/energy_optimisation_current?select=home_id`;
  assertEqual(pinFunctionRegion(table, 'eu-central-1'), table, 'rest');

  const auth = 'https://vxqpgbzseckgceopitpm.supabase.co/auth/v1/token?grant_type=password';
  assertEqual(pinFunctionRegion(auth, 'eu-central-1'), auth, 'auth');

  const storage = 'https://vxqpgbzseckgceopitpm.supabase.co/storage/v1/object/sign/docs/x.pdf';
  assertEqual(pinFunctionRegion(storage, 'eu-central-1'), storage, 'storage');
});

Deno.test('a build with no region configured changes nothing', () => {
  const url = `${FUNCTIONS}/energy-optimisation-replan`;
  assertEqual(pinFunctionRegion(url, undefined), url, 'undefined');
  assertEqual(pinFunctionRegion(url, ''), url, 'empty');
});

Deno.test('something that is not a URL is handed back untouched', () => {
  assertEqual(pinFunctionRegion('/functions/v1/replan', 'eu-central-1'), '/functions/v1/replan', 'relative');
});

Deno.test('a path that merely mentions functions elsewhere is not pinned', () => {
  const url = `${REST}/functions/v1/rows?select=*`;
  assertEqual(pinFunctionRegion(url, 'eu-central-1'), url, 'lookalike');
});
