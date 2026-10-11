import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { homePhysics, type HomeModelCapture } from './home-physics';
import { prepareHomeBaseline, QUARTER_MS, type ActualRow, type DeviceRow, type DeviceSlot, type EvInitialRow, type OutdoorRow, type PoolRow, type PriceRow } from './model';
import { historyWindows, type BaselineAnchor, type BaselinePeriod } from './period';
import { mergeHourlyHistory, type RecoveredHour } from './recovered-history';
import { ROI_SUPPLIER_TERMS } from '../../../supabase/functions/_shared/roi-supplier-terms';

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
  const [snapshot, criteria, latest, first, recoveredFirst, recoveredLast] = await Promise.all([
    read<HomeModelCapture | null>(scoped(ref, 'energy_optimisation_current').select('comfort:snapshot->comfort,policy:snapshot->policy,captured_at:snapshot->>captured_at,timezone:snapshot->>timezone,capabilities:snapshot->capabilities,battery:snapshot->battery,ev_battery:snapshot->ev_battery,pool:snapshot->pool,device_physics:snapshot->device_physics,pool_model:snapshot->pool_model,grid:snapshot->grid,value_settings:snapshot->value_settings,device_models:snapshot->device_models,services:snapshot->services')
      .abortSignal(signal).maybeSingle()),
    read<import('../../../supabase/functions/_shared/planner-wasm/rule-policy').CriteriaOverrides>(db.rpc('get_energy_roi_criteria', { p_customer_id: ref.customerId, p_home_id: ref.homeId }).abortSignal(signal)),
    read<{ start_ts: string } | null>(scoped(ref, 'energy_optimisation_actual_slots').select('start_ts')
      .lt('start_ts', new Date(Math.floor(Date.now() / QUARTER_MS) * QUARTER_MS).toISOString())
      .order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()),
    read<{ start_ts: string } | null>(scoped(ref, 'energy_optimisation_actual_slots').select('start_ts').order('start_ts').limit(1).abortSignal(signal).maybeSingle()),
    read<{ start_ts: string } | null>(scoped(ref, 'energy_roi_history_hours').select('start_ts').order('start_ts').limit(1).abortSignal(signal).maybeSingle()),
    read<{ start_ts: string } | null>(scoped(ref, 'energy_roi_history_hours').select('start_ts').lt('start_ts', new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString())
      .order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()),
  ]);
  signal.throwIfAborted();
  if (!snapshot) throw new Error('Current home physical model is unavailable');
  if ((!latest || !first) && (!recoveredFirst || !recoveredLast)) throw new Error('No completed historical energy readings are available for this home');
  homePhysics(snapshot);
  return { snapshot: { ...snapshot, criteria }, earliestStart: new Date(Math.min(...[first, recoveredFirst].flatMap(r => r ? [Date.parse(r.start_ts)] : []))).toISOString(),
    latestEnd: new Date(Math.max(...[latest ? Date.parse(latest.start_ts) + QUARTER_MS : null, recoveredLast ? Date.parse(recoveredLast.start_ts) + 3_600_000 : null].filter((t): t is number => t !== null))).toISOString() };
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
    const [actual, deviceSlots, outdoor, pool, recovered] = await Promise.all([
      read<ActualRow[]>(window('energy_optimisation_actual_slots', 'start_ts,total_load_kwh,solar_production_kwh,battery_soc,ev_soc,grid_import_kwh,grid_export_kwh,battery_charge_kwh,battery_discharge_kwh', first ? prior : w.start, w.end, w.count + (first ? 1 : 0))),
      read<DeviceSlot[]>(db.rpc('get_energy_optimisation_device_slots', {
        p_customer_id: ref.customerId, p_home_id: ref.homeId, p_from: w.start, p_to: w.end,
      }).order('start_ts').limit(w.count).abortSignal(signal)),
      facts.poolStore?.loss.kind === 'linear' && facts.poolStore.loss.surroundings_c === null
        ? read<OutdoorRow[]>(window('energy_optimisation_outdoor_slots', 'start_ts,temperature_c', w.start, w.end, w.count)) : Promise.resolve([]),
      facts.poolStore ? read<PoolRow[]>(window('energy_optimisation_pool_slots', 'start_ts,water_temperature_c', w.start, w.end, w.count)) : Promise.resolve([]),
      read<RecoveredHour[]>(window('energy_roi_history_hours', 'start_ts,actual,device_energy_kwh,pool_c,outdoor_c,baseline_load_kwh,sources,invalid_readings',
        new Date(Math.floor(Date.parse(first ? prior : w.start) / 3_600_000) * 3_600_000).toISOString(), w.end, 170)),
    ]);
    return { actual, deviceSlots, outdoor, pool, recovered };
  };
  const loadWindows = async () => {
    const batches: Awaited<ReturnType<typeof loadWindow>>[] = [];
    for (let i = 0; i < windows.length; i += 2) {
      signal.throwIfAborted();
      batches.push(...await Promise.all(windows.slice(i, i + 2).map((w, offset) => loadWindow(w, i + offset === 0))));
    }
    return batches;
  };
  const [batches, devices, pool, evInitial, pricing] = await Promise.all([
    loadWindows(),
    read<DeviceRow[]>(scoped(ref, 'energy_optimisation_devices').select('id,device_key,name,category')
      .abortSignal(signal)),
    facts.poolStore ? read<PoolRow[]>(window('energy_optimisation_pool_slots', 'start_ts,water_temperature_c', prior, start, 1)) : Promise.resolve([]),
    facts.car ? read<EvInitialRow | null>(scoped(ref, 'energy_optimisation_actual_slots').select('start_ts,ev_soc')
      .lte('start_ts', prior).not('ev_soc', 'is', null).order('start_ts', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()) : Promise.resolve(null),
    (async () => {
      const { data, error } = await supabase.functions.invoke('backfill-energy-prices', { body: { home_id: ref.homeId, mode: 'read', pricing_basis: 'current_supplier', start, end }, signal });
      if (error) {
        const response = 'context' in error && error.context instanceof Response ? error.context : null;
        const body = response ? await response.json().catch(() => null) : null;
        throw new Error(body?.message ?? error.message);
      }
      if (!Array.isArray(data?.prices) || !data?.area) throw new Error('Historical electricity prices unavailable');
      if (data.prices.some((row: PriceRow) => row.supplier_revision !== ROI_SUPPLIER_TERMS.revision)) throw new Error('ROI supplier terms changed; reload the page');
      if (!data.catalogue) throw new Error('Monthly grid tariff definitions unavailable');
      return data as { prices: PriceRow[]; area: string; catalogue: import('../../../supabase/functions/_shared/energy-grid-pricing').GridTariffCatalogue };
    })(),
  ]);
  signal.throwIfAborted();
  return prepareHomeBaseline(mergeHourlyHistory({ snapshot, start, end, devices, pool: [...pool, ...batches.flatMap(b => b.pool)], evInitial,
    tariff: pricing.catalogue, actual: batches.flatMap(b => b.actual), prices: pricing.prices, priceArea: pricing.area,
    deviceSlots: batches.flatMap(b => b.deviceSlots), outdoor: batches.flatMap(b => b.outdoor) }, batches.flatMap(b => b.recovered)));
}
