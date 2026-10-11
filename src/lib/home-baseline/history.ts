import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { homePhysics, type HomeModelCapture } from './home-physics';
import { BaselineGenerationError, frameStart, prepareHomeBaseline, QUARTER_MS, type ActualRow, type DeviceRow, type DeviceSlot, type EvInitialRow, type OutdoorRow, type PoolRow, type PriceRow } from './model';

export interface HomeRef { customerId: string; homeId: string }
const db = supabase as unknown as SupabaseClient;

async function read<T>(request: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return data as T;
}

/** All reads are scoped to one home and one frame. No history scans, fitting or writes. */
export async function loadHomeBaselineFrame(ref: HomeRef, end: string | null, signal: AbortSignal) {
  const scoped = (table: string) => db.from(table).select('*').eq('customer_id', ref.customerId).eq('home_id', ref.homeId);
  const [snapshot, latest] = await Promise.all([
    read<HomeModelCapture | null>(db.from('energy_optimisation_current').select('captured_at:snapshot->>captured_at,timezone:snapshot->>timezone,capabilities:snapshot->capabilities,battery:snapshot->battery,ev_battery:snapshot->ev_battery,pool:snapshot->pool,device_physics:snapshot->device_physics,pool_model:snapshot->pool_model,grid:snapshot->grid,value_settings:snapshot->value_settings,device_models:snapshot->device_models,services:snapshot->services')
      .eq('customer_id', ref.customerId).eq('home_id', ref.homeId).abortSignal(signal).maybeSingle()),
    end ? Promise.resolve(null) : read<{ start_ts: string } | null>(scoped('energy_optimisation_actual_slots')
      .select('start_ts').lt('start_ts', new Date(Math.floor(Date.now() / QUARTER_MS) * QUARTER_MS).toISOString())
      .order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()),
  ]);
  if (!snapshot) throw new Error('Current home physical model is unavailable');
  if (!end && !latest) throw new Error('No completed historical energy quarters are available for this home');
  const selectedEnd = end ?? new Date(Date.parse(latest!.start_ts) + QUARTER_MS).toISOString();
  if (Date.parse(selectedEnd) > Math.floor(Date.now() / QUARTER_MS) * QUARTER_MS) throw new Error('Select a completed historical frame');
  const start = frameStart(selectedEnd), prior = new Date(Date.parse(start) - QUARTER_MS).toISOString();
  const facts = homePhysics(snapshot);
  const window = (table: string, fields: string, from = start, to = selectedEnd, count = 288) => scoped(table)
    .select(fields).gte('start_ts', from).lt('start_ts', to).order('start_ts').limit(count).abortSignal(signal);
  try {
    const [actual, prices, devices, deviceSlots, pool, outdoor, evInitial] = await Promise.all([
      read<ActualRow[]>(window('energy_optimisation_actual_slots', 'start_ts,total_load_kwh,solar_production_kwh,battery_soc,ev_soc', prior, selectedEnd, 289)),
      read<PriceRow[]>(window('energy_optimisation_price_slots', 'start_ts,import_price_sek_per_kwh,export_price_sek_per_kwh')),
      facts.memberKeys.length ? read<DeviceRow[]>(scoped('energy_optimisation_devices').select('id,device_key')
        .in('device_key', facts.memberKeys).abortSignal(signal)) : Promise.resolve([]),
      facts.memberKeys.length ? read<DeviceSlot[]>(db.rpc('get_energy_optimisation_device_slots', {
        p_customer_id: ref.customerId, p_home_id: ref.homeId, p_from: start, p_to: selectedEnd,
      }).abortSignal(signal)) : Promise.resolve([]),
      facts.poolStore ? read<PoolRow[]>(window('energy_optimisation_pool_slots', 'start_ts,water_temperature_c', prior, start, 1)) : Promise.resolve([]),
      facts.poolStore?.loss.kind === 'linear' && facts.poolStore.loss.surroundings_c === null
        ? read<OutdoorRow[]>(window('energy_optimisation_outdoor_slots', 'start_ts,temperature_c')) : Promise.resolve([]),
      facts.car ? read<EvInitialRow | null>(scoped('energy_optimisation_actual_slots').select('start_ts,ev_soc')
        .lte('start_ts', prior).not('ev_soc', 'is', null).order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()) : Promise.resolve(null),
    ]);
    signal.throwIfAborted();
    return prepareHomeBaseline({ snapshot, end: selectedEnd, actual, prices, devices, deviceSlots, pool, outdoor, evInitial });
  } catch (error) { throw new BaselineGenerationError(error instanceof Error ? error.message : String(error), selectedEnd); }
}
