// What an energy-history event means to the calculations.
//
// Events used to be free text on a date, drawn on a chart. That makes them a
// caption. This module makes them an input, because most of the confusing
// numbers in this product have a mundane explanation that only the customer
// knows: they were away, the heat pump was broken, someone moved out.
//
// Two treatments, selected by `event_type`:
//
//   * **Step change** — renovation, new heating system, solar, someone moving
//     in. Data before the date describes a different house or household. A
//     rolling twelve-month window that spans one is measuring two buildings and
//     averaging them; a year-over-year comparison across one is not
//     like-for-like. These do not remove days, they invalidate comparison.
//   * **Period** — a holiday, guests, a broken heat pump. Those days happened
//     but are not representative, so they are excluded from anything that fits
//     a model. They do not invalidate anything either side of them.
//
// The renovation case closes a gap recorded in §1.3.4a: the archetype prior
// reads a build year and cannot see improvements, so it is structurally
// pessimistic for an upgraded older house. A recorded renovation is the missing
// input, and `renovationHeatingFactor` is where it is applied — see the note
// there for why it is not applied by shifting the build year.

export const STEP_EVENT_TYPES = [
  'renovation',
  'heating_system_change',
  'solar_installed',
  'battery_installed',
  'major_load_added',
  'major_load_removed',
  'occupancy_increase',
  'occupancy_decrease',
] as const;

export const PERIOD_EVENT_TYPES = [
  'absence',
  'guests',
  'equipment_fault',
] as const;

export const ENERGY_EVENT_TYPES = [
  ...STEP_EVENT_TYPES,
  ...PERIOD_EVENT_TYPES,
  'other',
] as const;

export type EnergyEventType = (typeof ENERGY_EVENT_TYPES)[number];

export type EventTreatment = 'step' | 'period' | 'none';

export interface EnergyEvent {
  id?: string;
  note_date: string;
  end_date?: string | null;
  event_type?: string | null;
  event_text?: string;
}

const STEP = new Set<string>(STEP_EVENT_TYPES);
const PERIOD = new Set<string>(PERIOD_EVENT_TYPES);

export function treatmentOf(eventType: string | null | undefined): EventTreatment {
  if (eventType && STEP.has(eventType)) return 'step';
  if (eventType && PERIOD.has(eventType)) return 'period';
  return 'none';
}

/**
 * Which of the building's own properties an event changed.
 *
 * Used to say *why* a comparison is invalid rather than just that it is, and to
 * decide whether an older energy declaration still describes the building.
 */
export function stepAffects(eventType: string): {
  envelope: boolean;
  heatingSystem: boolean;
  generation: boolean;
  occupancy: boolean;
  load: boolean;
} {
  return {
    envelope: eventType === 'renovation',
    heatingSystem: eventType === 'heating_system_change',
    generation: eventType === 'solar_installed' || eventType === 'battery_installed',
    occupancy: eventType === 'occupancy_increase' || eventType === 'occupancy_decrease',
    load: eventType === 'major_load_added' || eventType === 'major_load_removed',
  };
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Every date covered by a period event, as ISO days.
 *
 * Inclusive of both ends: a holiday recorded as 1–14 July covers fourteen days,
 * not thirteen. A period longer than `maxSpanDays` is ignored rather than
 * trusted — a mistyped end date of 2035 would otherwise silently delete a
 * decade of measurement.
 */
export function periodDates(
  events: readonly EnergyEvent[],
  maxSpanDays = 400,
): Set<string> {
  const dates = new Set<string>();
  for (const event of events) {
    if (treatmentOf(event.event_type) !== 'period') continue;
    const start = event.note_date;
    const end = event.end_date ?? event.note_date;
    if (end < start) continue;

    let cursor = start;
    let guard = 0;
    while (cursor <= end && guard <= maxSpanDays) {
      dates.add(cursor);
      cursor = addDays(cursor, 1);
      guard += 1;
    }
  }
  return dates;
}

export interface StepChange {
  date: string;
  eventType: EnergyEventType;
  text: string;
}

/** Step changes inside a window, most recent first. */
export function stepChangesWithin(
  events: readonly EnergyEvent[],
  windowStart: string,
  windowEnd: string,
): StepChange[] {
  return events
    .filter(event => treatmentOf(event.event_type) === 'step')
    .filter(event => event.note_date >= windowStart && event.note_date <= windowEnd)
    .map(event => ({
      date: event.note_date,
      eventType: event.event_type as EnergyEventType,
      text: event.event_text ?? '',
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

/**
 * How much a recorded renovation reduces the *heating* term of the prior.
 *
 * The obvious approach — treat a 1970 house renovated in 2010 as part-way to
 * the 2010 cohort — is wrong, and the published data proves it. The build-year
 * bands in `energy-archetypes.ts` are not monotonic: 1981–1990 uses 94.7 kWh/m²
 * against 89.4 for 1961–1970. Shifting the effective build year from 1970 to
 * 1990 therefore made a renovated house score *worse*, which is nonsense to
 * show a customer who has just insulated their attic.
 *
 * The bands describe original construction cohorts, not renovation states. So a
 * renovation is applied as a direct reduction in heat demand instead, which is
 * physically what it is and is monotone by construction.
 *
 * The magnitude is **modelled**, not published: a typical domestic envelope
 * renovation touches part of the building, not all of it. It is applied once
 * however many renovations are recorded, because ten recorded window
 * replacements do not make a house ten times better, and it is deliberately
 * conservative so that measurement moves the number rather than the assumption.
 *
 * `heating_system_change` deliberately gets no factor here. The published
 * per-system figures already live in `HEATING_SYSTEM_FACTORS`; the customer
 * updating their heating type is what should move that term, and applying both
 * would count the same improvement twice.
 */
export const RENOVATION_HEATING_REDUCTION = 0.15;

export function renovationHeatingFactor(events: readonly EnergyEvent[]): number {
  const renovated = events.some(event => event.event_type === 'renovation');
  return renovated ? 1 - RENOVATION_HEATING_REDUCTION : 1;
}

/** The most recent recorded envelope renovation, if any. */
export function latestRenovationYear(events: readonly EnergyEvent[]): number | null {
  const years = events
    .filter(event => event.event_type === 'renovation')
    .map(event => Number(event.note_date.slice(0, 4)))
    .filter(Number.isFinite);
  return years.length > 0 ? Math.max(...years) : null;
}

export interface EventCoverageWarning {
  kind: 'step_inside_window' | 'period_days_excluded';
  /** Days removed, for the period case. */
  days?: number;
  steps?: StepChange[];
}

/**
 * What the UI needs to explain a window's numbers.
 *
 * Returned rather than applied, so the caller decides whether a step change is
 * fatal to its comparison or merely worth a footnote.
 */
export function eventCoverage(
  events: readonly EnergyEvent[],
  windowStart: string,
  windowEnd: string,
): EventCoverageWarning[] {
  const warnings: EventCoverageWarning[] = [];

  const steps = stepChangesWithin(events, windowStart, windowEnd);
  if (steps.length > 0) warnings.push({ kind: 'step_inside_window', steps });

  const excluded = [...periodDates(events)]
    .filter(date => date >= windowStart && date <= windowEnd);
  if (excluded.length > 0) {
    warnings.push({ kind: 'period_days_excluded', days: excluded.length });
  }

  return warnings;
}
