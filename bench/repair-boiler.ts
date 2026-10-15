// Explicit TEST data correction from exported HA hourly statistics. Dry-run by
// default; --apply atomically replaces both halves under their source revision.
import { testProbeServiceKey, PROBE_PROJECT } from '../scripts/planner-probe-auth.ts';
import { DbStore } from './store.ts';
import { separateBoilerHistory, type MeterStatistics } from '../src/lib/planner-bench/boiler-history.ts';

const directory = Deno.args[0];
if (!directory || Deno.args.slice(1).some(arg => arg !== '--apply')) throw new Error('Usage: repair-boiler.ts <statistics-directory> [--apply]');
const apply = Deno.args.includes('--apply');
const key = await testProbeServiceKey(), url = `https://${PROBE_PROJECT}.supabase.co`;
const store = new DbStore(url, key);
const proposals = [];
for (const scenario of await store.scenarios()) {
  if (!scenario.dataset || !scenario.recorded) throw new Error(`${scenario.name}: complete case required.`);
  const statistics: MeterStatistics = JSON.parse(await Deno.readTextFile(`${directory}/${scenario.id}.json`));
  const replacement = separateBoilerHistory(scenario.dataset, scenario.recorded, statistics);
  proposals.push({ scenario, replacement });
  console.log(`${scenario.name}: forecast boiler ${(replacement.dataset.other_devices_w['sensor.water_boiler_energy'].reduce((a, b) => a + b, 0) / 4000).toFixed(2)} kWh, measured attribution ${(replacement.recorded.actual!.other_devices_w!['sensor.water_boiler_energy'].reduce((a, b) => a + b, 0) / 4000).toFixed(2)} kWh`);
}
if (apply) {
  await Deno.writeTextFile(`${directory}/before-boiler-repair.json`, JSON.stringify(proposals.map(p => p.scenario)), { createNew: true });
  for (const { scenario, replacement } of proposals) {
    const response = await fetch(`${url}/rest/v1/bench_scenarios?id=eq.${scenario.id}&revision=eq.${encodeURIComponent(scenario.revision)}&select=id`, {
      method: 'PATCH', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(replacement),
    });
    if (!response.ok) throw new Error(`${scenario.name}: case update failed (${response.status}).`);
    if ((await response.json()).length !== 1) throw new Error(`${scenario.name}: case changed during repair; reload before continuing.`);
  }
}
console.log(`${apply ? 'Updated' : 'Previewed'} ${proposals.length} TEST cases; original household demand preserved.`);
