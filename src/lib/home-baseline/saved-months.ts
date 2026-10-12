import { sha256 } from '@noble/hashes/sha2.js';
import runtime from '../../../supabase/functions/_shared/planner-wasm/runtime-config.json' with { type: 'json' };
import { ROI_SUPPLIER_TERMS } from '../../../supabase/functions/_shared/roi-supplier-terms.ts';
import { z } from 'zod';
import { REPLAY_ENGINE, REPLAY_PROTOCOL } from './scheduler-replay.ts';
import artifact from '../../../supabase/functions/_shared/planner-wasm/artifact.json' with { type: 'json' };
import { homePhysics, type HomeModelCapture } from './home-physics.ts';
import type { HomeRef } from './history.ts';
import type { MonthLedger } from './savings.ts';
import { homeMonthBounds } from '../energy-shift/home-time.ts';
import { localDay } from '../../../supabase/functions/_shared/planner-wasm/calendar.ts';

// v4 pins historical solar reconstruction and removes assumption sensitivity output.
// The engine version is checked inside every saved ledger.
export const CALCULATION_VERSION = `roi-month-v4:${Array.from(sha256(new TextEncoder().encode(JSON.stringify({ wasm: artifact.wasm_sha256, runtime, protocol: REPLAY_PROTOCOL, supplier: ROI_SUPPLIER_TERMS, solar: 'published-pre-installation-v1' }))), b => b.toString(16).padStart(2, '0')).join('')}`;
export const PARTIAL_REFRESH_MS = 15 * 60_000;
const finite = z.number().finite(), count = finite.int().nonnegative();
const ledger = z.object({ importKwh: finite.nonnegative(), exportKwh: finite.nonnegative(), importCostSek: finite, exportRevenueSek: finite, costSek: finite }).strict();
const comparison = z.object({ gridKwh: finite.nonnegative(), solarKwh: finite.nonnegative(), exportKwh: finite.nonnegative(), costSek: finite }).strict();
export const monthLedgerSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), start: z.string().datetime(), end: z.string().datetime(), timeZone: z.string(),
  coverage: finite.positive().max(1), baseline: ledger, recorded: ledger,
  comparison: z.object({ baseline: comparison, actual: comparison, savingSek: finite }).strict(), gridImportCostSek: finite,
  priceArea: z.string(), reconstructedPriceQuarters: count, assumedPriceQuarters: count,
  recovery: z.object({ hours: count, balanceHours: count, deviceSumHours: count, invalidReadings: count, sources: z.array(z.string()).max(200) }).strict(),
  assumptions: z.object({ battery: z.boolean(), ev: z.boolean(), pool: z.boolean() }).strict(), quarters: count.positive(),
  gaps: z.object({ householdQuarters: count, solarQuarters: count, deviceReadings: count, gridImportQuarters: count, gridExportQuarters: count }).strict(),
  quality: z.object({ missingDevices: z.array(z.object({ key: z.string(), name: z.string(), quarters: count }).strict()).max(100), evSocQuarters: count,
    hourlyFields: z.array(z.object({ field: z.string(), quarters: count }).strict()).max(200) }).strict(),
}).strict();
const bill = z.object({ supplierFixedSek: finite, gridFixedSek: finite, gridPeakSek: finite, peakKw: finite.nonnegative(), totalSek: finite }).strict();
const service = z.object({ minimumPoolC: finite.nullable(), belowPoolStartHours: finite.nonnegative(), endBatteryKwh: finite.nullable(), endEvKwh: finite.nullable(), endPoolC: finite.nullable(), endCreditSek: finite }).strict();
const modeled = z.object({ baselineBill: bill, schedulerBill: bill, baselineService: service, schedulerService: service }).strict();
export const comparisonLedgerSchema = monthLedgerSchema.omit({ comparison: true, gridImportCostSek: true }).extend({ solar: z.object({ profileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), reconstructedKwh: finite.nonnegative(), reconstructedQuarters: count }).strict(), scheduler: ledger, modeled, replay: z.object({ engine: z.literal(REPLAY_ENGINE), protocol: z.literal(REPLAY_PROTOCOL), solves: count.positive() }).strict() }).strict();
const savedMonthSchema = z.object({ ledger: comparisonLedgerSchema, inputHash: z.string().regex(/^[a-f0-9]{64}$/), computedAt: z.string().datetime() }).strict();
const reportSchema = z.object({ generation: count.positive(), version: z.literal(CALCULATION_VERSION), model: z.record(z.unknown()),
  months: z.record(savedMonthSchema) }).strict();
