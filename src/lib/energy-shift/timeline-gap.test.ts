import { assertEquals } from 'jsr:@std/assert@1';
import { timelineGapDescription } from './timeline-gap.ts';
const start = Date.parse('2026-09-12T08:00:00+02:00');
const english = (_sv: string, en: string) => en;
const atMinute = (minute: number) => timelineGapDescription(start, start + minute * 60_000, english);

Deno.test('an unfinished quarter is in progress, not a missing measurement', () => {
  assertEquals(atMinute(0).label, 'Quarter in progress');
  assertEquals(atMinute(14).label, 'Quarter in progress');
});
Deno.test('recently completed quarters await the upload and browser sync', () => {
  assertEquals(atMinute(15).label, 'Awaiting measurements');
  assertEquals(atMinute(25).label, 'Awaiting measurements');
  assertEquals(atMinute(44).label, 'Awaiting measurements');
});
Deno.test('older gaps describe unavailable measurements without asserting permanent loss', () => {
  assertEquals(atMinute(45).label, 'No measurements');
  assertEquals(atMinute(120).detail.includes('may still arrive'), true);
});
Deno.test('future gaps refer to plans, and Swedish gets the same distinction', () => {
  assertEquals(atMinute(-1).label, 'No plan');
  assertEquals(timelineGapDescription(start, start + 25 * 60_000, sv => sv).label, 'Inväntar mätvärden');
});
