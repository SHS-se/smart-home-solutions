import { summariseTimeline, type TimelineRow } from './energy-timeline';

/**
 * Display-only estimate without selected consumption bands. Keep the captured
 * solar and battery trajectories and balance the removed demand at the grid:
 * first reduce imports, then export any surplus. Never re-solve the plan.
 * Band values are aligned with the already selected timeline window.
 */
export function summariseVisibleEnergy(
  rows: readonly TimelineRow[],
  excludedLoads: readonly (readonly number[])[],
) {
  let incomplete = false;
  const adjusted = excludedLoads.length === 0 ? rows : rows.map((row, index) => {
    if (row.missing) return row;
    let removedW = 0;
    for (const values of excludedLoads) {
      const value = values[index];
      if (Number.isFinite(value)) removedW += Math.max(0, value);
      else incomplete = true;
    }
    if (row.loadW === null) {
      incomplete = true;
      return row;
    }
    removedW = Math.min(row.loadW, removedW);
    if (removedW === 0) return row;
    const loadW = row.loadW - removedW;
    if (row.gridImportW === null || row.gridExportW === null) {
      incomplete = true;
      return { ...row, loadW, costSek: null };
    }
    const importedW = Math.abs(row.gridImportW);
    const avoidedImportW = Math.min(importedW, removedW);
    const addedExportW = removedW - avoidedImportW;
    const importPrice = row.importPriceSekPerKwh;
    const exportPrice = row.exportPriceSekPerKwh;
    const costKnown = row.costSek !== null
      && (avoidedImportW === 0 || importPrice !== null)
      && (addedExportW === 0 || exportPrice !== null);
    return {
      ...row,
      loadW,
      gridImportW: importedW - avoidedImportW,
      gridExportW: -(Math.abs(row.gridExportW) + addedExportW),
      costSek: costKnown
        ? row.costSek! - avoidedImportW / 4000 * (importPrice ?? 0) - addedExportW / 4000 * (exportPrice ?? 0)
        : null,
    };
  });
  return {
    ...summariseTimeline(adjusted, { from: 0, to: adjusted.length }),
    filtered: excludedLoads.length > 0,
    incomplete,
  };
}
