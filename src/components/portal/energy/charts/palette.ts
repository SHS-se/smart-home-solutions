/**
 * The plan chart's palette, one entry per thing rather than per series.
 *
 * chart-palette.json is the shared definition for generated CSS tokens and
 * the database allocator. Device assignments are saved once from this set.
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