export interface SavedMonth { ledger: MonthLedger; inputHash: string; computedAt: string }
export interface SavedReport { generation: number; version: string; model: HomeModelCapture; months: Record<string, SavedMonth> }
export interface MonthStore {
  read(ref: HomeRef, signal: AbortSignal): Promise<SavedReport | null>;
  pin(ref: HomeRef, model: HomeModelCapture, expectedGeneration: number | null, signal: AbortSignal): Promise<SavedReport>;
  save(ref: HomeRef, generation: number, ledger: MonthLedger, inputHash: string, expectedHash: string | null, signal: AbortSignal): Promise<SavedMonth>;
}

/** Persist physical equipment only, never forecasts, plans or chart series. */
export function compactModel(snapshot: HomeModelCapture): HomeModelCapture {
  const members = new Set(homePhysics(snapshot).memberKeys);
  const { roi_solar_profile, captured_at, timezone, capabilities, battery, ev_battery, pool, device_physics, pool_model, grid, value_settings, comfort, policy, criteria } = snapshot;
  return { roi_solar_profile, captured_at, timezone, capabilities, battery, ev_battery, pool, device_physics, pool_model, grid, value_settings, comfort, policy, criteria,
    device_models: snapshot.device_models.filter(m => members.has(m.key)).map(m => ({ ...m, forecast_w_by_slot: [] })),
    services: snapshot.services.filter(s => s.device === 'ev' && s.control.type === 'discrete_current').map(s => ({ device: s.device, control: s.control })) };
}
export function parseSavedReport(value: unknown): SavedReport {
  const parsed = reportSchema.parse(value), model = parsed.model as unknown as HomeModelCapture;
  homePhysics(model);
  if (model.roi_solar_profile !== null && !/^[a-f0-9]{64}$/.test(model.roi_solar_profile)) throw new Error('Invalid saved solar profile');
  if (Object.keys(model).some(key => !Object.keys(compactModel(model)).includes(key)) || model.device_models.some(m => m.forecast_w_by_slot.length)) throw new Error('Saved ROI model contains non-physical data');
  if (Object.keys(parsed.months).length > 12) throw new Error('Invalid saved ROI month count');
  const equal = (a: number, b: number) => Math.abs(a - b) <= 1e-7;
  for (const [month, saved] of Object.entries(parsed.months)) {
    const m = saved.ledger, start = Date.parse(m.start), end = Date.parse(m.end), bounds = homeMonthBounds(m.start, 0, model.timezone);
    if (m.solar.profileHash !== model.roi_solar_profile || m.solar.reconstructedQuarters > m.quarters || month !== m.month || month !== localDay(m.start, model.timezone).slice(0, 7) || m.timeZone !== model.timezone || start !== bounds.startMs || end <= start || end > bounds.endMs
      || m.quarters !== (end - start) / 900_000 || !equal(m.coverage, (end - start) / (bounds.endMs - start))
      || !equal(m.baseline.costSek, m.baseline.importCostSek - m.baseline.exportRevenueSek)
      || !equal(m.modeled.baselineBill.totalSek, m.baseline.costSek + m.modeled.baselineBill.supplierFixedSek + m.modeled.baselineBill.gridFixedSek + m.modeled.baselineBill.gridPeakSek)
      || !equal(m.modeled.schedulerBill.totalSek, m.scheduler.costSek + m.modeled.schedulerBill.supplierFixedSek + m.modeled.schedulerBill.gridFixedSek + m.modeled.schedulerBill.gridPeakSek)
      || !equal(m.scheduler.costSek, m.scheduler.importCostSek - m.scheduler.exportRevenueSek)
      || !equal(m.recorded.costSek, m.recorded.importCostSek - m.recorded.exportRevenueSek)) throw new Error('Invalid saved ROI month');
  }
  return { ...parsed, model } as SavedReport;
}
