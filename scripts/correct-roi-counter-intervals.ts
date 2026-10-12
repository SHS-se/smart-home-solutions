// Prepare a reviewable ROI-only correction from explicit, verified reporting
// intervals and a private measured capture. Never alter HA or measured tables.
import { measureReportedEnergy, type ReportedEnergyInterval } from '../src/lib/home-baseline/reported-energy-intervals.ts';
import type { ActualRow } from '../src/lib/home-baseline/model.ts';

const [capturePath, outputPath] = Deno.args;
if (!capturePath || !outputPath) throw new Error('Usage: correct-roi-counter-intervals.ts private-capture.json output-directory');
const capture = await Deno.readTextFile(capturePath);
const input: { homeId: string; customerId: string; actual: ActualRow[]; intervals: Omit<ReportedEnergyInterval, 'kwh'>[] } = JSON.parse(capture);
if (![input.homeId, input.customerId].every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error('Explicit home and customer UUIDs are required');
const intervals = measureReportedEnergy(input.actual, input.intervals);
if (!intervals.length) throw new Error('No verified counter intervals supplied');
const hourMs = 3_600_000;
const hours = new Map<string, ReportedEnergyInterval[]>();
for (const interval of intervals) {
  for (let at = Math.floor(Date.parse(interval.start) / hourMs) * hourMs; at < Date.parse(interval.end); at += hourMs) {
    const start = new Date(at).toISOString();
    if (!hours.has(start)) hours.set(start, []);
    hours.get(start)!.push(interval);
  }
}
const payload = JSON.stringify([...hours].map(([start_ts, reported_intervals]) => ({ start_ts, reported_intervals })));
const guards = JSON.stringify(intervals);
if ([payload, guards].some(value => value.includes('$interval$') || value.includes('$verify$'))) throw new Error('Invalid SQL payload delimiter');
const sql = `BEGIN;
DO $verify$
DECLARE r record; found_energy numeric; found_count integer;
BEGIN
  FOR r IN SELECT * FROM jsonb_to_recordset($interval$${guards}$interval$::jsonb)
    AS t(field text,start timestamptz,"end" timestamptz,kwh numeric,source text)
  LOOP
    SELECT sum(coalesce((to_jsonb(s)->>r.field)::numeric,0)),count(*) INTO found_energy,found_count
    FROM public.energy_optimisation_actual_slots s
    WHERE home_id='${input.homeId}'::uuid AND customer_id='${input.customerId}'::uuid
      AND start_ts>=r.start AND start_ts<r."end";
    IF found_count<>extract(epoch FROM (r."end"-r.start))/900 OR round(found_energy,9)<>round(r.kwh,9) THEN
      RAISE EXCEPTION 'Counter observations changed; recapture before applying correction';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.energy_roi_history_hours h,
    jsonb_array_elements(coalesce(h.actual->'reported_intervals','[]'::jsonb)) old,
    jsonb_to_recordset($interval$${guards}$interval$::jsonb) AS incoming(field text,start timestamptz,"end" timestamptz,kwh numeric,source text)
    WHERE h.home_id='${input.homeId}'::uuid AND h.customer_id='${input.customerId}'::uuid
      AND old->>'field'=incoming.field AND (old->>'start')::timestamptz<incoming."end"
      AND (old->>'end')::timestamptz>incoming.start
      AND NOT ((old->>'start')::timestamptz=incoming.start AND (old->>'end')::timestamptz=incoming."end")) THEN
    RAISE EXCEPTION 'Overlapping stored correction; review reporting intervals';
  END IF;
  IF (SELECT count(*) FROM public.energy_roi_history_hours WHERE home_id='${input.homeId}'::uuid
    AND customer_id='${input.customerId}'::uuid AND start_ts IN
    (SELECT start_ts FROM jsonb_to_recordset($interval$${payload}$interval$::jsonb) AS t(start_ts timestamptz,reported_intervals jsonb)))<>${hours.size} THEN
    RAISE EXCEPTION 'ROI recovery hours missing';
  END IF;
END $verify$;
UPDATE public.energy_roi_history_hours h
SET actual=h.actual || jsonb_build_object('reported_intervals',
  coalesce((SELECT jsonb_agg(old) FROM jsonb_array_elements(coalesce(h.actual->'reported_intervals','[]'::jsonb)) old
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.reported_intervals) incoming
      WHERE old->>'field'=incoming->>'field' AND (old->>'start')::timestamptz=(incoming->>'start')::timestamptz
        AND (old->>'end')::timestamptz=(incoming->>'end')::timestamptz)), '[]'::jsonb) || t.reported_intervals),imported_at=now()
FROM jsonb_to_recordset($interval$${payload}$interval$::jsonb) AS t(start_ts timestamptz,reported_intervals jsonb)
WHERE h.home_id='${input.homeId}'::uuid AND h.customer_id='${input.customerId}'::uuid AND h.start_ts=t.start_ts;
COMMIT;
`;
await Deno.mkdir(outputPath, { recursive: true });
await Deno.writeTextFile(`${outputPath}/correction.sql`, sql);
await Deno.writeTextFile(`${outputPath}/audit.json`, JSON.stringify({ intervals, hours: hours.size,
  allocation: 'Evenly allocated across the verified reporting interval; quarter timing is estimated.' }, null, 2));
console.log(JSON.stringify({ intervals: intervals.length, hours: hours.size }));
