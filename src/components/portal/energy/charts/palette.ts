/**
 * The plan chart's palette, one entry per thing rather than per series.
 *
 * Values live in index.css so both the SVG and the surrounding HTML read the
 * same token; these are the names, not the colours. Load slots are handed out
 * per meter in consumption-series.ts and never recycled by rank, so filtering a
 * band never repaints the ones that remain.
 */
export const PLAN_COLOURS = {
  solar: 'var(--plan-solar)',
  grid: 'var(--plan-grid)',
  battery: 'var(--plan-battery)',
  ev: 'var(--plan-ev)',
  base: 'var(--plan-base)',
} as const;

export const loadColour = (slot: number): string => `var(--plan-load-${slot})`;

