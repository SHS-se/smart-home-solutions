/** Pool-only observation loading and fitting. Publication belongs to the fenced learning job. */
import { fitPoolLoss, fitPoolModel, fitPoolResponse, type PoolLossSample, type PoolResponseSample, poolTrainingWindowStartMs } from "../device-learning/pool/thermal.ts";
import { selectPoolDynamics } from "../device-learning/pool/selection.ts";
import { WATER_KWH_PER_M3_K } from "../planner/device-models.ts";
import { readPagedRows } from "../read-paged-rows.ts";
const TRAINING_WINDOW_DAYS = 21;
const SLOT_MS = 900_000;
export async function fitStoredPool(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  homeId: string,
  volumeM3: number,
  poolDeviceKeys: string[],
): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const { data: existing, error: existingError } = await supabase
    .from("energy_optimisation_pool_model")
    .select("*")
    .eq("home_id", homeId)
    .maybeSingle();
  if (existingError) {
    throw new Error(existingError.message);
  }
  // Samples from before the current heat pump was commissioned describe a
  // different machine, so the window is clamped to it and a newly recorded
  // epoch invalidates the standing fit at once rather than a day later.
  const epochStart = existing?.heat_pump_epoch_start
    ? Date.parse(existing.heat_pump_epoch_start)
    : null;


  const from = new Date(
    poolTrainingWindowStartMs(now, epochStart, TRAINING_WINDOW_DAYS),
  ).toISOString();
  // The heater's energy is stored against `device_id`, so the pool's device
  // keys have to be resolved to ids before the slots can be filtered by them.
  // Without any, there is no heated quarter to find and no fit to attempt.
  const { data: poolDevices, error: poolDeviceError } = await supabase
    .from("energy_optimisation_devices")
    .select("id")
    .eq("home_id", homeId)
    .in("device_key", poolDeviceKeys);
  if (poolDeviceError) {
    throw new Error(poolDeviceError.message);
  }
  const poolDeviceIds = (poolDevices ?? []).map((row: Record<string, unknown>) =>
    String(row.id)
  );
  if (poolDeviceIds.length === 0) throw new Error("Pool has no mapped electricity meters");

  // Read in pages: three weeks of quarters is twice what one response
  // returns, and a heater quarter that is cut off reads as an idle one, which
  // turns the heating into the pool warming itself and the loss fit into a
  // refusal.
  type Row = Record<string, unknown>;
  let waterRows: Row[], outdoorRows: Row[], deviceRows: Row[];
  try {
    [waterRows, outdoorRows, deviceRows] = await Promise.all([
      readPagedRows<Row>((fromRow, toRow) => supabase.from("energy_optimisation_pool_slots")
        .select("start_ts, water_temperature_c")
        .eq("home_id", homeId).gte("start_ts", from)
        .order("start_ts").range(fromRow, toRow)),
      readPagedRows<Row>((fromRow, toRow) => supabase.from("energy_optimisation_outdoor_slots")
        .select("start_ts, temperature_c")
        .eq("home_id", homeId).gte("start_ts", from)
        .order("start_ts").range(fromRow, toRow)),
      readPagedRows<Row>((fromRow, toRow) => supabase.from("energy_optimisation_device_slots")
        .select("start_ts, energy_kwh")
        .eq("home_id", homeId).gte("start_ts", from)
        .in("device_id", poolDeviceIds).order("start_ts").order("device_id")
        .range(fromRow, toRow)),
    ]);
  } catch (readError) {
    // A failed read is not a refusal to fit. Treating it as one would write a
    // rejection that reads like a Swedish summer, stamp `fitted_at` with it, and
    // then sit on that answer for the whole refit interval.
    throw readError;
  }

  const outdoorByStart = new Map<number, number>(
    (outdoorRows ?? []).map((row: Record<string, unknown>) => [
      Date.parse(String(row.start_ts)),
      Number(row.temperature_c),
    ]),
  );
  const heaterByStart = new Map<number, number>(), heaterCounts = new Map<number, number>();
  for (const row of deviceRows ?? []) {
    const at = Date.parse(String(row.start_ts)), kwh = Number(row.energy_kwh);
    if (row.energy_kwh == null || !Number.isFinite(at) || !Number.isFinite(kwh) || kwh < 0) continue;
    heaterByStart.set(at, (heaterByStart.get(at) ?? 0) + kwh);
    heaterCounts.set(at, (heaterCounts.get(at) ?? 0) + 1);
  }
  for (const [at, count] of heaterCounts) if (count !== poolDeviceIds.length) heaterByStart.delete(at);

  const water = (waterRows ?? []).map((row: Record<string, unknown>) => ({
    at: Date.parse(String(row.start_ts)),
    c: Number(row.water_temperature_c),
  }));
  const samples: PoolLossSample[] = [];
  // The measured response needs no air temperature, so it keeps the quarters the fits below must drop.
  const responseSamples: PoolResponseSample[] = [];
  for (let index = 0; index + 1 < water.length; index += 1) {
    const current = water[index];
    const next = water[index + 1];
    // Only consecutive quarters describe one slot's change. A gap would put an
    // hour of cooling into a fifteen-minute rate and bias the loss upward.
    if (next.at - current.at !== SLOT_MS || !heaterByStart.has(current.at) || !heaterByStart.has(next.at)) continue;
    responseSamples.push({
      start_ms: current.at,
      water_temperature_c: current.c,
      next_water_temperature_c: next.c,
      electrical_kwh: heaterByStart.get(current.at)!,
      next_electrical_kwh: heaterByStart.get(next.at)!,
    });
    const air = outdoorByStart.get(current.at), nextAir = outdoorByStart.get(next.at);
    if (air === undefined || !Number.isFinite(air) || nextAir === undefined || !Number.isFinite(nextAir)) continue;
    samples.push({
      start_ms: current.at,
      water_temperature_c: current.c,
      next_water_temperature_c: next.c,
      outdoor_temperature_c: air,
      next_outdoor_temperature_c: nextAir,
      electrical_kwh: heaterByStart.get(current.at)!,
      next_electrical_kwh: heaterByStart.get(next.at)!,
    });
  }

  const result = fitPoolModel(samples, volumeM3, "quarter_mean");
  const idle = fitPoolLoss(samples, volumeM3, "quarter_mean");
  const response = fitPoolResponse(responseSamples, "quarter_mean");
  const dynamics = selectPoolDynamics(responseSamples, volumeM3 * WATER_KWH_PER_M3_K, "quarter_mean");
  const idleRow = "fitted" in idle
    ? {
      idle_loss_kw_per_k: idle.fitted.loss_kw_per_k,
      idle_loss_hours: idle.fitted.hours,
      idle_loss_run_count: idle.fitted.run_count,
      idle_loss_rejection: null,
    }
    : {
      ...(existing?.idle_loss_kw_per_k != null ? {} : {
        idle_loss_kw_per_k: null, idle_loss_hours: idle.hours,
        idle_loss_run_count: idle.run_count, idle_loss_rejection: idle.rejected,
      }),
    };
  const row = "fitted" in result
    ? {
      home_id: homeId,
      customer_id: customerId,
      fitted_at: new Date(now).toISOString(),
      ...result.fitted,
      rejection: null,
      ...idleRow,
      ...(response.length ? { response } : {}),
    }
    : {
      home_id: homeId,
      customer_id: customerId,
      ...idleRow,
      ...(response.length ? { response } : {}),
      ...(existing?.rated_cop != null ? {} : {
        fitted_at: new Date(now).toISOString(),
        loss_kw_per_k: null, rated_cop: null, cop_per_air_c: null, background_kw: null, r2: null,
        sample_count: result.sample_count, heated_sample_count: result.heated_sample_count,
      }),
      rejection: existing?.rated_cop != null ? null : result.rejected,
    };
  const attempt = { learning: { method: "pool_interval_mean_v1", observation: "quarter_mean" }, recovery_selection: dynamics.selection, issues: [
    ...("fitted" in result ? result.warnings ?? [] : [result.rejected]),
    ...("fitted" in idle ? idle.warnings ?? [] : [idle.rejected]),
    ...(response.some(bin => (bin.idle_hours > 0 && bin.idle_hours < 3) || (bin.heated_kwh > 0 && bin.heated_kwh < 3)) ? ["limited_response_observations"] : []),
    ...("rejected" in dynamics ? ["pool_dynamics_" + dynamics.rejected] : []),
  ], ...( "fitted" in dynamics ? { thermal_response: {
    response_time_constant_h: dynamics.fitted.response_time_constant_h,
    source: dynamics.fitted.source,
    recovery_evidence: dynamics.fitted.recovery_evidence,
    rmse_c: dynamics.fitted.rmse_c,
    instantaneous_rmse_c: dynamics.fitted.instantaneous_rmse_c,
    sample_count: dynamics.fitted.sample_count,
  } } : {}) };
  return { ...row, ...("fitted" in dynamics ? { thermal_dynamics: dynamics.fitted } : {}),
    last_attempted_at: new Date(now).toISOString(), last_fit_attempt: attempt };
}
