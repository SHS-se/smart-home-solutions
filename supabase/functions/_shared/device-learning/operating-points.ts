/**
 * Measured operating points of variable-power equipment, one per combination
 * of the devices' own power settings: a heat pump's output, a pump's capacity,
 * a charger's current.
 *
 * `primary` devices do the work (a heat pump, a charger); `auxiliary` devices
 * run with them (a circulation pump). Both are keyed by their settings, since
 * one can change the other's efficiency: a slower pool pump moves less water
 * past the exchanger, so the heat pump delivers its heat warmer and its COP
 * falls while the pump itself draws less.
 *
 * Draw is learned per quarter: a quarter inside a run (running on both sides,
 * so no start or stop dilutes it) in which every setting held throughout
 * counts toward that combination, so equipment whose setting moves during a
 * run still gives evidence. Heat delivered per kWh needs a whole session at
 * one combination, because a heat meter may report its heat after the
 * electricity.
 *
 * Every point is recomputed from the stored quarters on each refit; nothing
 * here is persisted as a measurement of its own. Late or missing quarters are
 * never read as idle: a quarter next to one is not steady, and a session next
 * to one is left out of the COP and counted, so a later refit over the
 * complete quarters includes it.
 */

const SLOT_MS = 900_000;
const SLOT_HOURS = 0.25;
/** Primary electricity above this in a quarter is a running quarter (20 W mean). */
const RUNNING_KWH = 0.005;
/** A heat meter may report its heat after the electricity. Heat is counted
 * through this many quarters after a session, and sessions closer together
 * than this are one session. */
export const HEAT_TAIL_QUARTERS = 8;

export interface DeviceQuarter {
  start_ms: number;
  device_key: string;
  energy_kwh: number;
  power_setting: number | null;
  heat_kwh: number | null;
}

export interface OperatingPoint {
  /** The power setting each device with one held, by device key. */
  settings: Record<string, number>;
  /** Running quarters in which every setting was known, h. */
  running_hours: number;
  /** Quarters inside runs that the draw is measured over, h. */
  steady_hours: number;
  /** Mean draw by device while running steadily, W. */
  electric_w: Record<string, number>;
  /** Whole sessions at this combination whose heat was metered completely, and their totals. */
  heat_sessions: number;
  electric_kwh: number;
  heat_kwh: number | null;
  /** Heat delivered per kWh of primary electricity; derived, null without a heat meter. */
  cop: number | null;
  first_observed_at: string;
  last_observed_at: string;
}

export interface OperatingPoints {
  method: "operating_points_v1";
  from: string;
  to: string;
  points: OperatingPoint[];
  /** Heat sessions in which a setting changed or was not known. */
  unattributed_sessions: number;
  /** Heat sessions next to a quarter whose electricity is missing. */
  unbounded_sessions: number;
  /** Heat sessions whose quarters, or heat, are still arriving. */
  pending_sessions: number;
}

