// Explicit TEST data correction: scale the hot water of cases from before the
// heat pump made it (user decision, 21 October 2026). Dry-run by default;
// --apply saves the originals, then replaces both halves under their source revision.
import { testProbeServiceKey, PROBE_PROJECT } from '../scripts/planner-probe-auth.ts';
import { DbStore } from './store.ts';
import { OLD_HOUSE_HOT_WATER_RATIO, scaleOldHouseHotWater } from '../src/lib/planner-bench/boiler-history.ts';
import { HOUSEHOLD } from '../src/lib/planner-bench/household.ts';

const directory = Deno.args[0];
if (!directory || Deno.args.slice(1).some(arg => arg !== '--apply')) throw new Error('Usage: scale-hot-water.ts <backup-directory> [--apply]');
const apply = Deno.args.includes('--apply');
const key = await testProbeServiceKey(), url = `https://${PROBE_PROJECT}.supabase.co`;
const store = new DbStore(url, key);
const boilerKey = HOUSEHOLD.hot_water.meter_keys[0];
const kwh = (series: number[] | undefined) => ((series ?? []).reduce((a, b) => a + b, 0) / 4000).toFixed(1);
const proposals = [];
for (const scenario of await store.scenarios()) {
  if (!scenario.dataset || !scenario.recorded) throw new Error(`${scenario.name}: complete case required.`);
  if (scenario.dataset.origin.detail.includes('Hot water before 2026-08-29 scaled')) {
    console.log(`${scenario.name}: already scaled`);
    continue;
  }
  const replacement = scaleOldHouseHotWater(scenario.dataset, scenario.recorded);
  if (!replacement.scaled_quarters) {
    console.log(`${scenario.name}: current house, unchanged`);
    continue;
  }
  proposals.push({ scenario, replacement });
  console.log(`${scenario.name}: ${replacement.scaled_quarters} quarters; boiler forecast ${kwh(scenario.dataset.other_devices_w[boilerKey])} -> ${kwh(replacement.dataset.other_devices_w[boilerKey])} kWh, measured ${kwh(scenario.recorded.actual?.other_devices_w?.[boilerKey])} -> ${kwh(replacement.recorded.actual?.other_devices_w?.[boilerKey])} kWh`);
}
if (apply) {
  await Deno.writeTextFile(`${directory}/before-hot-water-scaling.json`, JSON.stringify(proposals.map(p => p.scenario)), { createNew: true });
  for (const { scenario, replacement } of proposals) {
    const response = await fetch(`${url}/rest/v1/bench_scenarios?id=eq.${scenario.id}&revision=eq.${encodeURIComponent(scenario.revision)}&select=id`, {
      method: 'PATCH', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ dataset: replacement.dataset, recorded: replacement.recorded }),
    });
    if (!response.ok) throw new Error(`${scenario.name}: case update failed (${response.status}).`);
    if ((await response.json()).length !== 1) throw new Error(`${scenario.name}: case changed during scaling; reload before continuing.`);
  }
}
console.log(`${apply ? 'Updated' : 'Previewed'} ${proposals.length} TEST cases at ratio ${OLD_HOUSE_HOT_WATER_RATIO}.`);
