import type { BaselineInput } from './model.ts';
import type { MonthLedger } from './savings.ts';
import { modeledCosts } from './roi-pricing.ts';

export interface SolarSizing { arrayKwp: number; inverterKw: number }
export interface EquipmentTrial {
  solar: { current: SolarSizing; proposed: SolarSizing } | null;
  /** null keeps the pinned battery; zero removes it from this simulation. */
  batteryKwh: number | null;
}
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;

export function solarSizing(value: { peak_kw?: unknown; inverter_kw?: unknown } | null): SolarSizing | null {
  if (value?.peak_kw == null || value.inverter_kw == null) return null;
  if (typeof value.peak_kw !== 'number' || typeof value.inverter_kw !== 'number'
    || !nonnegative(value.peak_kw) || !nonnegative(value.inverter_kw) || value.peak_kw === 0 || value.inverter_kw === 0) {
    throw new Error('Invalid installed solar array or inverter size');
  }
  return { arrayKwp: value.peak_kw, inverterKw: value.inverter_kw };
}

/** Same roof and AC generation shape; previously clipped production is unknown.
 * Only hypothetical inputs change. Measured evidence keeps its original identity. */
export function equipmentInput(input: BaselineInput, trial: EquipmentTrial): BaselineInput {
  let { battery } = input.problem;
  let initial = input.problem.initial;
  let limits = input.problem.limits;
  if (trial.batteryKwh !== null) {
    if (!nonnegative(trial.batteryKwh)) throw new Error('Battery capacity must be zero or greater');
    if (trial.batteryKwh === 0) {
      battery = null;
      initial = { ...initial, battery_kwh: null };
      limits = { ...limits, battery_export_enabled: false, battery_export_reserve_kwh: 0, wear_per_kwh: 0 };
    } else {
      if (!battery || initial.battery_kwh === null) throw new Error('Battery sizing needs the current battery power limits, efficiencies and SOC bounds');
      initial = { ...initial, battery_kwh: initial.battery_kwh * trial.batteryKwh / battery.capacity_kwh };
      battery = { ...battery, capacity_kwh: trial.batteryKwh };
    }
  }
  let slots = input.problem.slots;
  if (trial.solar) {
    const { current, proposed } = trial.solar;
    if (![current.arrayKwp, current.inverterKw].every(v => nonnegative(v) && v > 0)) throw new Error('Enter the installed solar array and inverter sizes');
    if (![proposed.arrayKwp, proposed.inverterKw].every(nonnegative)) throw new Error('Solar array and inverter sizes must be zero or greater');
    if (current.arrayKwp !== proposed.arrayKwp || current.inverterKw !== proposed.inverterKw) {
      const scale = proposed.arrayKwp / current.arrayKwp;
      slots = slots.map(slot => ({ ...slot, solar_w: Math.min(slot.solar_w * scale, proposed.inverterKw * 1000) }));
    }
  }
  return { ...input, equipment: structuredClone(trial), batteryInitialAssumed: battery ? input.batteryInitialAssumed : false,
    problem: { ...input.problem, battery, initial, limits, slots } };
}

/** Compare common completed intervals; account for changed stored-energy inventory
 * using the simulator's existing end-credit terms, without annual extrapolation. */
export function equipmentBenefit(reference: readonly MonthLedger[], selected: readonly MonthLedger[]) {
  const byMonth = new Map(reference.map(month => [month.month, month]));
  const rows = selected.flatMap(month => {
    const current = byMonth.get(month.month);
    if (!current || current.start !== month.start || current.end !== month.end || current.timeZone !== month.timeZone
      || current.coverage !== month.coverage || current.solar.profileHash !== month.solar.profileHash
      || current.replay.engine !== month.replay.engine || current.replay.protocol !== month.replay.protocol) return [];
    const currentSek = modeledCosts(current.modeled).scheduler.totalSek - current.modeled.schedulerService.endCreditSek;
    const selectedSek = modeledCosts(month.modeled).scheduler.totalSek - month.modeled.schedulerService.endCreditSek;
    return [{ month: month.month, currentSek, selectedSek, savingSek: currentSek - selectedSek,
      currentImportKwh: current.scheduler.importKwh, selectedImportKwh: month.scheduler.importKwh,
      currentExportKwh: current.scheduler.exportKwh, selectedExportKwh: month.scheduler.exportKwh }];
  });
  if (!rows.length) return null;
  const sum = (key: keyof Omit<typeof rows[number], 'month'>) => rows.reduce((n, row) => n + row[key], 0);
  return { rows, currentSek: sum('currentSek'), selectedSek: sum('selectedSek'), savingSek: sum('savingSek'),
    currentImportKwh: sum('currentImportKwh'), selectedImportKwh: sum('selectedImportKwh'),
    currentExportKwh: sum('currentExportKwh'), selectedExportKwh: sum('selectedExportKwh') };
}
