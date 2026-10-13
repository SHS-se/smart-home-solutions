import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { changeImpacts, untypedEvents, type DailyBoughtKwh } from './change-impact.ts';
import type { DailyTemperature } from './energy-degree-days.ts';
import type { EnergyEvent } from './energy-events.ts';

const DAY = 86_400_000;
const dates = (from: string, to: string) => {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
};
// Cold in January, warm in July, with a small repeatable wobble so days are not identical.
const temperature = (date: string) => {
  const day = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`)) / DAY;
  return 7 - 12 * Math.cos(2 * Math.PI * (day - 20) / 365) + 2 * Math.sin(day * 1.7);
};
const weather: DailyTemperature[] = dates('2020-01-01', '2025-12-31').map(date => ({ observed_on: date, temperature_c: temperature(date) }));
/** A house that buys 10 kWh a day plus `heat` kWh per degree below 17 °C. */
const house = (from: string, to: string, heat: (date: string) => number, extra: (date: string) => number = () => 0): DailyBoughtKwh[] =>
  dates(from, to).map((date, i) => ({ date, kwh: 10 + heat(date) * Math.max(0, 17 - temperature(date)) + extra(date) + (i % 5 - 2) }));
const event = (note_date: string, event_type: string, extra: Partial<EnergyEvent> = {}): EnergyEvent => ({ id: `${event_type}:${note_date}`, note_date, event_type, event_text: event_type, ...extra });
const normalYearHeating = weather.filter(d => d.observed_on.startsWith('2021')).reduce((n, d) => n + Math.max(0, 17 - d.temperature_c), 0);

Deno.test('a renovation is measured against the year before it, on the same normal weather', () => {
  const bought = house('2022-01-01', '2024-12-31', date => date < '2023-07-01' ? 3 : 2.4);
  const [impact] = changeImpacts({ bought, weather, events: [event('2023-07-01', 'renovation')] });
  assert(impact.status === 'measured');
  // A fifth of the heating gone: 0.6 kWh for every degree-day of a normal year.
  assertAlmostEquals(impact.changeKwhPerYear, -.6 * normalYearHeating, .06 * normalYearHeating);
  assert(impact.clear && impact.heatingShare > .9 && impact.comparedDaysPerYear > 330);
  assertEquals([impact.beforeDays, impact.afterDays], [365, 365]);
});

Deno.test('a date where nothing changed is not reported as a clear change', () => {
  const bought = house('2022-01-01', '2024-12-31', () => 3);
  const [impact] = changeImpacts({ bought, weather, events: [event('2023-07-01', 'renovation')] });
  assert(impact.status === 'measured');
  assert(!impact.clear && Math.abs(impact.changeKwhPerYear) < impact.noiseKwhPerYear);
});

Deno.test('a change followed only by a summer claims nothing about the winter', () => {
  const bought = house('2022-01-01', '2023-08-31', date => date < '2023-05-01' ? 3 : 1);
  const [impact] = changeImpacts({ bought, weather, events: [event('2023-05-01', 'solar_installed')] });
  assertEquals([impact.status, impact.status === 'insufficient' && impact.reason], ['insufficient', 'no_heating_season']);
});

Deno.test('too few days on either side fit no curve', () => {
  const bought = house('2023-01-01', '2023-12-31', () => 3);
  assertEquals(changeImpacts({ bought, weather, events: [event('2023-02-01', 'renovation')] }).map(i => i.status === 'insufficient' && [i.reason, i.beforeDays]), [['before_short', 31]]);
  assertEquals(changeImpacts({ bought, weather, events: [event('2023-11-15', 'renovation')] }).map(i => i.status === 'insufficient' && [i.reason, i.afterDays]), [['after_short', 46]]);
});

Deno.test('changes close together are one, neighbours bound each side, and only typed lasting changes count', () => {
  const bought = house('2021-01-01', '2025-12-31', date => date < '2022-07-01' ? 3 : date < '2024-07-01' ? 2.4 : 1.8);
  const events = [event('2024-07-20', 'battery_installed'), event('2022-07-01', 'heating_system_change'), event('2024-07-01', 'solar_installed'),
    event('2023-01-10', 'absence', { end_date: '2023-01-20' }), event('2023-03-01', 'other'), event('2023-04-01', null as unknown as string)];
  const impacts = changeImpacts({ bought, weather, events });
  assertEquals(impacts.map(i => i.changes.map(c => c.eventType)), [['heating_system_change'], ['solar_installed', 'battery_installed']]);
  assertEquals(impacts.map(i => i.date), ['2022-07-01', '2024-07-01']);
  const [first, second] = impacts;
  assert(first.status === 'measured' && second.status === 'measured');
  // The after-side of the first change excludes the eleven days away and stops within its year.
  assertEquals(first.afterDays, 365 - 11);
  // The second change is measured from the day after its last event, not from the first.
  assertEquals(second.afterDays, 365);
  assertAlmostEquals(second.changeKwhPerYear, -.6 * normalYearHeating, .06 * normalYearHeating);
  assertEquals(untypedEvents(events), 2);
});

Deno.test('a new load in the same months lands in the same number: the figure is the change that followed, not its cause', () => {
  const bought = house('2022-01-01', '2024-12-31', date => date < '2023-07-01' ? 3 : 2.4, date => date < '2023-07-01' ? 0 : 20);
  const [impact] = changeImpacts({ bought, weather, events: [event('2023-07-01', 'renovation')] });
  assert(impact.status === 'measured');
  assert(impact.changeKwhPerYear > 0, 'insulation plus an unrecorded 20 kWh/day load shows as an increase');
});
