import type { BaselineCapture } from './browser';

/** Retained solar includes battery charging. Export meters do not identify energy origin. */
export function periodComparison(capture: BaselineCapture) {
  const { input, result } = capture;
  const solar = (watts: readonly (number | null)[], exported: number) => Math.max(0, watts.reduce<number>((sum, w) => sum + (w ?? 0) / 4000, 0) - exported);
  return {
    baseline: { gridKwh: result.ledger.importKwh, solarKwh: solar(result.series.solarW, result.ledger.exportKwh), exportKwh: result.ledger.exportKwh, costSek: result.ledger.costSek },
    actual: { gridKwh: input.recorded.ledger.importKwh, solarKwh: solar(input.recorded.rows.map(row => row.solarW), input.recorded.ledger.exportKwh), exportKwh: input.recorded.ledger.exportKwh, costSek: input.recorded.ledger.costSek },
    savingSek: result.ledger.costSek - input.recorded.ledger.costSek,
  };
}
