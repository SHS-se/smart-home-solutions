/** Public Swedish weekly hydro evidence. Observed weekly inflow is never a future MW forecast. */
export interface HydroWeek {
  isoYear: number; isoWeek: number; version: string;
  /** Exclusive end of the ISO week: Monday 00:00 in Europe/Stockholm. */
  weekEnd: string; providerModifiedAt: string | null;
  se3StoredGwh: number; se3FillingPercent: number;
  swedenInflowGwh: number; swedenInflowMedianPercent: number;
  swedenFillingPercent: number; swedenNormalFillingPercent: number;
}
export interface HydroReport {
  url: string; lastModified: string | null; raw_base64: string;
  body_sha256: string; extracted_text: string;
}
export interface HydroDocument {
  provider: "energiforetagen";
  weeks: HydroWeek[];
  reports: HydroReport[];
}
const LANDING = "https://www.energiforetagen.se/statistik/kraftlaget/";
const ARCHIVE = `${LANDING}kraftlagets-arkiv/`;
const PROVIDER = "https://www.energiforetagen.se";
const PDF_PATH = "/globalassets/energiforetagen/statistik/kraftlaget/";
const LIMIT = 2_000_000;
const DAY = 86_400_000;
export const SWEDISH_HYDRO_REQUEST = {
  provider: "energiforetagen" as const, landing_url: LANDING, archive_url: ARCHIVE,
  reports: 6 as const, page: 1 as const,
  semantics: "SE3 stored energy and filling; Sweden completed-week inflow and seasonal comparisons",
};
interface CapturedSource {
  url: string; kind: "html" | "pdf"; http_status: number | null;
  lastModified: string | null; raw_base64: string | null;
  body_sha256: string | null; extracted_text?: string; error_code?: string; truncated?: boolean;
}
interface AcquisitionEvidence {
  request: typeof SWEDISH_HYDRO_REQUEST;
  raw_body: string;
  http_status: number | null;
}
export type HydroAcquisition = AcquisitionEvidence & (
  | { status: "data"; document: HydroDocument }
  | { status: "provider_error" | "transport_error" | "parse_error"; error_code: string }
);
class AcquisitionError extends Error {
  constructor(readonly status: "provider_error" | "transport_error" | "parse_error", readonly code: string,
    readonly httpStatus: number | null = null) { super(code); }
}
function numeric(value: string): number {
  if (!/^(?:\d+(?:,\d+)?|\d{1,3}(?: \d{3})+(?:,\d+)?)$/.test(value.trim())) throw new Error("Invalid Swedish hydro number grouping.");
  const result = Number(value.replaceAll(" ", "").replace(",", "."));
  if (!Number.isFinite(result)) throw new Error("Invalid Swedish hydro number.");
  return result;
}
const stockholm = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function weekEnd(isoYear: number, isoWeek: number): string {
  if (!Number.isInteger(isoWeek) || isoWeek < 1 || isoWeek > 53) throw new Error("Invalid ISO week.");
  const jan4 = Date.UTC(isoYear, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY + (isoWeek - 1) * 7 * DAY;
  if (new Date(monday + 3 * DAY).getUTCFullYear() !== isoYear) throw new Error("Invalid ISO year/week.");
  const exclusiveDate = new Date(monday + 7 * DAY).toISOString().slice(0, 10);
  const nominal = Date.parse(`${exclusiveDate}T00:00:00Z`);
  for (const offset of [1, 2]) {
    const candidate = nominal - offset * 3_600_000;
    const parts = Object.fromEntries(stockholm.formatToParts(candidate).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === exclusiveDate && parts.hour === "00") return new Date(candidate).toISOString();
  }
  throw new Error("Unsupported Swedish week boundary.");
}
function modified(value: string | null): string | null {
  return value !== null && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
/** Required anchors stop table numbers from absorbing the following chart-axis labels. */
export function parseHydroText(text: string, providerModifiedAt: string | null): HydroWeek {
  const normalized = text.replace(/[\u00a0\u202f]/g, " ").replaceAll("\u00ad", "").replace(/\s+/g, " ").trim();
  const inflow = /tillrinnings-?\s*energi för vecka (\d{4})[-–](\d{1,2}) blev ([\d ]+) GWh,? vilket är (\d+(?:,\d+)?) % av medianvärdet/.exec(normalized);
  const header = /\bVecka (\d{1,2})\b.{0,100}?version:\s*([A-Z])\b/.exec(normalized);
  const se3 = /\bSE3\s+(\d+(?:,\d+)?)\s+(\d[\d ]*?)\s+SE4\b/.exec(normalized);
  const filling = /Magasinsändring under veckan från [\d,]+ % till ([\d,]+) %/.exec(normalized);
  const normal = /Medelvärdet för magasins-?\s*fyllnaden under perioden \d{4}[-–]\d{4} är ([\d,]+) %/.exec(normalized);
  if (!inflow || !header || !se3 || !filling || !normal || Number(header[1]) !== Number(inflow[2])) {
    throw new Error("Unsupported Swedish weekly hydro text.");
  }
  const isoYear = Number(inflow[1]), isoWeek = Number(inflow[2]);
  return { isoYear, isoWeek, version: header[2], weekEnd: weekEnd(isoYear, isoWeek),
    providerModifiedAt: modified(providerModifiedAt), se3StoredGwh: numeric(se3[2]), se3FillingPercent: numeric(se3[1]),
    swedenInflowGwh: numeric(inflow[3]), swedenInflowMedianPercent: numeric(inflow[4]),
    swedenFillingPercent: numeric(filling[1]), swedenNormalFillingPercent: numeric(normal[1]) };
}
function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", nbsp: " ", aring: "å", Aring: "Å", auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[A-Za-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return named[name] ?? entity;
  });
}
interface Link { url: string; label: string }
function pdfLinks(html: string): Link[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    try {
      const url = new URL(decodeHtml(match[2]), PROVIDER);
      if (url.origin !== PROVIDER || url.username || url.password || url.search || url.hash ||
        !url.pathname.includes(PDF_PATH) || !url.pathname.endsWith(".pdf")) return [];
      return [{ url: url.toString(), label: decodeHtml(match[3].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() }];
    } catch { return []; }
  });
}
interface WeekLink extends Link { year: number; week: number; version: string }
function historicalLinks(html: string): WeekLink[] {
  const decoded = decodeHtml(html);
  const year = /halvåret\s+(\d{4})/.exec(decoded)?.[1];
  const unique = new Map<string, WeekLink>();
  for (const link of pdfLinks(html)) {
    const week = /\bVecka\s+(\d{1,2})\b/i.exec(link.label);
    const sourceYear = /(?:\/|[-_])(20\d{2})(?:\/|[-_])/.exec(link.url)?.[1] ?? year;
    if (!week || !sourceYear || Number(week[1]) < 1 || Number(week[1]) > 53) continue;
    const version = /\d([a-z])\.pdf$/i.exec(link.url)?.[1].toUpperCase() ?? "A";
    const row: WeekLink = { ...link, year: Number(sourceYear), week: Number(week[1]), version };
    const key = `${row.year}:${row.week}`, held = unique.get(key);
    if (!held || version > held.version) unique.set(key, row);
  }
  return [...unique.values()].sort((a, b) => b.year - a.year || b.week - a.week);
}
function base64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 16_384) result += String.fromCharCode(...bytes.subarray(i, i + 16_384));
  return btoa(result);
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, "0")).join("");
}
async function firstPageText(bytes: Uint8Array): Promise<string> {
  // The pinned serverless build includes its worker, avoiding native canvas and worker-file imports.
  const { getDocumentProxy } = await import("npm:unpdf@1.9.1");
  const pdf = await getDocumentProxy(bytes, { useSystemFonts: false,
    disableFontFace: true, maxImageSize: 0, verbosity: 0 });
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    return content.items.flatMap(item => "str" in item ? [item.str] : []).join(" ");
  } finally {
    await pdf.cleanup();
  }
}

