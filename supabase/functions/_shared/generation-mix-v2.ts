/** TEST-only public hydro-state and announced nuclear availability experiments. */
import { forecastGenerationMix, generationLocalTime, hourlyPanel, type GenerationMixForecast, type GenerationPrediction } from './generation-mix.ts';
import type { HydroDocument, HydroWeek } from './reservoir-hydrology.ts';
import { computeNuclearAvailability, type NuclearRoster, type NuclearOutageDocument } from './nuclear-availability.ts';

const HOUR = 3_600_000;
const NEIGHBOURS = 12;
export interface NuclearInputs {
  roster: NuclearRoster | null;
  productionOutages: NuclearOutageDocument | null;
  generationOutages: NuclearOutageDocument | null;
}
export type GenerationMixV2Input = Parameters<typeof forecastGenerationMix>[0] & {
  hydro: HydroDocument | null;
  nuclear: NuclearInputs;
};
export interface GenerationMixV2Forecast extends GenerationMixForecast {
  algorithm: 'se3-generation-analog-v2';
  driverDiagnostics: {
    hydro: { geography: string; statePolicy: string; weeks: number; trainingHours: number; scales: number[]; latestWeek: string | null };
    nuclear: { anchorStart: string | null; statePolicy: string; availability: ReturnType<typeof computeNuclearAvailability> | null };
  };
}
const absent = (reason: string): GenerationPrediction => ({ status: 'unavailable', reason });
function state(report: HydroWeek): number[] {
  return [report.se3FillingPercent, report.swedenInflowMedianPercent,
    report.swedenFillingPercent - report.swedenNormalFillingPercent];
}
function reportBefore(weeks: HydroWeek[], at: number): HydroWeek | null {
  const eligible = weeks.filter(week => week.providerModifiedAt !== null &&
    Number.isFinite(Date.parse(week.providerModifiedAt)) && Date.parse(week.providerModifiedAt) <= at &&
    Number.isFinite(Date.parse(week.weekEnd)) && Date.parse(week.weekEnd) <= at);
  return eligible.sort((a, b) => Date.parse(b.weekEnd) - Date.parse(a.weekEnd) ||
    Date.parse(b.providerModifiedAt!) - Date.parse(a.providerModifiedAt!))[0] ?? null;
}

/** v1 curves are copied unchanged; the extra candidates never replace a missing model. */
export function forecastGenerationMixV2(input: GenerationMixV2Input): GenerationMixV2Forecast {
  const base = forecastGenerationMix(input);
  const origin = Date.parse(base.origin);
  const panel = hourlyPanel(input.actuals, origin);
  const weeks = input.hydro?.weeks ?? [];
  const current = reportBefore(weeks, origin);
  const calendar = new Map<number, ReturnType<typeof generationLocalTime>>();
  const clock = (at: number) => {
    if (!calendar.has(at)) calendar.set(at, generationLocalTime(at));
    return calendar.get(at)!;
  };
  const hydroRows = [...(panel.get('B12')?.values() ?? [])].flatMap(row => {
    const report = reportBefore(weeks, row.start);
    return report ? [{ ...row, features: state(report), week: `${report.isoYear}-${report.isoWeek}`, clock: clock(row.start) }] : [];
  });
  const distinctWeeks = new Set(hydroRows.map(row => row.week));
  const scales = (hydroRows[0]?.features ?? []).map((_, column) => {
    const mean = hydroRows.reduce((sum, row) => sum + row.features[column], 0) / hydroRows.length;
    const deviation = Math.sqrt(hydroRows.reduce((sum, row) => sum + (row.features[column] - mean) ** 2, 0) / hydroRows.length);
    return deviation || 1; // A constant feature contributes zero distance; it is not missing evidence.
  });
  const nuclearRows = [...(panel.get('B14')?.values() ?? [])].sort((a, b) => a.start - b.start);
  const anchor = nuclearRows.at(-1);
  let firstAvailability: ReturnType<typeof computeNuclearAvailability> | null = null;
  for (const hour of base.hours) {
    const target = Date.parse(hour.start), targetClock = clock(target);
    const nuclear = anchor ? computeNuclearAvailability(input.nuclear, anchor.start, target) : null;
    if (firstAvailability === null && nuclear) firstAvailability = nuclear;
    for (const [psrType, models] of Object.entries(hour.byPsr)) {
      models.hydro_state = absent('Hydro-state model applies only to reservoir hydro B12.');
      models.nuclear_delta = absent('Nuclear availability model applies only to nuclear B14.');
      models.nuclear_ratio = absent('Nuclear availability model applies only to nuclear B14.');
      if (psrType === 'B12') {
        const neighbours = current && distinctWeeks.size >= 2 ? hydroRows.filter(row =>
          row.clock.hour === targetClock.hour && row.clock.dayType === targetClock.dayType)
          .map(row => ({ row, distance: row.features.reduce((sum, value, index) =>
            sum + ((value - state(current)[index]) / scales[index]) ** 2, 0) / scales.length }))
          .sort((a, b) => a.distance - b.distance || b.row.start - a.row.start).slice(0, NEIGHBOURS) : [];
        if (neighbours.length) {
          const weights = neighbours.map(value => 1 / (1 + value.distance));
          models.hydro_state = { status: 'predicted',
            mw: neighbours.reduce((sum, value, index) => sum + value.row.mw * weights[index], 0) / weights.reduce((sum, value) => sum + value, 0),
            trainingSamples: neighbours.length,
            latestTrainingEnd: new Date(Math.max(...neighbours.map(value => value.row.start + HOUR))).toISOString() };
        } else models.hydro_state = absent(!current ? 'No completed Swedish hydro report with known provider modification time.'
          : distinctWeeks.size < 2 ? 'Fewer than two historical hydro report states paired with complete MW hours.'
          : 'No paired hydro-state hours with matching Stockholm hour and day type.');
      }
      if (psrType === 'B14') {
        if (!anchor || !nuclear || nuclear.status !== 'data') {
          const reason = nuclear?.status === 'unavailable' ? nuclear.reason : 'No complete measured nuclear anchor hour.';
          models.nuclear_delta = absent(reason); models.nuclear_ratio = absent(reason);
        } else {
          const provenance = { trainingSamples: 1, latestTrainingEnd: new Date(anchor.start + HOUR).toISOString() };
          models.nuclear_delta = { status: 'predicted', mw: anchor.mw + nuclear.targetMw - nuclear.anchorMw, ...provenance };
          models.nuclear_ratio = nuclear.anchorMw > 0
            ? { status: 'predicted', mw: anchor.mw / nuclear.anchorMw * nuclear.targetMw, ...provenance }
            : absent('Announced available capacity is zero at the measured anchor hour; utilisation ratio is undefined.');
        }
      }
    }
  }
  return { ...base, algorithm: 'se3-generation-analog-v2', driverDiagnostics: {
    hydro: { geography: 'Reservoir: SE3; inflow and seasonal storage anomaly: Sweden.',
      statePolicy: 'Persist the latest completed and provider-dated weekly state across the forecast horizon.',
      weeks: distinctWeeks.size, trainingHours: hydroRows.length, scales,
      latestWeek: current ? `${current.isoYear}-${String(current.isoWeek).padStart(2, '0')}${current.version}` : null },
    nuclear: { anchorStart: anchor ? new Date(anchor.start).toISOString() : null,
      statePolicy: 'Announced hourly available capacity change or ratio applied to latest measured nuclear MW; no clipping or assumed restart observation.',
      availability: firstAvailability },
  } };
}
