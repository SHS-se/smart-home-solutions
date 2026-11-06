import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { WATER_KWH_PER_M3_K } from "./planner/device-models.ts";
import { poolHeaters } from "./planner/pool-devices.ts";
import { poolDynamicsAnchor, poolPartialElectricity, reconstructPoolResponse, type PoolElectricalInterval } from "./planner/models/pool/state.ts";
import { poolElectricalDemand } from "./planner/models/pool/electrical.ts";
import type { PoolDynamics } from "./planner/pool-response.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { readPagedRows } from "./read-paged-rows.ts";
const SLOT_MS = 900_000;
/** The home uploads on its own timer, so the newest completed quarters often
 * reach the database after a capture. Up to this many are a late upload. */
const LATE_UPLOAD_QUARTERS = 2;

/** Parameter learning is daily; response memory is reconstructed on EVERY
 * capture from actual compressor energy. It is never reset just because the
 * heater stopped or a new forecast was prepared. Electricity that is late or
 * missing is bounded by the reconstruction, never a reason to stop planning
 * the pool; the warning says how much was estimated. Rejects only when the
 * evidence cannot be read at all or no bounded state exists. */
export async function capturedPoolResponseState(
  supabase: SupabaseClient, homeId: string, snapshot: OptimisationSnapshot, model: PoolDynamics,
): Promise<{ state: PoolDynamics['state']; warnings: PlanningWarning[] }> {
  const keys = poolHeaters(snapshot.device_models).map(d => d.key);
  const { data: devices, error } = await supabase.from("energy_optimisation_devices")
    .select("id").eq("home_id", homeId).in("device_key", keys);
  if (error) throw new Error("Pool response energy devices could not be read");
  if (!keys.length || devices?.length !== keys.length) throw new Error("Pool response energy devices are incomplete");
  const at = Date.parse(snapshot.captured_at), boundary = Math.floor(at / SLOT_MS) * SLOT_MS;
  const anchor = poolDynamicsAnchor(model, at);
  const rows = devices?.length ? await readPagedRows<Record<string, unknown>>((from, to) => supabase.from("energy_optimisation_device_slots")
    .select("start_ts, energy_kwh").eq("home_id", homeId).in("device_id", devices.map((d: { id: string }) => d.id))
    .gte("start_ts", anchor.at).lt("start_ts", new Date(boundary).toISOString())
    .order("start_ts").order("device_id").range(from, to)) : [];
  const energy = new Map<number, number>(), counts = new Map<number, number>();
  let ignored = 0;
  for (const row of rows) {
    const start = Date.parse(String(row.start_ts)), kwh = Number(row.energy_kwh);
    if (row.energy_kwh == null || !Number.isFinite(start) || !Number.isFinite(kwh) || kwh < 0) { ignored++; continue; }
    energy.set(start, (energy.get(start) ?? 0) + kwh);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  for (const [start, count] of counts) if (count !== devices.length) energy.delete(start);
  const history: PoolElectricalInterval[] = [...energy].map(([start_ms, electrical_kwh]) => ({ start_ms, electrical_kwh, hours: .25 }));
  const partial = poolPartialElectricity(snapshot.pool!, keys, at);
  history.push(...partial.intervals);
  const expected = Math.max(0, Math.floor((boundary - Date.parse(anchor.at)) / SLOT_MS));
  const { state, unmetered } = reconstructPoolResponse(model, snapshot.pool!.volume_m3 * WATER_KWH_PER_M3_K, history, at,
    poolElectricalDemand(snapshot).compressor_w / 1000);
  // Late: the unseen time is the newest completed quarters. Anything older was
  // passed by the uploader and will not arrive by itself.
  const late = unmetered.every(span => span.end_ms >= boundary && span.start_ms >= boundary - LATE_UPLOAD_QUARTERS * SLOT_MS);
  console.info("[ENERGY-OPTIMISATION] pool response state", { home_id: homeId, observed_quarters: energy.size,
    missing_quarters: Math.max(0, expected - energy.size), ignored: ignored + partial.ignored,
    partial_quarter_source: partial.source, partial_quarter_complete: partial.complete,
    unmetered_minutes: Math.round(unmetered.reduce((sum, span) => sum + span.end_ms - span.start_ms, 0) / 60_000), late });
  if (!unmetered.length) return { state, warnings: [] };
  const evidence = { unmetered_spans: unmetered.length, first_unmetered: new Date(unmetered[0].start_ms).toISOString(),
    last_unmetered: new Date(unmetered.at(-1)!.end_ms).toISOString() };
  // A late upload heals by itself, so it is a routine note; a quarter the
  // uploader moved past is shown, because it stays until the next model update.
  return { state, warnings: [late
    ? planningWarning("pool_history_late", "pool", "The latest pool heater energy has not arrived yet.",
      "Pool planning assumes the least favourable heating state for that time until it does.", evidence)
    : planningWarning("pool_history_missing", "pool", "Some pool heater energy is missing.",
      "Pool planning assumes the least favourable heating state for that time, so heating may be allowed earlier than needed until the next daily model update.", evidence)] };
}
