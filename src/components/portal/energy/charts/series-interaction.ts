/** Render identities, independent of palette, labels and planner transport. */
export type EnergySeriesId =
  | 'price:buy' | 'price:sell'
  | 'flow:solar' | 'flow:battery-in' | 'flow:battery-out' | 'flow:grid-in' | 'flow:grid-out'
  | 'base' | 'solar:outline' | `load:${string}`
  | 'soc:home' | 'soc:car' | 'temperature:pool' | `room:${string}` | `cost:${string}`;

export type EnergySeriesRelation = readonly EnergySeriesId[];

export const BUILTIN_RELATIONS: readonly EnergySeriesRelation[] = [
  ['flow:battery-in', 'flow:battery-out', 'soc:home'],
  ['flow:grid-in', 'flow:grid-out'],
  ['flow:solar', 'solar:outline'],
];

/** Direct relationships only: a shared heater must not link unrelated room meters transitively. */
export function spotlightSeries(active: EnergySeriesId | null, relations: readonly EnergySeriesRelation[]): ReadonlySet<EnergySeriesId> | null {
  if (active === null) return null;
  return new Set([active, ...relations.filter(group => group.includes(active)).flat()]);
}

export function seriesOpacity(id: EnergySeriesId, spotlight: ReadonlySet<EnergySeriesId> | null): number {
  return spotlight === null || spotlight.has(id) ? 1 : 0.18;
}

/** Spread direct labels, then pack upwards to keep them inside their data panel. */
export function placeSeriesLabels(anchors: readonly number[], top: number, height: number, gap = 18): number[] {
  const positions: number[] = [];
  anchors.forEach((anchor, i) => positions.push(Math.max(top + 9, anchor, i ? positions[i - 1] + gap : top + 9)));
  for (let i = positions.length - 1; i >= 0; i--) {
    positions[i] = Math.min(positions[i], i === positions.length - 1 ? top + height - 9 : positions[i + 1] - gap);
  }
  return positions;
}
