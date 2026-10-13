// What a recorded change to the home did to the electricity it buys.
//
// The earlier attempt (`buildSeasonalEventImpacts`) corrected for weather with
// one temperature curve fitted over every year on file. That curve blends the
// house before and after the very change being measured, so the correction
// cancels part of the effect. It also compared only three months.
//
// Here each side of a change gets its own curve, and the two are compared on
// the same weather: the days of a normal year, at the temperatures both sides
// actually experienced. Nothing is extrapolated past what was measured, so a
// change followed only by a summer cannot claim a winter saving. It is reported
// as not yet measurable instead.
//
// The result is the change in bought electricity that followed the date. It is
// attributable to the recorded change only as far as every other change to the
// home is recorded too: an unrecorded new load in the same months lands in the
// same number.

import { periodDates, treatmentOf, type EnergyEvent, type EnergyEventType } from './energy-events.ts';
import { COMPLETE_YEAR_MIN_OBSERVATIONS, HDD_BASE_TEMPERATURE_C, type DailyTemperature } from './energy-degree-days.ts';
import { buildEnergyTemperatureAnalysis, predictTemperatureRegression, type QuadraticRegression } from './energy-temperature-analysis.ts';

export interface DailyBoughtKwh { date: string; kwh: number }

/** Changes recorded this close together cannot be told apart and are measured as one. */
export const MERGE_WITHIN_DAYS = 30;
/** Each side is the year nearest the change: older data describes a house other changes may have altered. */
export const SIDE_WINDOW_DAYS = 365;
/** Fewer measured days than this on either side and no curve is fitted. */
export const MIN_SIDE_DAYS = 90;
/** The shared temperatures must carry at least this share of a normal year's heating. */
export const MIN_HEATING_SHARE = .5;
/** Consecutive days are not independent measurements; a week is treated as one. */
const INDEPENDENT_EVERY_DAYS = 7;

export interface RecordedChange { id: string; date: string; eventType: EnergyEventType; text: string }

export type ChangeImpact = { changes: RecordedChange[]; date: string } & (
  | { status: 'measured'
    /** Bought electricity over the compared days of a normal year. */
    beforeKwhPerYear: number; afterKwhPerYear: number; changeKwhPerYear: number;
    /** A change smaller than this cannot be told from ordinary variation. */
    noiseKwhPerYear: number; clear: boolean;
    /** Days of a normal year at temperatures both sides measured, and their share of its heating. */
    comparedDaysPerYear: number; heatingShare: number;
    beforeDays: number; afterDays: number }
  | { status: 'insufficient'; reason: 'before_short' | 'after_short' | 'no_heating_season' | 'no_weather'; beforeDays: number; afterDays: number });

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

interface Side { regression: QuadraticRegression; days: number; residuals: { temperatureC: number; kwh: number }[] }

function fitSide(bought: readonly DailyBoughtKwh[], weather: readonly DailyTemperature[], from: string, to: string): Side | number {
  const analysis = buildEnergyTemperatureAnalysis(
    bought.filter(day => day.date >= from && day.date <= to).map(day => ({ readingDate: day.date, consumptionKwh: day.kwh, readingKind: 'grid_import' as const })),
    weather.map(day => ({ observedOn: day.observed_on, temperatureC: day.temperature_c })));
  const regression = analysis.overall.regression, days = analysis.joinedPoints.length;
  if (days < MIN_SIDE_DAYS || !regression) return days;
  return { regression, days, residuals: analysis.joinedPoints.map(point => ({ temperatureC: point.temperatureC,
    kwh: point.consumptionKwh - predictTemperatureRegression(point.temperatureC, regression) })) };
}

