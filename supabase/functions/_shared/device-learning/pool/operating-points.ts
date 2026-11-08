/**
 * Measured pool operating points, one per combination of the devices' own
 * power settings (a heat pump's output, a pump's capacity).
 *
 * The heater's efficiency depends on both: a slower pump moves less water past
 * the exchanger, so the heat pump delivers its heat warmer and its COP falls,
 * while the pump itself draws less. A point records what was measured while
 * one combination held: each device's steady draw, and the heat delivered per
 * kWh of heater electricity where the heater has a heat meter.
 *
 * Every point is recomputed from the stored quarters on each refit; nothing
 * here is persisted as a measurement of its own. A session is used only where
 * its evidence is complete. Late or missing quarters leave that session out of
 * this refit and are counted, never read as idle: a later refit over the
 * complete quarters includes it. A session that saw a setting change, or a
 * setting that was not known, belongs to no point.
 */

const SLOT_MS = 900_000;
const SLOT_HOURS = 0.25;
/** Heater electricity above this in a quarter is a running quarter (80 W mean). */
const RUNNING_KWH = 0.02;
/** A heat meter may report its heat after the electricity. Heat is counted
 * through this many quarters after a session, and sessions closer together
 * than this are one session. */
export const HEAT_TAIL_QUARTERS = 8;

export interface PoolDeviceQuarter {
  start_ms: number;
  device_key: string;
  energy_kwh: number;
  power_setting: number | null;
  heat_kwh: number | null;
}

export interface PoolOperatingPoint {
  /** The power setting each device with one held throughout, by device key. */
  settings: Record<string, number>;
  sessions: number;
  running_hours: number;
  /** Mean draw by device while running steadily (whole quarters inside a run), W. */
  electric_w: Record<string, number>;
  /** Sessions whose heat was metered completely, and their totals. */
  heat_sessions: number;
  heater_kwh: number;
  heat_kwh: number | null;
  /** Heat delivered per kWh of heater electricity; derived, null without a heat meter. */
  cop: number | null;
  first_observed_at: string;
  last_observed_at: string;
}

export interface PoolOperatingPoints {
  method: "pool_operating_points_v1";
  from: string;
  to: string;
  points: PoolOperatingPoint[];
  /** Sessions in which a setting changed or was not known. */
  unattributed_sessions: number;
  /** Runs next to a quarter whose electricity is missing. */
  unbounded_runs: number;
  /** Sessions whose quarters, or heat, are still arriving. */
  pending_sessions: number;
}

