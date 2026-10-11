import type { BaselineInput } from './model.ts';
import { DEFAULT_SETTINGS, electricityLedger, projectDefaultProblem, type ProjectionEngine } from './controller.ts';

export interface InputEvidence {
  hourlyImport: boolean[]; hourlyExport: boolean[]; assumedMarkup: boolean[];
  hourlyFields: { field: string; quarters: number }[];
  missingDevices: { key: string; name: string; quarters: number }[];
}
export interface Sensitivity {
  initial: { assumption: 'battery' | 'ev' | 'pool'; value: number; savingDeltaSek: number | null }[];
  markup10OreDeltaSek: number;
  timingSavingMinSek: number; timingSavingMaxSek: number;
}

/** Each effect is separate: scenarios are not a confidence interval or additive error bound. */
export function assessAssumptions(input: BaselineInput, baselineCost: number, importW: number[], engine: ProjectionEngine): Sensitivity {
  const initial: Sensitivity['initial'] = [];
  const scenario = (assumption: 'battery' | 'ev' | 'pool', value: number) => {
    const problem = { ...input.problem, initial: { ...input.problem.initial } };
    if (assumption === 'battery') problem.initial.battery_kwh = value / 100 * problem.battery!.capacity_kwh;
    if (assumption === 'ev') problem.initial.ev_kwh = value / 100 * problem.car!.capacity_kwh;
    if (assumption === 'pool') problem.initial.pool_c = value;
    let savingDeltaSek: number | null = null;
    try {
      const projected = projectDefaultProblem(problem, input.start, input.timeZone, DEFAULT_SETTINGS, engine, input.evDemandKwh);
      savingDeltaSek = electricityLedger(projected.quarters, projected.problem).costSek - baselineCost;
    } catch { /* The named scenario can be physically infeasible; never clip its demand. */ }
    initial.push({ assumption, value, savingDeltaSek });
  };
  if (input.batteryInitialAssumed) scenario('battery', input.problem.battery!.max_soc * 100);
  if (input.evInitialAssumed) scenario('ev', 20);
  if (input.poolInitialAssumed) { scenario('pool', 28); scenario('pool', 30.5); }
  let markup10OreDeltaSek = 0, actualLow = 0, actualHigh = 0;
  const hours = new Map<number, { energy: number; price: number }[][]>();
  input.recorded.rows.forEach((row, i) => {
    if (input.evidence.assumedMarkup[i]) markup10OreDeltaSek += .1 * (importW[i] - row.gridImportW!) * input.problem.slots[i].hours / 1000;
    const hour = Math.floor(row.startMs / 3_600_000);
    if (!hours.has(hour)) hours.set(hour, [[], []]);
    const channels = hours.get(hour)!;
    if (input.evidence.hourlyImport[i]) channels[0].push({ energy: row.gridImportW! * .25 / 1000, price: row.importPriceSekPerKwh! });
    if (input.evidence.hourlyExport[i]) channels[1].push({ energy: row.gridExportW! * .25 / 1000, price: row.exportPriceSekPerKwh! });
  });
  // Preserve the energy in the recovered quarters of each hour; measured quarters stay fixed.
  // This brackets recorded billing timing only, holding the default model unchanged.
  for (const channels of hours.values()) channels.forEach((points, channel) => {
    if (!points.length) return;
    const energy = points.reduce((n, p) => n + p.energy, 0), cost = points.reduce((n, p) => n + p.energy * p.price, 0);
    const low = energy * Math.min(...points.map(p => p.price)), high = energy * Math.max(...points.map(p => p.price));
    actualLow += channel === 0 ? low - cost : high - cost;
    actualHigh += channel === 0 ? high - cost : low - cost;
  });
  return { initial, markup10OreDeltaSek, timingSavingMinSek: -actualHigh, timingSavingMaxSek: -actualLow };
}

export function hasAssumptions(month: { gaps: Record<string, number>; assumptions: Record<string, boolean>; assumedPriceQuarters: number; quality: { evSocQuarters: number } }) {
  return Object.values(month.gaps).some(Boolean) || Object.values(month.assumptions).some(Boolean) || month.assumedPriceQuarters > 0 || month.quality.evSocQuarters > 0;
}
