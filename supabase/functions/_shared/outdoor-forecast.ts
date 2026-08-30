// Where the outdoor temperature a plan is built on comes from.
//
// Room comfort forecasting is the one part of the plan that needs tomorrow's
// weather: a 1R1C zone cannot be projected forward without knowing what it is
// losing heat to. Every other load — battery, boiler, pool, EV — plans on
// prices and its own recent history and needs no forecast at all.
//
// That asymmetry decides how a missing forecast is handled. A home whose
// weather provider stops short of the horizon should lose its comfort
// forecast, not its plan, so an absent series degrades rather than rejects.
//
// A series that arrives holed is the opposite case and is rejected. Home
// Assistant's contract is all-or-nothing precisely so that the two are
// distinguishable here: absence means "no provider reached that far", while a
// hole means something built a series it could not fill, and averaging over
// it would quietly plan a room against weather nobody forecast.

/** Slot-aligned outdoor temperatures, or why there are none. */
export type OutdoorSeries =
  | { status: "complete"; series: number[] }
  | { status: "absent" }
  | { status: "holed" };

/**
 * Classify the outdoor series a snapshot carries against its own horizon.
 *
 * `slotCount` is the snapshot's slot count rather than a constant, because
 * the horizon is a planner parameter and a series is only complete relative
 * to the plan it is for.
 */
export function classifyOutdoorSeries(
  outdoor: (number | null)[] | null | undefined,
  slotCount: number,
): OutdoorSeries {
  if (outdoor === null || outdoor === undefined) return { status: "absent" };
  if (outdoor.length !== slotCount) return { status: "holed" };
  const series: number[] = [];
  for (const value of outdoor) {
    if (value === null || !Number.isFinite(value)) return { status: "holed" };
    series.push(value);
  }
  return { status: "complete", series };
}