interface Totals {
  settings: Record<string, number>; sessions: number; running_quarters: number;
  steady: Map<string, { kwh: number; quarters: number }>;
  heat_sessions: number; heater_kwh: number; heat_kwh: number;
  first: number; last: number;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function learnPoolOperatingPoints(
  quarters: readonly PoolDeviceQuarter[],
  heaterKeys: readonly string[],
  auxiliaryKeys: readonly string[],
  fromMs: number,
  toMs: number,
): PoolOperatingPoints {
  const from = Math.ceil(fromMs / SLOT_MS) * SLOT_MS;
  const result: PoolOperatingPoints = { method: "pool_operating_points_v1",
    from: new Date(from).toISOString(), to: new Date(toMs).toISOString(), points: [],
    unattributed_sessions: 0, unbounded_runs: 0, pending_sessions: 0 };
  if (!heaterKeys.length) return result;
  const heaters = new Set(heaterKeys), members = [...new Set([...heaterKeys, ...auxiliaryKeys])];
  const byStart = new Map<number, Map<string, PoolDeviceQuarter>>();
  let last = -Infinity;
  for (const row of quarters) {
    if (!members.includes(row.device_key) || row.start_ms < from || row.start_ms + SLOT_MS > toMs ||
      row.start_ms % SLOT_MS !== 0 || !(row.energy_kwh >= 0)) continue;
    const quarter = byStart.get(row.start_ms) ?? new Map<string, PoolDeviceQuarter>();
    quarter.set(row.device_key, row);
    byStart.set(row.start_ms, quarter);
    if (heaters.has(row.device_key)) last = Math.max(last, row.start_ms);
  }
  if (last === -Infinity) return result;
  // The devices that report a setting at all; each must hold one value throughout a session.
  const settingKeys = members.filter(key => quarters.some(row =>
    row.device_key === key && row.start_ms >= from && Number.isFinite(row.power_setting)));
  const heated = new Set(heaterKeys.filter(key => quarters.some(row =>
    row.device_key === key && row.start_ms >= from && Number.isFinite(row.heat_kwh))));

  /** Heater electricity in a quarter, or null when any heater's quarter is missing. */
  const heater = (at: number): number | null => {
    const quarter = byStart.get(at);
    if (!quarter) return null;
    let kwh = 0;
    for (const key of heaterKeys) {
      const row = quarter.get(key);
      if (!row) return null;
      kwh += row.energy_kwh;
    }
    return kwh;
  };
  const running = (at: number) => (heater(at) ?? 0) > RUNNING_KWH;

  const points = new Map<string, Totals>();
  let at = from;
  while (at <= last) {
    if (!running(at)) { at += SLOT_MS; continue; }
    // One session: runs whose idle gaps are shorter than the heat tail.
    const runs: [number, number][] = [];
    let start = at, end = at;
    while (end + SLOT_MS <= last && running(end + SLOT_MS)) end += SLOT_MS;
    runs.push([start, end]);
    let state: "complete" | "unbounded" | "pending" = heater(start - SLOT_MS) === null ? "unbounded" : "complete";
    let tailEnd = end + HEAT_TAIL_QUARTERS * SLOT_MS;
    for (let probe = end + SLOT_MS; probe <= tailEnd; probe += SLOT_MS) {
      if (probe > last) { if (state === "complete") state = "pending"; break; }
      const kwh = heater(probe);
      if (kwh === null) { state = "unbounded"; break; }
      if (kwh > RUNNING_KWH) {
        start = probe; end = probe;
        while (end + SLOT_MS <= last && running(end + SLOT_MS)) end += SLOT_MS;
        runs.push([start, end]);
        tailEnd = end + HEAT_TAIL_QUARTERS * SLOT_MS;
        probe = end;
      }
    }
    // An incomplete session's tail may hold the next run, so scanning resumes after its last run.
    at = (state === "complete" ? tailEnd : end) + SLOT_MS;
    if (state === "unbounded") { result.unbounded_runs += runs.length; continue; }
    if (state === "pending") { result.pending_sessions += 1; continue; }

    const sessionStart = runs[0][0];
    const settings: Record<string, number> = {};
    let attributed = true;
    for (const key of settingKeys) {
      let value: number | null = null;
      for (const [runStart, runEnd] of runs) {
        for (let q = runStart; q <= runEnd && attributed; q += SLOT_MS) {
          const held = byStart.get(q)?.get(key)?.power_setting;
          if (!Number.isFinite(held) || (value !== null && held !== value)) attributed = false;
          else value = held!;
        }
      }
      if (!attributed) break;
      settings[key] = value!;
    }
    if (!attributed) { result.unattributed_sessions += 1; continue; }

    const id = JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
    const totals = points.get(id) ?? { settings, sessions: 0, running_quarters: 0, steady: new Map(),
      heat_sessions: 0, heater_kwh: 0, heat_kwh: 0, first: sessionStart, last: sessionStart };
    totals.sessions += 1;
    totals.first = Math.min(totals.first, sessionStart);
    totals.last = Math.max(totals.last, tailEnd);
    for (const [runStart, runEnd] of runs) {
      totals.running_quarters += (runEnd - runStart) / SLOT_MS + 1;
      // Steady draw: quarters with running on both sides, so no start or stop dilutes them.
      for (let q = runStart + SLOT_MS; q < runEnd; q += SLOT_MS) {
        for (const key of members) {
          const row = byStart.get(q)?.get(key);
          if (!row) continue;
          const steady = totals.steady.get(key) ?? { kwh: 0, quarters: 0 };
          steady.kwh += row.energy_kwh; steady.quarters += 1;
          totals.steady.set(key, steady);
        }
      }
    }
    if (heated.size === heaterKeys.length) {
      let electric = 0, heat = 0, complete = true;
      for (let q = sessionStart; q <= tailEnd && complete; q += SLOT_MS) {
        for (const key of heaterKeys) {
          const row = byStart.get(q)!.get(key)!;
          if (!Number.isFinite(row.heat_kwh)) { complete = false; break; }
          electric += row.energy_kwh; heat += row.heat_kwh!;
        }
      }
      if (complete && electric > 0) {
        totals.heat_sessions += 1; totals.heater_kwh += electric; totals.heat_kwh += heat;
      }
    }
    points.set(id, totals);
  }

  result.points = [...points.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => ({
    settings: t.settings,
    sessions: t.sessions,
    running_hours: round(t.running_quarters * SLOT_HOURS, 2),
    electric_w: Object.fromEntries([...t.steady.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, s]) => [key, round(s.kwh / (s.quarters * SLOT_HOURS) * 1000, 1)])),
    heat_sessions: t.heat_sessions,
    heater_kwh: round(t.heater_kwh, 3),
    heat_kwh: t.heat_sessions ? round(t.heat_kwh, 3) : null,
    cop: t.heat_sessions && t.heater_kwh > 0 ? round(t.heat_kwh / t.heater_kwh, 3) : null,
    first_observed_at: new Date(t.first).toISOString(),
    last_observed_at: new Date(t.last + SLOT_MS).toISOString(),
  }));
  return result;
}
