// Axis domains for charts that draw prices and power together.

/**
 * Domains that put zero at the same height on both axes.
 *
 * Grid export is drawn negative — energy leaving the house — so the power axis
 * reaches below zero. Leaving the price axis at [0, max] would sit its zero on
 * the floor while the power zero floated somewhere above it, so reading a price
 * against a flow would be wrong by that offset everywhere on the chart.
 *
 * The price axis is the one stretched, because a negative price is a coherent
 * thing to show (they happen) while negative solar production is not.
 */
export function alignedDomains(
  rows: ReadonlyArray<{ price: number; power: number }>,
): { price: [number, number]; power: [number, number] } {
  // The floors keep an empty or all-zero window from collapsing an axis to a
  // point, which makes recharts draw nothing rather than an empty chart.
  const priceMax = Math.max(0.01, ...rows.map(row => row.price));
  const powerMax = Math.max(0.01, ...rows.map(row => row.power));
  const powerMin = Math.min(0, ...rows.map(row => row.power));
  return {
    price: [priceMax * (powerMin / powerMax), priceMax],
    power: [powerMin, powerMax],
  };
}
