import { parseEnergyBillingDocument } from './energy-billing-parser.ts';
import { createEnergyBillingPayload, type EnergyBillingPayload } from './energy-billing-payload.ts';
import type { EmbeddedPdfText } from './pdf-embedded-text.ts';

export interface RetainedInvoiceSource {
  id: string;
  created_at: string;
  original_file_name: string;
  file_path: string;
  file_sha256: string;
  file_size_bytes: number;
  mime_type: string;
  file_category: string;
  retry_imported_at: string | null;
}

export interface InvoiceRetryStore {
  list(cutoff: string, after?: { created_at: string; id: string }): Promise<RetainedInvoiceSource[]>;
  download(path: string): Promise<Uint8Array>;
  complete(id: string, payload?: EnergyBillingPayload): Promise<boolean>;
  removeSource(path: string): Promise<void>;
  finish(id: string): Promise<void>;
}

export interface InvoiceRetryReport {
  imported: number;
  recovered: number;
  retained: number;
  skipped: number;
  errors: Array<{ failureId: string; message: string }>;
}

/** Resume committed imports before parsing; keep rejected sources privately for review. */
export async function retryRetainedEnergyInvoices(
  store: InvoiceRetryStore,
  extractPdfText: (bytes: Uint8Array) => Promise<EmbeddedPdfText>,
  dryRun = false,
): Promise<InvoiceRetryReport> {
  const report: InvoiceRetryReport = { imported: 0, recovered: 0, retained: 0, skipped: 0, errors: [] };
  const cutoff = new Date().toISOString();
  let after: { created_at: string; id: string } | undefined;
  const cleanup = async (source: RetainedInvoiceSource) => {
    await store.removeSource(source.file_path);
    await store.finish(source.id);
  };
  for (;;) {
    const sources = await store.list(cutoff, after);
    if (!sources.length) break;
    for (const source of sources) {
      try {
        if (source.retry_imported_at) {
          if (!dryRun) await cleanup(source);
          report.recovered++;
          continue;
        }
        if (source.file_category !== 'document' || source.mime_type !== 'application/pdf') {
          report.skipped++;
          continue;
        }
        if (!dryRun && await store.complete(source.id)) {
          await cleanup(source);
          report.recovered++;
          continue;
        }
        const bytes = await store.download(source.file_path);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== source.file_size_bytes || hash !== source.file_sha256) {
          throw new Error('Retained source does not match its recorded size/hash');
        }
        const extraction = await extractPdfText(bytes);
        if (extraction.isScanned) {
          report.skipped++;
          continue;
        }
        const parsed = parseEnergyBillingDocument(extraction.text);
        if (!parsed.importable) {
          report.retained++;
          continue;
        }
        const payload = createEnergyBillingPayload(parsed, {
          fileName: source.original_file_name, mimeType: source.mime_type,
          sizeBytes: source.file_size_bytes, sha256: source.file_sha256,
        });
        if (!dryRun) {
          if (!await store.complete(source.id, payload)) throw new Error('Invoice retry was not committed');
          await cleanup(source);
        }
        report.imported++;
      } catch (error) {
        // Report IDs and operational errors only; never log extracted invoice text.
        report.errors.push({ failureId: source.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const last = sources[sources.length - 1];
    after = { created_at: last.created_at, id: last.id };
  }
  return report;
}
