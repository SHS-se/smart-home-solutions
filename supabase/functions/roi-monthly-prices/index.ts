import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.2';
import { resolveCaller } from '../_shared/staff-auth.ts';
import { monthlySpotAverage, type SpotInterval } from '../_shared/monthly-spot-average.ts';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const localDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    if (!await resolveCaller(req)) return json({ error: 'unauthorized' }, 401);
    const { area, month } = await req.json();
    if (!['SE1', 'SE2', 'SE3', 'SE4'].includes(area) || typeof month !== 'string'
      || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2022-11') return json({ error: 'invalid_month_or_area' }, 400);
    const yesterday = new Date(`${localDate(new Date())}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0, 12));
    const through = new Date(Math.min(lastDay.getTime(), yesterday.getTime())).toISOString().slice(0, 10);
    if (through < `${month}-01`) return json({ error: 'month_not_available' }, 422);
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: cached, error: readError } = await db.from('energy_monthly_spot_prices').select('*').eq('area', area).eq('month', `${month}-01`).maybeSingle();
    if (readError) throw readError;
    if (cached?.through_date === through) return json(cached);
    const days = Number(through.slice(-2));
    const daily: SpotInterval[][] = [];
    for (let day = 1; day <= days; day += 4) {
      const batch = await Promise.all(Array.from({ length: Math.min(4, days - day + 1) }, async (_, offset) => {
        const date = `${month}-${String(day + offset).padStart(2, '0')}`;
        const response = await fetch(`https://www.elprisetjustnu.se/api/v1/prices/${date.slice(0, 4)}/${date.slice(5)}_${area}.json`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Market prices unavailable: ${date}`);
        const rows: SpotInterval[] = await response.json();
        monthlySpotAverage(rows);
        // Each requested day must include both local midnight boundaries.
        if (localDate(new Date(rows[0].time_start)) !== date
          || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(new Date(rows[0].time_start)) !== '00:00'
          || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(new Date(rows.at(-1)!.time_end)) !== '00:00'
          || localDate(new Date(rows.at(-1)!.time_end)) !== new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) throw new Error('Incomplete market day');
        return rows;
      }));
      daily.push(...batch);
    }
    const result = { area, month: `${month}-01`, through_date: through, average_sek_ex_vat: monthlySpotAverage(daily.flat()), updated_at: new Date().toISOString() };
    const { error } = await db.from('energy_monthly_spot_prices').upsert(result);
    if (error) throw error;
    return json(result);
  } catch (error) {
    console.error('ROI monthly prices:', error);
    return json({ error: 'monthly_prices_unavailable' }, 502);
  }
});
