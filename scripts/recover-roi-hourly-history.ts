// Private captures stay outside the repository. This prepares SQL; it never
// obtains credentials or writes to HA, the planner, or the measured tables.
import { prepareHourlyRecovery, type RecoverySpec, type StatisticSeries } from '../src/lib/home-baseline/recovered-history.ts';

const [capturePath, outputPath] = Deno.args;
if (!capturePath || !outputPath) throw new Error('Usage: recover-roi-hourly-history.ts private-capture.json output-directory');
const text = await Deno.readTextFile(capturePath);
const input: { customerId: string; homeId: string; series: StatisticSeries[]; spec: RecoverySpec } = JSON.parse(text);
if (![input.customerId, input.homeId].every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error('Explicit customer and home UUIDs are required');
const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const hours = prepareHourlyRecovery(input.series, input.spec);
await Deno.mkdir(outputPath, { recursive: true });
await Deno.writeTextFile(`${outputPath}/normalized-hours.json`, JSON.stringify(hours));
const report = { start: input.spec.start, end: input.spec.end, hours: hours.length, captureSha256: hash,
  deviceSumHours: hours.filter(h => h.baseline_load_kwh !== null).length,
  invalidReadings: hours.reduce((n, h) => n + h.invalid_readings, 0),
  energy: Object.fromEntries(['grid_import_kwh', 'grid_export_kwh', 'solar_production_kwh'].map(key => [key,
    hours.filter(h => h.start_ts >= input.spec.start).reduce((n, h) => n + (h.actual[key as keyof typeof h.actual] ?? 0), 0)])) };
await Deno.writeTextFile(`${outputPath}/audit.json`, JSON.stringify(report, null, 2));
// Bounded, idempotent imports. A corrected capture replaces only this home's
// recovered hours, with its new hash. It cannot update measured/planner rows.
for (let i = 0; i < hours.length; i += 400) {
  const payload = JSON.stringify(hours.slice(i, i + 400));
  if (payload.includes('$roi$')) throw new Error('Invalid SQL payload delimiter');
  const sql = `INSERT INTO public.energy_roi_history_hours
    (home_id,customer_id,start_ts,actual,device_energy_kwh,pool_c,outdoor_c,baseline_load_kwh,sources,invalid_readings,capture_sha256)
    SELECT '${input.homeId}'::uuid,'${input.customerId}'::uuid,h.start_ts,h.actual,h.device_energy_kwh,h.pool_c,h.outdoor_c,h.baseline_load_kwh,h.sources,h.invalid_readings,'${hash}'
    FROM jsonb_to_recordset($roi$${payload}$roi$::jsonb) AS h(start_ts timestamptz,actual jsonb,device_energy_kwh jsonb,pool_c numeric,outdoor_c numeric,baseline_load_kwh numeric,sources jsonb,invalid_readings integer)
    ON CONFLICT (home_id,start_ts) DO UPDATE SET actual=EXCLUDED.actual,device_energy_kwh=EXCLUDED.device_energy_kwh,pool_c=EXCLUDED.pool_c,
      outdoor_c=EXCLUDED.outdoor_c,baseline_load_kwh=EXCLUDED.baseline_load_kwh,sources=EXCLUDED.sources,invalid_readings=EXCLUDED.invalid_readings,
      capture_sha256=EXCLUDED.capture_sha256,imported_at=now();`;
  await Deno.writeTextFile(`${outputPath}/import-${String(i / 400).padStart(2, '0')}.sql`, sql);
}
console.log(JSON.stringify(report, null, 2));