interface Totals {
  settings: Record<string, number>; running: number;
  steady: Map<string, { kwh: number; quarters: number }>; steady_quarters: number;
  heat_sessions: number; electric_kwh: number; heat_kwh: number;
  first: number; last: number;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function learnOperatingPoints(
  quarters: readonly DeviceQuarter[],
  primaryKeys: readonly string[],
  auxiliaryKeys: readonly string[],
  fromMs: number,
  toMs: number,
): OperatingPoints {
  const from = Math.ceil(fromMs / SLOT_MS) * SLOT_MS;
  const result: OperatingPoints = { method: "operating_points_v1",
    from: new Date(from).toISOString(), to: new Date(toMs).toISOString(), points: [],
    unattributed_sessions: 0, unbounded_sessions: 0, pending_sessions: 0 };
  if (!primaryKeys.length) return result;
  const primary = new Set(primaryKeys), members = [...new Set([...primaryKeys, ...auxiliaryKeys])];
  const memberSet = new Set(members);
  const byStart = new Map<number, Map<string, DeviceQuarter>>();
  const settingKeys = new Set<string>(), metered = new Set<string>();
  let last = -Infinity;
  for (const row of quarters) {
    if (!memberSet.has(row.device_key) || row.start_ms < from || row.start_ms + SLOT_MS > toMs ||
      row.start_ms % SLOT_MS !== 0 || !(row.energy_kwh >= 0)) continue;
    const quarter = byStart.get(row.start_ms) ?? new Map<string, DeviceQuarter>();
    quarter.set(row.device_key, row);
    byStart.set(row.start_ms, quarter);
    if (primary.has(row.device_key)) last = Math.max(last, row.start_ms);
    // The devices that report a setting at all; every one keys the combination.
    if (Number.isFinite(row.power_setting)) settingKeys.add(row.device_key);
    if (primary.has(row.device_key) && Number.isFinite(row.heat_kwh)) metered.add(row.device_key);
  }
  if (last === -Infinity) return result;
  const keyed = members.filter(key => settingKeys.has(key));
  const meteredHeat = primaryKeys.every(key => metered.has(key));

  /** Primary electricity in a quarter, or null when any primary device's quarter is missing. */
  const electricity = (at: number): number | null => {
    const quarter = byStart.get(at);
    if (!quarter) return null;
    let kwh = 0;
    for (const key of primaryKeys) {
      const row = quarter.get(key);
      if (!row) return null;
      kwh += row.energy_kwh;
    }
    return kwh;
  };
  const running = (at: number) => (electricity(at) ?? 0) > RUNNING_KWH;
  /** The combination held through a quarter, or null when any setting is unknown there. */
  const combination = (at: number): Record<string, number> | null => {
    const settings: Record<string, number> = {};
    for (const key of keyed) {
      const held = byStart.get(at)?.get(key)?.power_setting;
      if (!Number.isFinite(held)) return null;
      settings[key] = held!;
    }
    return settings;
  };
  const points = new Map<string, Totals>();
  const totals = (settings: Record<string, number>, at: number): Totals => {
    const id = JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
    const found = points.get(id) ?? { settings, running: 0, steady: new Map(), steady_quarters: 0,
      heat_sessions: 0, electric_kwh: 0, heat_kwh: 0, first: at, last: at };
    found.first = Math.min(found.first, at);
    found.last = Math.max(found.last, at);
    points.set(id, found);
    return found;
  };

  // Draw: every running quarter, steady where running on both sides.
  for (let at = from; at <= last; at += SLOT_MS) {
    if (!running(at)) continue;
    const settings = combination(at);
    if (!settings) continue;
    const point = totals(settings, at);
    point.running += 1;
    if (!running(at - SLOT_MS) || !running(at + SLOT_MS)) continue;
    point.steady_quarters += 1;
    for (const key of members) {
      const row = byStart.get(at)!.get(key);
      if (!row) continue;
      const steady = point.steady.get(key) ?? { kwh: 0, quarters: 0 };
      steady.kwh += row.energy_kwh; steady.quarters += 1;
      point.steady.set(key, steady);
    }
  }

  // Heat per kWh: whole sessions at one combination, with their heat tail.
  if (meteredHeat) {
    let at = from;
    while (at <= last) {
      if (!running(at)) { at += SLOT_MS; continue; }
      const runs: [number, number][] = [];
      let start = at, end = at;
      while (end + SLOT_MS <= last && running(end + SLOT_MS)) end += SLOT_MS;
      runs.push([start, end]);
      let state: "complete" | "unbounded" | "pending" = electricity(start - SLOT_MS) === null ? "unbounded" : "complete";
      let tailEnd = end + HEAT_TAIL_QUARTERS * SLOT_MS;
      for (let probe = end + SLOT_MS; probe <= tailEnd; probe += SLOT_MS) {
        if (probe > last) { if (state === "complete") state = "pending"; break; }
        const kwh = electricity(probe);
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
      if (state === "unbounded") { result.unbounded_sessions += 1; continue; }
      if (state === "pending") { result.pending_sessions += 1; continue; }

      const sessionStart = runs[0][0];
      const settings = combination(sessionStart);
      const id = settings && JSON.stringify(settings);
      const uniform = settings !== null && runs.every(([runStart, runEnd]) => {
        for (let q = runStart; q <= runEnd; q += SLOT_MS) {
          const held = combination(q);
          if (!held || JSON.stringify(held) !== id) return false;
        }
        return true;
      });
      if (!uniform) { result.unattributed_sessions += 1; continue; }
      let electric = 0, heat = 0, complete = true;
      for (let q = sessionStart; q <= tailEnd && complete; q += SLOT_MS) {
        for (const key of primaryKeys) {
          const row = byStart.get(q)!.get(key)!;
          if (!Number.isFinite(row.heat_kwh)) { complete = false; break; }
          electric += row.energy_kwh; heat += row.heat_kwh!;
        }
      }
      if (!complete || !(electric > 0)) continue;
      const point = totals(settings!, sessionStart);
      point.last = Math.max(point.last, tailEnd);
      point.heat_sessions += 1; point.electric_kwh += electric; point.heat_kwh += heat;
    }
  }

  result.points = [...points.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => ({
    settings: t.settings,
    running_hours: round(t.running * SLOT_HOURS, 2),
    steady_hours: round(t.steady_quarters * SLOT_HOURS, 2),
    electric_w: Object.fromEntries([...t.steady.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, s]) => [key, round(s.kwh / (s.quarters * SLOT_HOURS) * 1000, 1)])),
    heat_sessions: t.heat_sessions,
    electric_kwh: round(t.electric_kwh, 3),
    heat_kwh: t.heat_sessions ? round(t.heat_kwh, 3) : null,
    cop: t.heat_sessions && t.electric_kwh > 0 ? round(t.heat_kwh / t.electric_kwh, 3) : null,
    first_observed_at: new Date(t.first).toISOString(),
    last_observed_at: new Date(t.last + SLOT_MS).toISOString(),
  }));
  return result;
}
