import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { WATER_KWH_PER_M3_K } from "./planner/device-models.ts";
import { poolHeaters } from "./planner/pool-devices.ts";
import { poolDynamicsAnchor, poolPartialElectricity, poolResponseStateAt, type PoolDynamics, type PoolElectricalInterval } from "./pool-dynamics.ts";
import { readPagedRows } from "./read-paged-rows.ts";
const SLOT_MS = 900_000;

/** Parameter learning is daily; response memory is reconstructed on EVERY
 * capture from actual compressor energy. It is never reset just because the
 * heater stopped or a new forecast was prepared. */
export async function capturedPoolResponseState(
  supabase: SupabaseClient, homeId: string, snapshot: OptimisationSnapshot, model: PoolDynamics,
): Promise<PoolDynamics['state']> {
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
  console.info("[ENERGY-OPTIMISATION] pool response state", { home_id: homeId, observed_quarters: energy.size,
    missing_quarters: Math.max(0, expected - energy.size), ignored: ignored + partial.ignored,
    partial_quarter_source: partial.source, partial_quarter_complete: partial.complete });
  return poolResponseStateAt(model, snapshot.pool!.volume_m3 * WATER_KWH_PER_M3_K, history, at);
}

