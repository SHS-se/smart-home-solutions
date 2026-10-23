/**
 * The plan chart's palette, one entry per thing rather than per series.
 *
 * Values live in index.css so both the SVG and the surrounding HTML read the
 * same token. Device colours are saved in the device catalogue, independently
 * of these semantic colours for flows, stores and aggregate measurements.
 */
export const PLAN_COLOURS = {
  solar: 'var(--plan-solar)',
  grid: 'var(--plan-grid)',
  battery: 'var(--plan-battery)',
  ev: 'var(--plan-ev)',
  base: 'var(--plan-base)',
  water: 'var(--plan-water)',
  pool: 'var(--plan-pool)',
  room: 'var(--plan-room)',
  cost: 'var(--plan-cost)',
  waterLine: 'var(--plan-water-line)',
} as const;

