import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractEmbeddedPdfText } from '../src/lib/pdf-embedded-text.ts';
import { retryRetainedEnergyInvoices, type InvoiceRetryStore } from '../src/lib/energy-invoice-retry.ts';

const ref = process.env.SUPABASE_PROJECT_REF;
if (!['vxqpgbzseckgceopitpm', 'oosxndduqzhvrorgogaw'].includes(ref ?? '')) {
  throw new Error('SUPABASE_PROJECT_REF must explicitly identify TEST or production');
}
let key: string | undefined;
try {
  const keys: Array<{ name: string; api_key: string }> = JSON.parse(execFileSync('supabase', [
    'projects', 'api-keys', '--project-ref', ref!, '--reveal', '--output', 'json',
  ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  key = keys.find(row => row.name === 'service_role')?.api_key;
} catch {
  // Do not expose command buffers containing credentials in a thrown error.
  throw new Error('Could not read deployment invoice retry credentials');
}
if (!key) throw new Error('Deployment invoice retry credentials are unavailable');
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${key}`);
const client = createClient(`https://${ref}.supabase.co`, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store: InvoiceRetryStore = {
  async list(cutoff, after) {
    let query = client.from('energy_parse_failures')
      .select('id,created_at,original_file_name,file_path,file_sha256,file_size_bytes,mime_type,file_category,retry_imported_at')
      .lte('created_at', cutoff).order('created_at').order('id').limit(100);
    if (after) query = query.or(`created_at.gt.${after.created_at},and(created_at.eq.${after.created_at},id.gt.${after.id})`);
    const { data, error } = await query;
    if (error) throw new Error(`Failure listing failed (${error.code})`);
    return data ?? [];
  },
  async download(path) {
    const { data, error } = await client.storage.from('energy-parser-failures').download(path);
    if (error) throw new Error('Retained PDF download failed');
    return new Uint8Array(await data.arrayBuffer());
  },
  async complete(id, payload) {
    const { data, error } = await client.rpc('complete_energy_invoice_retry', {
      p_failure_id: id, p_document: payload?.document ?? null, p_line_items: payload?.lineItems ?? null,
    });
    if (error) throw new Error(`Invoice retry commit failed (${error.code})`);
    return data === true;
  },
  async removeSource(path) {
    const { error } = await client.storage.from('energy-parser-failures').remove([path]);
    if (error) throw new Error('Imported source cleanup failed');
  },
  async finish(id) {
    const { error } = await client.rpc('finish_energy_invoice_retry', { p_failure_id: id });
    if (error) throw new Error(`Retry receipt cleanup failed (${error.code})`);
  },
};
const report = await retryRetainedEnergyInvoices(store,
  bytes => extractEmbeddedPdfText(getDocument, bytes), process.argv.includes('--dry-run'));
console.log(JSON.stringify({ project: ref, dryRun: process.argv.includes('--dry-run'), ...report }));
if (report.errors.length) process.exitCode = 1;
