/** Job-scoped numerical artifacts. Probability/state semantics belong to native
 * models; this codec owns only lossless JSON records and byte addressing. */
export const FORECAST_CATALOG_PAGE_BYTES = 64 * 1024;

function artifactJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite forecast artifact number");
    return item;
  });
  if (json === undefined) throw new Error("Forecast artifact is not JSON");
  return json;
}

export interface ForecastCatalogPage {
  first_record: number;
  count: number;
  /** Cumulative UTF-8 offsets, including zero and the final byte length. */
  offsets: number[];
  bytes: Uint8Array;
}

/** Whole records make a selected posterior independently readable. An unusually
 * large record gets its own page; page size never limits physical model degree. */
export function encodeForecastCatalogPages(records: readonly unknown[], pageBytes = FORECAST_CATALOG_PAGE_BYTES): ForecastCatalogPage[] {
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 1) throw new Error("Invalid forecast catalog page size");
  const encoder = new TextEncoder(), pages: ForecastCatalogPage[] = [];
  let first = 0, chunks: Uint8Array[] = [], length = 0;
  const flush = () => {
    if (!chunks.length) return;
    const bytes = new Uint8Array(length), offsets = [0];
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; offsets.push(position); }
    pages.push({ first_record: first, count: chunks.length, offsets, bytes });
    first += chunks.length; chunks = []; length = 0;
  };
  for (const record of records) {
    const json = artifactJson(record);
    const bytes = encoder.encode(json);
    if (chunks.length && length + bytes.length > pageBytes) flush();
    chunks.push(bytes); length += bytes.length;
    if (length >= pageBytes) flush();
  }
  flush();
  return pages;
}

/** Rust parses the selected native hypothesis. Do not normalize weights or
 * reinterpret covariance in the storage/transport layer. */
export function forecastCatalogRecordText(page: ForecastCatalogPage, record: number): string {
  const valid = Number.isSafeInteger(page.first_record) && page.first_record >= 0 &&
    Number.isSafeInteger(page.count) && page.count > 0 && page.offsets.length === page.count + 1 &&
    page.offsets[0] === 0 && page.offsets.at(-1) === page.bytes.length &&
    page.offsets.every((offset, i) => Number.isSafeInteger(offset) && offset >= 0 && (i === 0 || offset > page.offsets[i - 1]));
  if (!valid || !Number.isSafeInteger(record) || record < page.first_record || record >= page.first_record + page.count) {
    throw new Error("Invalid forecast catalog record range");
  }
  const index = record - page.first_record;
  return new TextDecoder("utf-8", { fatal: true }).decode(page.bytes.subarray(page.offsets[index], page.offsets[index + 1]));
}

/** Immutable worker context is transferred compressed, rather than letting a
 * database JSON response expand it on every bounded numerical slice. */
export async function compressForecastValue(value: unknown): Promise<Uint8Array> {
  const json = artifactJson(value);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decompressForecastValue(bytes: Uint8Array): Promise<unknown> {
  const copy = new Uint8Array(bytes.length); copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
