/** Service-only publication; never modifies actual measurements or issued forecasts.
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must target the intended environment.
 * deno run --allow-read --allow-env --allow-net scripts/publish-roi-solar.ts prepared.json HOME_UUID CUSTOMER_UUID
 */
import { z } from 'zod';
const uuid = z.string().uuid(), finite = z.number().finite().nonnegative();
const [file, home, customer] = Deno.args;
if (!file) throw new Error('Choose a prepared solar JSON file, home UUID and customer UUID');
const homeId = uuid.parse(home), customerId = uuid.parse(customer);
const prepared = z.object({ profile_hash: z.string().regex(/^[a-f0-9]{64}$/), start_ts: z.string().datetime(), end_ts: z.string().datetime(),
  hours: z.array(z.object({ start_ts: z.string().datetime(), raw_kwh: finite, modeled_kwh: finite }).strict()).min(1).max(9000),
  provenance: z.record(z.unknown()),
}).strict().parse(JSON.parse(await Deno.readTextFile(file)));
const from = Date.parse(prepared.start_ts), to = Date.parse(prepared.end_ts);
if (from % 3_600_000 || to % 3_600_000 || prepared.hours.length !== (to-from)/3_600_000
  || prepared.hours.some((hour,i) => Date.parse(hour.start_ts) !== from+i*3_600_000)) throw new Error('Solar history must cover every hour in order');
const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) throw new Error('Configure the target Supabase URL and service-role key');
const response = await fetch(`${url}/rest/v1/rpc/publish_energy_roi_solar_profile`, { method:'POST', headers:{ apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json' },
  body:JSON.stringify({ p_home_id:homeId, p_customer_id:customerId, p_profile_hash:prepared.profile_hash, p_start:prepared.start_ts, p_end:prepared.end_ts, p_provenance:prepared.provenance, p_hours:prepared.hours }) });
if (!response.ok) throw new Error(`Solar publication failed (${response.status}): ${await response.text()}`);
if (await response.json() !== prepared.profile_hash) throw new Error('Published solar profile identity did not match');
console.log(`Published ${prepared.hours.length} modeled solar hours; affected ROI report requires recalculation.`);
