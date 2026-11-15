/** Pool ON electricity, independent of fitted thermal response and recovered heat.
 *
 * Two quantities, never one figure doing both jobs:
 *
 * - the **expected draw**, what the equipment is measured to draw while it
 *   runs at its present power settings. It is the electricity a plan forecasts
 *   and the electricity its temperature projection turns into heat;
 * - the **reservation**, the most an ON command may draw, which electrical
 *   admission must fit under the import limit. The home supplies it as each
 *   device's `active_power_w`: the greatest draw it has recorded, the same
 *   retained bound its own executor admits against.
 *
 * The expected draw is the daily learner's operating point for the settings
 * the home reports. Without one, the reservation stands in for it, as it did
 * before operating points were learned, and the plan says so.
 */
import type { OptimisationSnapshot } from "../../planning-contracts.ts";
import { operatingPoint } from "../../device-models.ts";
import { deviceMembers, allocateDevicePower } from "../../device-power-allocation.ts";
import { poolHeaters } from "../../pool-devices.ts";
// Thermal dynamics, water state and comfort intent are deliberately absent.
type PoolElectricalInput = Pick<OptimisationSnapshot, "device_models" | "device_physics"> & {
  pool_model?: { operating_draw?: PoolOperatingDraw | null } | null;
};
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The measured operating point a pool's equipment is running at. */
export interface PoolOperatingDraw {
  /** Mean draw of each pool device while running steadily at `settings`, W. */
  member_w: Record<string, number>;
  /** The power setting each device with one held while that was measured. */
  settings: Record<string, number>;
  /** Hours of steady running the draw is measured over. */
  steady_hours: number;
  last_observed_at: string;
  /** `reported_settings`: the point for the settings the home read at capture.
   * `last_observed`: a setting could not be read, so the point most recently
   * observed stands for it. */
  basis: "reported_settings" | "last_observed";
}

type Member = { key: string; power_setting?: { value: number | null } | null };

/** Choose the learned operating point for the settings the home reports.
 *
 * `learned` is the pool learner's stored `operating_points`, read as untrusted
 * JSON: anything malformed yields no point, never a throw. Each device says
 * what its own power setting holds now: `null` for a device with none, a value,
 * or a `null` value when it cannot be read at the moment. A home that says
 * nothing about a device's setting (an app from before settings were reported)
 * gets no point: quarters learned before settings were recorded are keyed by
 * none, and may mix every setting the equipment has run at.
 *
 * A point is used only when it is keyed by exactly the devices that have a
 * setting and agrees with every value that could be read. No point for the
 * present settings means they have not been observed running yet; the next
 * refit after they have supplies one.
 */
export function resolvePoolOperatingDraw(learned: unknown, members: readonly Member[], heaterKeys: readonly string[]): PoolOperatingDraw | null {
  if (!record(learned) || learned.method !== "operating_points_v1" || !Array.isArray(learned.points)) return null;
  if (!members.length || members.some(member => member.power_setting === undefined)) return null;
  const keyed = new Set(members.filter(member => member.power_setting !== null).map(member => member.key));
  let best: PoolOperatingDraw | null = null;
  for (const point of learned.points) {
    if (!record(point) || !record(point.settings) || !record(point.electric_w) || !positive(point.steady_hours)) continue;
    const settings = point.settings, electric = point.electric_w, observed = Date.parse(String(point.last_observed_at));
    if (!Number.isFinite(observed)) continue;
    const keys = Object.keys(settings);
    if (keys.length !== keyed.size || keys.some(key => !keyed.has(key) || typeof settings[key] !== "number" || !Number.isFinite(settings[key]))) continue;
    let assumed = false, agrees = true;
    for (const member of members) {
      const value = member.power_setting?.value;
      if (member.power_setting === null || member.power_setting === undefined) continue;
      if (value === null) assumed = true;
      else if (settings[member.key] !== value) { agrees = false; break; }
    }
    if (!agrees || heaterKeys.some(key => !positive(electric[key]))) continue;
    const draw: PoolOperatingDraw = {
      member_w: Object.fromEntries(members.flatMap(member => positive(electric[member.key]) ? [[member.key, electric[member.key] as number]] : [])),
      settings: settings as Record<string, number>, steady_hours: point.steady_hours,
      last_observed_at: new Date(observed).toISOString(), basis: assumed ? "last_observed" : "reported_settings" };
    // Every setting read: at most one point agrees. One unread: the newest.
    if (!best || Date.parse(best.last_observed_at) < observed) best = draw;
  }
  return best;
}

interface PoolElectricalDraw { compressor_w: number; auxiliary_w: number; member_w: Record<string, number> }

function pool(snapshot: PoolElectricalInput) {
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const keys = new Set(poolHeaters(members).map(m => m.key));
  return { heaters: members.filter(m => keys.has(m.key)), others: members.filter(m => !keys.has(m.key)) };
}

/** Expected ON electricity: a measured operating point, else the supported ON
 * draw. A device fact, never a historical duty average or a thermal fit. */
export function poolElectricalDemand(snapshot: PoolElectricalInput): PoolElectricalDraw {
  const { heaters, others } = pool(snapshot);
  const supplied = snapshot.device_physics?.pool?.heater;
  const measured = supplied ? undefined : snapshot.pool_model?.operating_draw?.member_w;
  // A device without a measured draw is expected at its own bound.
  const expected = (m: { key: string; active_power_w: number | null }) =>
    positive(measured?.[m.key]) ? measured[m.key] : m.active_power_w ?? 0;
  const compressor = supplied ? operatingPoint(supplied, supplied.selected_setting).electric_w : sum(heaters.map(expected));
  const auxiliary = supplied?.auxiliary_w ?? sum(others.map(expected));
  const member_w: Record<string, number> = {};
  const allocate = (group: typeof heaters, total: number) => {
    if (measured && group.every(m => positive(measured[m.key]))) for (const m of group) member_w[m.key] = expected(m);
    else allocateDevicePower(deviceMembers(group, total), total, member_w);
  };
  allocate(heaters, compressor);
  allocate(others, auxiliary);
  return { compressor_w: compressor, auxiliary_w: auxiliary, member_w };
}

/** The most an ON command may draw, which electrical admission reserves.
 * Supplied equipment physics state their own operating point; otherwise the
 * home's retained bound per device. Never below the expected draw. */
export function poolElectricalReservation(snapshot: PoolElectricalInput): { compressor_w: number; auxiliary_w: number } {
  const expected = poolElectricalDemand(snapshot);
  if (snapshot.device_physics?.pool?.heater) return { compressor_w: expected.compressor_w, auxiliary_w: expected.auxiliary_w };
  const { heaters, others } = pool(snapshot);
  return { compressor_w: Math.max(expected.compressor_w, sum(heaters.map(m => m.active_power_w ?? 0))),
    auxiliary_w: Math.max(expected.auxiliary_w, sum(others.map(m => m.active_power_w ?? 0))) };
}

/** The most a pool heater can draw on average at any supported setting, the
 * upper bound on electricity during time it was not metered. Not the selected
 * setting: the unmetered time may have run at another one. */
export function poolElectricalCeilingW(snapshot: PoolElectricalInput): number {
  const supplied = snapshot.device_physics?.pool?.heater;
  if (supplied) return Math.max(...supplied.operating_points.map(point => point.electric_w));
  return poolElectricalReservation(snapshot).compressor_w;
}
