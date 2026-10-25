import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.2';
import type { OptimisationPlan } from './planner/planning-contracts.ts';
import { readPagedRows } from './read-paged-rows.ts';
import { calculateAccuracy, type ForecastRecord, type AccuracyActual, type DeviceActual, type PublishedPrice, type RoomActual } from './forecast-accuracy.ts';
import { controlledRooms } from './planner/controlled-rooms.ts';

/** Called only after successful publication. A failed archive is a gap, never a plan rejection. */
export async function archiveAccuracyForecast(db: SupabaseClient, homeId: string, customerId: string, plan: OptimisationPlan) {
  const slots = plan.plans.priority.slots;
  if (!slots.length) return;
  // Only rooms the plan drives: any other room follows its own thermostat.
  const rooms = controlledRooms(plan);
  const roomIndex = new Map((plan.thermal_projection?.starts ?? []).map((start, i) => [Date.parse(start), i]));
  const roomTemperatures = (start: string) => {
    const i = roomIndex.get(Date.parse(start));
    return i === undefined ? null : Object.fromEntries(rooms.flatMap(room =>
      Number.isFinite(room.planned_temperature_c[i]) ? [[room.key, room.planned_temperature_c[i]]] : []));
  };
  const {error} = await db.from('energy_forecast_records').insert({home_id: homeId, customer_id: customerId,
    plan_id: plan.plan_id, horizon_end: new Date(Date.parse(slots.at(-1)!.start) + 900_000).toISOString(),
    forecast: {timezone: plan.timezone, battery: plan.capabilities.battery && !!plan.battery, model_version: plan.model_version, issued_at: plan.issued_at,
      devices: plan.device_models.map(d => ({key: d.key, name: d.name})),
      ...(rooms.length ? {rooms: rooms.map(room => ({key: room.key, name: room.name}))} : {}),
      slots: slots.map(s => ({start: s.start, duration_hours: s.duration_hours, load_w: s.load_w, pv_w: s.pv_w,
        device_loads_w: s.device_loads_w, battery_charge_w: s.battery_charge_w,
        battery_discharge_w: s.battery_discharge_w, battery_soc: s.battery_soc,
        estimated_import_sek_per_kwh: s.import_price_sek_per_kwh === null ? s.shadow_import_sek_per_kwh ?? null : null,
        ...(rooms.length ? {room_temperature_c: roomTemperatures(s.start)} : {})}))}});
  if (error && error.code !== '23505') throw new Error(error.message);
}

interface AccuracyJob {home_id: string; scheduled_at: string; timezone: string; fence: number}
export async function handleForecastAccuracy(request: Request, db: SupabaseClient): Promise<Response> {
  if (request.method !== 'POST') return Response.json({error: 'method_not_allowed'}, {status: 405});
  const {data: authorized, error: authError} = await db.rpc('verify_energy_accuracy_token', {p_token: request.headers.get('x-energy-accuracy-token')});
  // An unreachable database is not a bad token: the job stays queued for the next sweep.
  if (authError) return Response.json({error: 'unavailable'}, {status: 503});
  if (authorized !== true) return Response.json({error: 'unauthorized'}, {status: 401});
  let job: AccuracyJob | null = null;
  try {
    const body = await request.json();
    if (typeof body.home_id !== 'string' || typeof body.scheduled_at !== 'string') return Response.json({error: 'invalid_body'}, {status: 400});
    const {data, error} = await db.rpc('claim_energy_accuracy_job', {p_home_id: body.home_id, p_scheduled_at: body.scheduled_at});
    if (error) throw new Error(error.message);
    job = data as AccuracyJob | null;
    if (!job) return Response.json({claimed: false});
    const owner = job;
    const from = new Date(Date.parse(owner.scheduled_at) - 7 * 86_400_000).toISOString();
    const [forecasts, actuals, deviceRows, inventory, prices, roomActuals] = await Promise.all([
      readPagedRows<ForecastRecord>((a,b) => db.from('energy_forecast_records').select('plan_id,published_at,forecast')
        .eq('home_id',owner.home_id).gte('horizon_end',from).lte('published_at',owner.scheduled_at).order('published_at').order('plan_id').range(a,b)),
      readPagedRows<AccuracyActual>((a,b) => db.from('energy_optimisation_actual_slots')
        .select('start_ts,total_load_kwh,solar_production_kwh,battery_charge_kwh,battery_discharge_kwh,battery_soc')
        .eq('home_id',owner.home_id).gte('start_ts',from).lt('start_ts',owner.scheduled_at).order('start_ts').range(a,b)),
      readPagedRows<{start_ts: string; device_id: string; energy_kwh: number}>((a,b) => db.from('energy_optimisation_device_slots')
        .select('start_ts,device_id,energy_kwh').eq('home_id',owner.home_id).gte('start_ts',from)
        .lt('start_ts',owner.scheduled_at).order('start_ts').order('device_id').range(a,b)),
      readPagedRows<{id: string; device_key: string}>((a,b) => db.from('energy_optimisation_devices')
        .select('id,device_key').eq('home_id',owner.home_id).order('id').range(a,b)),
      // Includes tomorrow once published: a price is comparable as soon as it is known.
      readPagedRows<PublishedPrice>((a,b) => db.from('energy_optimisation_price_slots')
        .select('start_ts,import_price_sek_per_kwh').eq('home_id',owner.home_id).gte('start_ts',from)
        .order('start_ts').range(a,b)),
      readPagedRows<RoomActual>((a,b) => db.from('energy_optimisation_thermal_slots')
        .select('start_ts,room_key,room_temperature_c').eq('home_id',owner.home_id).gte('start_ts',from)
        .lte('start_ts',owner.scheduled_at).order('start_ts').order('room_key').range(a,b)),
    ]);
    const ids = new Map(inventory.map(d => [d.id,d.device_key]));
    const device_actuals: DeviceActual[] = deviceRows.flatMap(d => ids.has(d.device_id)
      ? [{start_ts: d.start_ts, device_key: ids.get(d.device_id)!, energy_kwh: Number(d.energy_kwh)}] : []);
    const {report, diagnostics} = calculateAccuracy({scheduled_at: owner.scheduled_at, calculated_at: new Date().toISOString(),
      timezone: owner.timezone, forecasts, actuals, device_actuals, room_actuals: roomActuals,
      prices: prices.map(p => ({start_ts: p.start_ts, import_price_sek_per_kwh: Number(p.import_price_sek_per_kwh)}))});
    const {data: completed, error: writeError} = await db.rpc('complete_energy_accuracy_job', {p_home_id: owner.home_id,
      p_scheduled_at: owner.scheduled_at, p_fence: owner.fence, p_report: report, p_diagnostics: diagnostics});
    if (writeError) throw new Error(writeError.message);
    if (completed) for (const device of diagnostics) console.info('[FORECAST-ACCURACY]', JSON.stringify({home_id: owner.home_id,
      scheduled_at: owner.scheduled_at, ...device}));
    return Response.json({completed});
  } catch (error) {
    // PostgREST errors are plain objects; String() would record "[object Object]".
    const detail = error instanceof Error ? error.message
      : typeof (error as {message?: unknown})?.message === 'string' ? (error as {message: string}).message : String(error);
    console.error('[FORECAST-ACCURACY] calculation failed', {home_id: job?.home_id, detail});
    if (job) await db.rpc('fail_energy_accuracy_job', {p_home_id: job.home_id, p_scheduled_at: job.scheduled_at, p_fence: job.fence, p_error: detail});
    return Response.json({error: 'accuracy_calculation_failed'}, {status: 500});
  }
}
