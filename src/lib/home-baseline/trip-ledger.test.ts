import { assertEquals, assertThrows } from '@std/assert';
import { inferredEvAvailability, recordedTrips } from './trip-ledger.ts';

Deno.test('hourly SOC aliases keep the EV absent between successive declining observations', () => {
  const demand = Object.freeze([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
  const independentSoc = Object.freeze([
    true, false, false, false, true, false, false, false,
    true, false, false, false, true, false, false, false,
  ]);
  assertEquals(inferredEvAvailability(demand, independentSoc), [
    false, false, false, false, false, false, false, false,
    false, false, false, false, true, true, true, true,
  ]);
  assertEquals(demand, [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
});

Deno.test('a genuine quarter observation can establish return inside an otherwise hourly source block', () => {
  assertEquals(inferredEvAvailability(
    [0, 1, 0, 0, 2, 0, 0, 0, 0],
    [true, true, false, true, true, false, false, false, true],
  ), [true, false, false, true, false, false, false, false, true]);
});

Deno.test('every withdrawal infers absence even when its quarter is an hourly alias', () => {
  assertEquals(inferredEvAvailability(
    [0, 0, .5, 0, 0],
    [true, false, false, false, true],
  ), [true, true, false, false, true]);
});

Deno.test('telemetry gaps cannot end an inferred absence, including at the open period end', () => {
  assertEquals(inferredEvAvailability(
    [0, 2, 0, 0, 0, 0],
    [true, true, false, false, false, false],
  ), [true, false, false, false, false, false]);
});

Deno.test('initial availability remains an assumption until an observed withdrawal', () => {
  assertEquals(inferredEvAvailability(
    [0, 0, 0, 1, 0, 0],
    [false, false, true, true, false, true],
  ), [true, true, true, false, false, true]);
});

Deno.test('independent zero-demand observations retain availability without inventing an absence', () => {
  assertEquals(inferredEvAvailability([0, 0, 0], [true, true, true]), [true, true, true]);
});

Deno.test('empty EV observation coverage produces an empty availability timeline', () => {
  assertEquals(inferredEvAvailability([], []), []);
});

Deno.test('EV availability rejects both shorter and longer observation coverage', () => {
  assertThrows(() => inferredEvAvailability([0, 1], [true]), Error, 'observation coverage');
  assertThrows(() => inferredEvAvailability([0], [true, false]), Error, 'observation coverage');
});

Deno.test('next withdrawal is strictly after the current quarter, including at a withdrawal', () => {
  assertEquals(recordedTrips([0, 2, 0, 3, 0], 5).next, new Int32Array([1, 3, 3, 5, 5]));
  assertEquals(recordedTrips([1, 2, 0], 3).next, new Int32Array([1, 3, 3]));
});

Deno.test('next withdrawal uses the exclusive period end when no later withdrawal exists', () => {
  assertEquals(recordedTrips([0, 0, 0], 3).next, new Int32Array([3, 3, 3]));
  assertEquals(recordedTrips([0, 0, 1], 3).next, new Int32Array([2, 2, 3]));
  assertEquals(recordedTrips([], 0).next, new Int32Array());
});

Deno.test('recorded withdrawals reject malformed coverage and invalid energy', () => {
  assertThrows(() => recordedTrips([0], 2), Error, 'Invalid recorded EV demand');
  assertThrows(() => recordedTrips([0, 1], 1), Error, 'Invalid recorded EV demand');
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assertThrows(() => recordedTrips([0, invalid], 2), Error, 'Invalid recorded EV demand');
  }
});
