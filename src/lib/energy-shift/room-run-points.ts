import { z } from 'zod';
import { heatingBand } from '../../../supabase/functions/_shared/planner/heating-bands';

/** Display reading of the stored run ledgers; fitting stays in the learner. */
const num = z.number().finite();
const cooldown = z.object({ hours: num, c_per_h: num, room_c: num, outdoor_c: num, house_c: num.nullable(),
  residual_c_per_h: num.nullable().optional() });
const run = z.object({
  id: z.string(),
  from_ms: num,
  to_ms: num,
  measured_wh: num,
  transitions: z.number().int().nonnegative(),
  gain: num.nullable(),
  gain_se: num.nullable(),
  change_at_ms: num.nullable(),
  change_size: num.nullable(),
  change_phase: z.enum(['heating', 'cooldown']).nullable(),
  disposition: z.enum(['assessed', 'fitted', 'provisional', 'older_response', 'suspect_change', 'uninformative']),
  on_from_ms: num.optional(),
  off_from_ms: num.optional(),
  outdoor_c: num.nullable().optional(),
  house_c: num.nullable().optional(),
  room_start_c: num.nullable().optional(),
  room_peak_c: num.nullable().optional(),
  room_end_c: num.nullable().optional(),
  cooldown: cooldown.nullable().optional(),
}).passthrough();
const ledger = z.object({
  scope_key: z.string(),
  created_at: z.string(),
  evidence: z.object({ runs: z.array(z.unknown()) }).passthrough().nullable(),
});
export const roomRunLedgers = z.array(z.unknown());

export type RoomRunDisposition = z.infer<typeof run>['disposition'];
export interface RoomRunPoint {
  id: string;
  /** "general", or the lower edge of the 5 °C band whose response it was assessed against. */
  scope: string;
  fromMs: number;
  toMs: number;
  onMs: number | null;
  offMs: number | null;
  energyKwh: number;
  transitions: number;
  /** °C per kWh delivered, with losses modelled separately. */
  gain: number | null;
  gainSe: number | null;
  disposition: RoomRunDisposition;
  change: { atMs: number; size: number; phase: 'heating' | 'cooldown' } | null;
  outdoorC: number | null;
  houseC: number | null;
  roomStartC: number | null;
  roomPeakC: number | null;
  roomEndC: number | null;
  cooldown: z.infer<typeof cooldown> | null;
}

/** Runs whose gain is credible enough to shape the trend. */
export const trendRun = (point: RoomRunPoint) =>
  (point.disposition === 'assessed' || point.disposition === 'fitted' || point.disposition === 'provisional') &&
  point.gain !== null && point.gainSe !== null && point.gainSe > 0 && point.outdoorC !== null;

/** A run with an unexplained mid-run heat change cannot speak for its cooldown either. */
export const trendCooldown = (point: RoomRunPoint) => point.cooldown !== null && point.disposition !== 'suspect_change';

function runPoint(value: z.infer<typeof run>, scope: string): RoomRunPoint {
  return {
    id: value.id, scope, fromMs: value.from_ms, toMs: value.to_ms,
    onMs: value.on_from_ms ?? null, offMs: value.off_from_ms ?? null,
    energyKwh: value.measured_wh / 1000, transitions: value.transitions,
    gain: value.gain === null ? null : value.gain * 1000,
    gainSe: value.gain_se === null ? null : value.gain_se * 1000,
    disposition: value.disposition,
    change: value.change_at_ms !== null && value.change_size !== null && value.change_phase !== null
      ? { atMs: value.change_at_ms, size: value.change_size, phase: value.change_phase } : null,
    outdoorC: value.outdoor_c ?? null, houseC: value.house_c ?? null,
    roomStartC: value.room_start_c ?? null, roomPeakC: value.room_peak_c ?? null, roomEndC: value.room_end_c ?? null,
    cooldown: value.cooldown ?? null,
  };
}

export const ROOM_RUN_PAGE_SIZE = 50;

const assessedRun = run.extend({ disposition: z.enum(['assessed', 'suspect_change', 'uninformative']) });

/** Revision-scoped pages have unique run identities and the exact advertised row count. */
export function readRoomAssessmentPage(raw: unknown, count: number): RoomRunPoint[] | null {
  const result = z.array(assessedRun).length(count).safeParse(raw);
  if (!result.success || new Set(result.data.map(value => value.id)).size !== count) return null;
  return result.data.map(value => runPoint(value, 'shared'));
}

/**
 * One point per heating run. A run appears in every scope whose window it
 * touched; keep the assessment against the band it actually sat in, then any
 * band, then the general response. Unreadable entries are skipped, not fatal.
 */
export function roomRunPoints(data: unknown): { points: RoomRunPoint[]; skipped: number } {
  const ledgers = roomRunLedgers.safeParse(data);
  if (!ledgers.success) return { points: [], skipped: 0 };
  let skipped = 0;
  const byId = new Map<string, { point: RoomRunPoint; rank: number }>();
  for (const raw of ledgers.data) {
    const parsed = ledger.safeParse(raw);
    if (!parsed.success || !parsed.data.evidence) { skipped++; continue; }
    for (const entry of parsed.data.evidence.runs) {
      const r = run.safeParse(entry);
      if (!r.success) { skipped++; continue; }
      const value = r.data, scope = parsed.data.scope_key;
      const point = runPoint(value, scope);
      const rank = scope === 'general' ? 0
        : point.outdoorC !== null && String(heatingBand(point.outdoorC)) === scope ? 2 : 1;
      const existing = byId.get(point.id);
      if (!existing || rank > existing.rank) byId.set(point.id, { point, rank });
    }
  }
  const points = [...byId.values()].map(entry => entry.point).sort((a, b) => a.fromMs - b.fromMs);
  return { points, skipped };
}