/** Acquisition returns all captured bytes on any failure; it never substitutes a cached report. */
export async function acquireSwedishHydrology(fetchProvider: typeof fetch = fetch,
  extractPdf: (bytes: Uint8Array) => Promise<string> = firstPageText): Promise<HydroAcquisition> {
  const captured: CapturedSource[] = [];
  const deadline = AbortSignal.timeout(60_000);
  async function capture(url: string, kind: "html" | "pdf") {
    const record: CapturedSource = { url, kind, http_status: null, lastModified: null,
      raw_base64: null, body_sha256: null };
    captured.push(record);
    try {
      const response = await fetchProvider(url, { redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]),
        headers: { "user-agent": "Mozilla/5.0", accept: kind === "pdf" ? "application/pdf" : "text/html" } });
      record.http_status = response.status; record.lastModified = response.headers.get("last-modified");
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.length > LIMIT - length) {
            chunks.push(next.value.subarray(0, LIMIT - length)); length = LIMIT; record.truncated = true;
            await reader.cancel(); break;
          }
          length += next.value.length;
          chunks.push(next.value);
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      record.raw_base64 = base64(bytes); record.body_sha256 = await sha256(bytes);
      if (record.truncated) throw new AcquisitionError("provider_error", "hydro_response_too_large", response.status);
      if (!response.ok) throw new AcquisitionError("provider_error", "hydro_http_error", response.status);
      return { record, bytes };
    } catch (error) {
      const failure = error instanceof AcquisitionError ? error : new AcquisitionError("transport_error", "hydro_transport_failed");
      record.error_code = failure.code;
      throw failure;
    }
  }
  try {
    const landing = await capture(LANDING, "html");
    const archive = await capture(ARCHIVE, "html");
    const current = pdfLinks(new TextDecoder().decode(landing.bytes)).find(link => /\/aktuellt-magasinslage-sverige-veckorapport\.pdf$/.test(link.url));
    if (!current) throw new AcquisitionError("parse_error", "hydro_current_link_missing");
    const historical = historicalLinks(new TextDecoder().decode(archive.bytes));
    const reports: HydroReport[] = [], weeks: HydroWeek[] = [];
    async function report(url: string): Promise<HydroWeek> {
      const { record, bytes } = await capture(url, "pdf");
      try {
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Not a PDF.");
        record.extracted_text = await extractPdf(bytes);
        const week = parseHydroText(record.extracted_text, record.lastModified);
        reports.push({ url, lastModified: record.lastModified, raw_base64: record.raw_base64!,
          body_sha256: record.body_sha256!, extracted_text: record.extracted_text });
        weeks.push(week);
        return week;
      } catch {
        record.error_code = "hydro_report_parse_failed";
        throw new AcquisitionError("parse_error", "hydro_report_parse_failed");
      }
    }
    const latest = await report(current.url);
    const currentArchive = historical.find(link => link.year === latest.isoYear && link.week === latest.isoWeek);
    if (currentArchive && currentArchive.version > latest.version) throw new AcquisitionError("parse_error", "hydro_current_revision_not_latest");
    const previous = historical.filter(link => link.year < latest.isoYear || link.year === latest.isoYear && link.week < latest.isoWeek).slice(0, 5);
    if (previous.length !== 5 || historical.some(link => link.year > latest.isoYear || link.year === latest.isoYear && link.week > latest.isoWeek)) {
      throw new AcquisitionError("parse_error", "hydro_archive_coverage_incomplete");
    }
    for (const source of previous) {
      const week = await report(source.url);
      if (week.isoYear !== source.year || week.isoWeek !== source.week || week.version !== source.version) {
        throw new AcquisitionError("parse_error", "hydro_archive_identity_mismatch");
      }
    }
    return { status: "data", http_status: 200, request: SWEDISH_HYDRO_REQUEST,
      raw_body: JSON.stringify({ sources: captured }), document: { provider: "energiforetagen", weeks, reports } };
  } catch (error) {
    const failure = error instanceof AcquisitionError ? error : new AcquisitionError("parse_error", "hydro_index_parse_failed");
    return { status: failure.status, error_code: failure.code, http_status: failure.httpStatus,
      request: SWEDISH_HYDRO_REQUEST, raw_body: JSON.stringify({ sources: captured }) };
  }
}
