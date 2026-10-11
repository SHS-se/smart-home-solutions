import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { homePhysics, type HomeModelCapture } from './home-physics';
import { prepareHomeBaseline, QUARTER_MS, type ActualRow, type DeviceRow, type DeviceSlot, type EvInitialRow, type OutdoorRow, type PoolRow, type PriceRow } from './model';
import { historyWindows, type BaselineAnchor, type BaselinePeriod } from './period';

export interface HomeRef { customerId: string; homeId: string }
const db = supabase as unknown as SupabaseClient;
const scoped = (ref: HomeRef, table: string) => db.from(table).select('*').eq('customer_id', ref.customerId).eq('home_id', ref.homeId);

async function read<T>(request: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Pin equipment models and the last recorded quarter once for this viewer session. */
export async function resolveBaselineAnchor(ref: HomeRef, signal: AbortSignal): Promise<BaselineAnchor> {
  const [snapshot, latest] = await Promise.all([
    read<HomeModelCapture | null>(scoped(ref, 'energy_optimisation_current').select('captured_at:snapshot->>captured_at,timezone:snapshot->>timezone,capabilities:snapshot->capabilities,battery:snapshot->battery,ev_battery:snapshot->ev_battery,pool:snapshot->pool,device_physics:snapshot->device_physics,pool_model:snapshot->pool_model,grid:snapshot->grid,value_settings:snapshot->value_settings,device_models:snapshot->device_models,services:snapshot->services')
      .abortSignal(signal).maybeSingle()),
    read<{ start_ts: string } | null>(scoped(ref, 'energy_optimisation_actual_slots').select('start_ts')
      .lt('start_ts', new Date(Math.floor(Date.now() / QUARTER_MS) * QUARTER_MS).toISOString())
      .order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()),
  ]);
  signal.throwIfAborted();
  if (!snapshot) throw new Error('Current home physical model is unavailable');
  if (!latest) throw new Error('No completed historical energy quarters are available for this home');
  homePhysics(snapshot);
  return { snapshot, latestEnd: new Date(Date.parse(latest.start_ts) + QUARTER_MS).toISOString() };
}

/** Read a complete explicit period without exceeding the existing RPC or REST limits. */
export async function loadHomeBaseline(ref: HomeRef, anchor: BaselineAnchor, period: BaselinePeriod, signal: AbortSignal) {
  const { snapshot } = anchor, { start, end } = period;
  const prior = new Date(Date.parse(start) - QUARTER_MS).toISOString();
  const facts = homePhysics(snapshot);
  const window = (table: string, fields: string, from: string, to: string, count: number) => scoped(ref, table)
    .select(fields).gte('start_ts', from).lt('start_ts', to).order('start_ts').limit(count).abortSignal(signal);
  const windows = historyWindows(period);
  const loadWindow = async (w: typeof windows[number], first: boolean) => {
    const [actual, prices, deviceSlots, outdoor] = await Promise.all([
      read<ActualRow[]>(window('energy_optimisation_actual_slots', 'start_ts,total_load_kwh,solar_production_kwh,battery_soc,ev_soc,grid_import_kwh,grid_export_kwh', first ? prior : w.start, w.end, w.count + (first ? 1 : 0))),
      read<PriceRow[]>(window('energy_optimisation_price_slots', 'start_ts,import_price_sek_per_kwh,export_price_sek_per_kwh', w.start, w.end, w.count)),
      read<DeviceSlot[]>(db.rpc('get_energy_optimisation_device_slots', {
        p_customer_id: ref.customerId, p_home_id: ref.homeId, p_from: w.start, p_to: w.end,
      }).order('start_ts').limit(w.count).abortSignal(signal)),
      facts.poolStore?.loss.kind === 'linear' && facts.poolStore.loss.surroundings_c === null
        ? read<OutdoorRow[]>(window('energy_optimisation_outdoor_slots', 'start_ts,temperature_c', w.start, w.end, w.count)) : Promise.resolve([]),
    ]);
    return { actual, prices, deviceSlots, outdoor };
  };
  const loadWindows = async () => {
    const batches: Awaited<ReturnType<typeof loadWindow>>[] = [];
    for (let i = 0; i < windows.length; i += 2) {
      signal.throwIfAborted();
      batches.push(...await Promise.all(windows.slice(i, i + 2).map((w, offset) => loadWindow(w, i + offset === 0))));
    }
    return batches;
  };
  const [batches, devices, pool, evInitial] = await Promise.all([
    loadWindows(),
    facts.memberKeys.length ? read<DeviceRow[]>(scoped(ref, 'energy_optimisation_devices').select('id,device_key')
      .in('device_key', facts.memberKeys).abortSignal(signal)) : Promise.resolve([]),
    facts.poolStore ? read<PoolRow[]>(window('energy_optimisation_pool_slots', 'start_ts,water_temperature_c', prior, start, 1)) : Promise.resolve([]),
    facts.car ? read<EvInitialRow | null>(scoped(ref, 'energy_optimisation_actual_slots').select('start_ts,ev_soc')
      .lte('start_ts', prior).not('ev_soc', 'is', null).order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()) : Promise.resolve(null),
  ]);
  signal.throwIfAborted();
  return prepareHomeBaseline({ snapshot, start, end, devices, pool, evInitial,
    actual: batches.flatMap(b => b.actual), prices: batches.flatMap(b => b.prices),
    deviceSlots: batches.flatMap(b => b.deviceSlots), outdoor: batches.flatMap(b => b.outdoor) });
}
