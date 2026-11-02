/** Derive versioned quality metadata from retained parsed documents; never rewrite source evidence. */
import { marketEvidenceClient, newPrivateEvidenceDirectory } from './market-evidence-client.ts';
import { assessMarketObservation, type AssessedObservation } from '../supabase/functions/_shared/market-evidence-assessment.ts';
const out = await newPrivateEvidenceDirectory(Deno.args, 'Usage: deno task research:market:assess --out NEW_PRIVATE_DIRECTORY');
const client = await marketEvidenceClient(), snapshot = await client.snapshot();
await Deno.writeTextFile(`${out}/manifest.json`, JSON.stringify(snapshot, null, 2) + '\n');
const done = new Set(snapshot.assessed_ids), pending = snapshot.observation_ids.filter(id => !done.has(id));
let saved = 0;
for (let at = 0; at < pending.length; at += 8) {
  const documents = await client.documents<AssessedObservation>(pending.slice(at, at + 8));
  await Promise.all(documents.map(row => client.assess(row.id, assessMarketObservation(row))));
  saved += documents.length;
  if (saved % 100 < 8) console.log(`Assessed ${saved}/${pending.length} retained observations.`);
}
await Deno.writeTextFile(`${out}/result.json`, JSON.stringify({ snapshot_at: snapshot.at, assessed: saved }) + '\n');
console.log(`Assessed ${saved} retained observations without changing source evidence.`);