/** Step changes in date order, with those too close to separate folded into one. */
function groupedChanges(events: readonly EnergyEvent[]): RecordedChange[][] {
  const steps = events.filter(event => treatmentOf(event.event_type) === 'step')
    .map((event, index) => ({ id: event.id ?? `${event.note_date}:${index}`, date: event.note_date, eventType: event.event_type as EnergyEventType, text: event.event_text ?? '' }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const groups: RecordedChange[][] = [];
  for (const step of steps) {
    const current = groups.at(-1);
    if (current && daysBetween(current.at(-1)!.date, step.date) <= MERGE_WITHIN_DAYS) current.push(step);
    else groups.push([step]);
  }
  return groups;
}

/**
 * One entry per recorded change (or cluster of changes), oldest first.
 *
 * `bought` is daily grid import. Days the customer marked as unrepresentative
 * (away, guests, a fault) are left out of both sides.
 */
export function changeImpacts(input: { bought: readonly DailyBoughtKwh[]; weather: readonly DailyTemperature[]; events: readonly EnergyEvent[] }): ChangeImpact[] {
  const excluded = periodDates(input.events);
  const bought = input.bought.filter(day => Number.isFinite(day.kwh) && day.kwh >= 0 && !excluded.has(day.date));
  const byYear = new Map<string, number[]>();
  for (const day of input.weather) {
    if (!Number.isFinite(day.temperature_c)) continue;
    const year = day.observed_on.slice(0, 4);
    (byYear.get(year) ?? byYear.set(year, []).get(year)!).push(day.temperature_c);
  }
  const normalYears = [...byYear.values()].filter(year => year.length >= COMPLETE_YEAR_MIN_OBSERVATIONS);
  const normalDays = normalYears.flat();
  const heating = (temperatures: readonly number[]) => temperatures.reduce((sum, t) => sum + Math.max(0, HDD_BASE_TEMPERATURE_C - t), 0);
  const groups = groupedChanges(input.events);

  return groups.map((changes, index): ChangeImpact => {
    const first = changes[0].date, last = changes.at(-1)!.date, date = first;
    // Neither side reaches across a neighbouring change.
    const earliest = index > 0 ? addDays(groups[index - 1].at(-1)!.date, 1) : '0000-01-01';
    const latest = index < groups.length - 1 ? addDays(groups[index + 1][0].date, -1) : '9999-12-31';
    const before = fitSide(bought, input.weather, [addDays(first, -SIDE_WINDOW_DAYS), earliest].sort()[1], addDays(first, -1));
    const after = fitSide(bought, input.weather, addDays(last, 1), [addDays(last, SIDE_WINDOW_DAYS), latest].sort()[0]);
    const beforeDays = typeof before === 'number' ? before : before.days, afterDays = typeof after === 'number' ? after : after.days;
    const insufficient = (reason: Extract<ChangeImpact, { status: 'insufficient' }>['reason']): ChangeImpact => ({ changes, date, status: 'insufficient', reason, beforeDays, afterDays });
    if (typeof before === 'number') return insufficient('before_short');
    if (typeof after === 'number') return insufficient('after_short');
    if (!normalDays.length) return insufficient('no_weather');

    // Compare only at temperatures both sides measured, weighted as a normal year has them.
    const low = Math.max(before.regression.startTemperatureC, after.regression.startTemperatureC) - .5;
    const high = Math.min(before.regression.endTemperatureC, after.regression.endTemperatureC) + .5;
    const shared = normalDays.filter(t => t >= low && t <= high);
    const heatingShare = heating(normalDays) > 0 ? heating(shared) / heating(normalDays) : 0;
    if (!shared.length || heatingShare < MIN_HEATING_SHARE) return insufficient('no_heating_season');

    const perYear = (side: Side) => shared.reduce((sum, t) => sum + Math.max(0, predictTemperatureRegression(t, side.regression)), 0) / normalYears.length;
    const comparedDaysPerYear = shared.length / normalYears.length;
    // Standard error of each side's mean day, from its own scatter at the shared temperatures.
    const meanVariance = (side: Side) => {
      const residuals = side.residuals.filter(r => r.temperatureC >= low && r.temperatureC <= high);
      if (residuals.length < 2) return Infinity;
      return residuals.reduce((sum, r) => sum + r.kwh ** 2, 0) / residuals.length / (residuals.length / INDEPENDENT_EVERY_DAYS);
    };
    const beforeKwhPerYear = perYear(before), afterKwhPerYear = perYear(after), changeKwhPerYear = afterKwhPerYear - beforeKwhPerYear;
    const noiseKwhPerYear = 2 * comparedDaysPerYear * Math.sqrt(meanVariance(before) + meanVariance(after));
    return { changes, date, status: 'measured', beforeKwhPerYear, afterKwhPerYear, changeKwhPerYear, noiseKwhPerYear,
      clear: Math.abs(changeKwhPerYear) > noiseKwhPerYear, comparedDaysPerYear, heatingShare, beforeDays: before.days, afterDays: after.days };
  });
}

/** Recorded events that have no type yet, so nothing can be measured from them. */
export function untypedEvents(events: readonly EnergyEvent[]): number {
  return events.filter(event => treatmentOf(event.event_type) === 'none').length;
}
