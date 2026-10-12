import { assertEquals, assertRejects } from '@std/assert';
import { retryRetainedEnergyInvoices, type InvoiceRetryStore, type RetainedInvoiceSource } from '../src/lib/energy-invoice-retry.ts';
import { createEnergyBillingPayload } from '../src/lib/energy-billing-payload.ts';
import { parseEnergyBillingDocument } from '../src/lib/energy-billing-parser.ts';

const invoice = `Faktura elnät 5 oktober 2026 Faktura/OCR-nummer: 6600000000001 Ellevio AB
Belopp att betala: 100 kr Kostnad 1 sep 2026 t o m 30 sep 2026
Fast avgift 30 dagar 50 kr/mån 50 kr Överföringsavgift 10 kWh 10 öre/kWh 1 kr
Energiskatt 10 kWh 45 öre/kWh 4,50 kr`;
const bytes = new TextEncoder().encode(invoice);
async function fixture() {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const source: RetainedInvoiceSource = { id: 'a', created_at: '2026-01-01T00:00:00Z', file_path: 'customer/a/source.pdf', file_sha256: hash,
    file_size_bytes: bytes.length, original_file_name: 'source.pdf', mime_type: 'application/pdf', file_category: 'document', retry_imported_at: null };
  let rows = [source], downloads = 0, inserts = 0, cleanupFails = false, finishFails = false;
  const calls: string[] = [];
  const store: InvoiceRetryStore = {
    list: async (_cutoff, after) => rows.filter(r => !after || r.id > after.id).slice(0, 1),
    download: async () => { downloads++; calls.push('download'); return bytes.slice(); },
    complete: async (_id, payload) => {
      calls.push(payload ? 'commit' : 'probe');
      if (!payload) return false;
      inserts++; source.retry_imported_at = '2026-01-02T00:00:00Z'; return true;
    },
    removeSource: async () => { calls.push('remove'); if (cleanupFails) throw new Error('storage unavailable'); },
    finish: async id => { calls.push('finish'); if (finishFails) throw new Error('receipt unavailable'); rows = rows.filter(r => r.id !== id); },
  };
  return { source, store, calls, add: (source: RetainedInvoiceSource) => { rows.push(source); },
    failCleanup: (value: boolean) => { cleanupFails = value; }, failFinish: (value: boolean) => { finishFails = value; }, stats: () => ({ downloads, inserts, rows: rows.length }) };
}
const extract = async (data: Uint8Array) => ({ text: new TextDecoder().decode(data), isScanned: false, pageCount: 1 });

Deno.test('invoice retry imports once, then removes private source before its receipt', async () => {
  const f = await fixture();
  assertEquals((await retryRetainedEnergyInvoices(f.store, extract)).imported, 1);
  assertEquals(f.calls, ['probe', 'download', 'commit', 'remove', 'finish']);
  assertEquals((await retryRetainedEnergyInvoices(f.store, extract)).imported, 0);
  assertEquals(f.stats(), { downloads: 1, inserts: 1, rows: 0 });
});
Deno.test('invoice retry resumes either interrupted cleanup without extracting or importing again', async () => {
  for (const stage of ['source', 'receipt']) {
    const f = await fixture();
    if (stage === 'source') f.failCleanup(true); else f.failFinish(true);
    assertEquals((await retryRetainedEnergyInvoices(f.store, extract)).errors.length, 1);
    f.failCleanup(false); f.failFinish(false);
    assertEquals((await retryRetainedEnergyInvoices(f.store, extract)).recovered, 1);
    assertEquals(f.stats(), { downloads: 1, inserts: 1, rows: 0 });
  }
});
Deno.test('exact duplicates recover without a source download', async () => {
  const f = await fixture(); f.store.complete = async () => true;
  assertEquals((await retryRetainedEnergyInvoices(f.store, extract)).recovered, 1);
  assertEquals(f.stats().downloads, 0);
});
Deno.test('retained parse rejections, scans and unsupported sources do not write or clean up', async () => {
  const f = await fixture();
  assertEquals((await retryRetainedEnergyInvoices(f.store, async () => ({ text: 'unknown', isScanned: false, pageCount: 1 }))).retained, 1);
  assertEquals((await retryRetainedEnergyInvoices(f.store, async () => ({ text: '', isScanned: true, pageCount: 1 }))).skipped, 1);
  f.source.file_category = 'csv';
  assertEquals((await retryRetainedEnergyInvoices(f.store, extract)).skipped, 1);
  assertEquals(f.stats().inserts, 0); assertEquals(f.calls.includes('remove'), false);
});
Deno.test('hash mismatch retains source and does not stop other paginated files', async () => {
  const f = await fixture();
  f.add({ ...f.source, id: 'b', file_category: 'csv' });
  f.source.file_sha256 = '0'.repeat(64);
  const report = await retryRetainedEnergyInvoices(f.store, extract);
  assertEquals(report.errors.length, 1); assertEquals(report.skipped, 1);
  assertEquals(f.stats().inserts, 0);
});
Deno.test('dry run parses without completing imports or deleting anything', async () => {
  const f = await fixture();
  assertEquals((await retryRetainedEnergyInvoices(f.store, extract, true)).imported, 1);
  assertEquals(f.calls, ['download']); assertEquals(f.stats().rows, 1);
});
Deno.test('shared billing payload preserves source metadata, credits and rejects incomplete parsing', async () => {
  const payload = createEnergyBillingPayload(parseEnergyBillingDocument(invoice), { fileName: 'bill.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) });
  assertEquals(payload.document.original_file_name, 'bill.pdf');
  assertEquals(payload.lineItems.map(i => i.category), ['fixed_fee', 'energy_transfer', 'energy_tax']);
  await assertRejects(async () => createEnergyBillingPayload(parseEnergyBillingDocument('unknown'), { fileName: 'x', mimeType: 'application/pdf', sizeBytes: 10, sha256: '' }), Error, 'not importable');
});
