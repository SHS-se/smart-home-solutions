/**
 * Rule-based invoice text parser.
 * Extracts structured data from raw text using regex + heuristics.
 * Supports Swedish, English, and basic German/French keywords.
 */

export interface ParsedInvoice {
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  grossAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  vatRate: number | null;
  currency: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  description: string | null;
  confidence: Record<string, number>;
}

/* ── Amount parsing ─────────────────────────────────── */

function parseAmount(text: string): number | null {
  let c = text.replace(/\s/g, '').replace(/\u00a0/g, '');
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(c)) {
    c = c.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(c)) {
    c = c.replace(/,/g, '');
  } else if (/^\d+(,\d{1,2})?$/.test(c)) {
    c = c.replace(',', '.');
  }
  const n = parseFloat(c);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

/* ── Date parsing ───────────────────────────────────── */

const MONTH_MAP: Record<string, string> = {
  januari: '01', februari: '02', mars: '03', april: '04',
  maj: '05', juni: '06', juli: '07', augusti: '08',
  september: '09', oktober: '10', november: '11', december: '12',
  january: '01', february: '02', march: '03', may: '05',
  june: '06', july: '07', august: '08', october: '10',
};

function parseDate(text: string): string | null {
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  for (const [name, num] of Object.entries(MONTH_MAP)) {
    const re = new RegExp(`(\\d{1,2})\\s+${name}\\s+(\\d{4})`, 'i');
    m = text.match(re);
    if (m) return `${m[2]}-${num}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/* ── Keyword patterns ───────────────────────────────── */

const GROSS_KW = [
  /att\s*betala/i, /totalt?\s*(belopp|att)/i, /total\s*(amount|due)/i,
  /summa/i, /slutsumma/i, /brutto/i, /gross/i, /amount\s*due/i,
  /gesamtbetrag/i, /total\s*ttc/i,
];
const VAT_KW = [
  /moms\s*\(?25/i, /moms\s*\(?12/i, /moms\s*\(?6/i, /moms/i,
  /varav\s*moms/i, /vat/i, /mwst/i, /tva/i,
];
const NET_KW = [
  /netto/i, /exkl\.?\s*moms/i, /ex\.?\s*vat/i, /net/i,
  /subtotal/i, /delsumma/i, /summa\s*exkl/i,
];
const AMOUNT_RE = /[\d\s.,]+(?:\d)/g;

/* ── Main parser ────────────────────────────────────── */

export function parseInvoiceText(rawText: string): ParsedInvoice {
  const conf: Record<string, number> = {};
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Supplier name – first meaningful non-keyword line
  let supplierName: string | null = null;
  for (const line of lines.slice(0, 6)) {
    if (line.length > 3 && line.length < 80 && !/^\d/.test(line) && !/faktur/i.test(line)) {
      supplierName = line;
      conf.supplierName = 0.5;
      break;
    }
  }

  // Org number
  let orgNumber: string | null = null;
  const orgM = rawText.match(/(?:org\.?\s*(?:nr|nummer|no)?\.?\s*:?\s*)(\d{6}-?\d{4})/i);
  if (orgM) { orgNumber = orgM[1]; conf.supplierName = 0.8; }

  // VAT number
  let vatNumber: string | null = null;
  const vatNM = rawText.match(/(?:vat\s*(?:nr|number|no)?\.?\s*:?\s*)(SE\d{10,12})/i) || rawText.match(/(SE\d{10,12})/);
  if (vatNM) vatNumber = vatNM[1];

  // Invoice number
  let invoiceNumber: string | null = null;
  const invPats = [
    /faktura\s*(?:nr|nummer|no)?\.?\s*:?\s*([A-Z0-9][\w-]{2,20})/i,
    /invoice\s*(?:nr|number|no)?\.?\s*:?\s*([A-Z0-9][\w-]{2,20})/i,
    /rechnung\s*(?:nr|nummer)?\.?\s*:?\s*([A-Z0-9][\w-]{2,20})/i,
  ];
  for (const p of invPats) { const m = rawText.match(p); if (m) { invoiceNumber = m[1]; conf.invoiceNumber = 0.7; break; } }

  // Dates
  let invoiceDate: string | null = null;
  let dueDate: string | null = null;
  const datePats = [/fakturadatum\s*:?\s*(.{8,20})/i, /invoice\s*date\s*:?\s*(.{8,20})/i, /datum\s*:?\s*(.{8,20})/i];
  for (const p of datePats) { const m = rawText.match(p); if (m) { const d = parseDate(m[1]); if (d) { invoiceDate = d; conf.invoiceDate = 0.8; break; } } }
  const duePats = [/förfallodatum\s*:?\s*(.{8,20})/i, /förfaller\s*:?\s*(.{8,20})/i, /due\s*date\s*:?\s*(.{8,20})/i];
  for (const p of duePats) { const m = rawText.match(p); if (m) { const d = parseDate(m[1]); if (d) { dueDate = d; conf.dueDate = 0.7; break; } } }

  // Amounts
  let grossAmount: number | null = null;
  let vatAmount: number | null = null;
  let netAmount: number | null = null;

  for (const line of lines) {
    const amounts = line.match(AMOUNT_RE);
    if (!amounts) continue;
    const last = parseAmount(amounts[amounts.length - 1]);
    if (last === null) continue;
    for (const kw of GROSS_KW) { if (kw.test(line) && last > 0 && (!grossAmount || last > grossAmount)) { grossAmount = last; conf.grossAmount = 0.7; } }
    for (const kw of VAT_KW) { if (kw.test(line) && last >= 0) { vatAmount = last; conf.vatAmount = 0.6; } }
    for (const kw of NET_KW) { if (kw.test(line) && last > 0) { netAmount = last; conf.netAmount = 0.6; } }
  }

  // Infer missing amounts
  if (grossAmount && vatAmount && !netAmount) {
    netAmount = Math.round((grossAmount - vatAmount) * 100) / 100;
    conf.netAmount = 0.9;
  } else if (grossAmount && !vatAmount && !netAmount) {
    vatAmount = Math.round(grossAmount * 0.2 * 100) / 100;
    netAmount = Math.round(grossAmount * 0.8 * 100) / 100;
    conf.vatAmount = 0.3;
    conf.netAmount = 0.3;
  } else if (netAmount && vatAmount && !grossAmount) {
    grossAmount = Math.round((netAmount + vatAmount) * 100) / 100;
    conf.grossAmount = 0.9;
  }

  // VAT rate
  let vatRate: number | null = null;
  if (netAmount && vatAmount && netAmount > 0) {
    const r = vatAmount / netAmount;
    if (Math.abs(r - 0.25) < 0.02) vatRate = 25;
    else if (Math.abs(r - 0.12) < 0.02) vatRate = 12;
    else if (Math.abs(r - 0.06) < 0.02) vatRate = 6;
  }

  // Currency
  let currency: string | null = 'SEK';
  if (/EUR|€/.test(rawText)) currency = 'EUR';
  else if (/USD|\$/.test(rawText)) currency = 'USD';

  return {
    supplierName, invoiceNumber, invoiceDate, dueDate,
    grossAmount, netAmount, vatAmount, vatRate,
    currency, orgNumber, vatNumber, description: null,
    confidence: conf,
  };
}

/* ── Supplier fuzzy matching ────────────────────────── */

export function fuzzyMatchSupplier(
  name: string,
  suppliers: { id: string; name: string }[],
): { id: string; name: string; score: number } | null {
  if (!name || !suppliers.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-zåäö0-9]/g, '');
  const nn = norm(name);
  let best: { id: string; name: string; score: number } | null = null;

  for (const s of suppliers) {
    const ns = norm(s.name);
    if (nn === ns) return { ...s, score: 1.0 };
    if (nn.includes(ns) || ns.includes(nn)) {
      const sc = Math.min(nn.length, ns.length) / Math.max(nn.length, ns.length) + 0.3;
      if (!best || sc > best.score) best = { ...s, score: Math.min(0.95, sc) };
    }
  }
  return best && best.score > 0.5 ? best : null;
}

/* ── Auto description ───────────────────────────────── */

export function generateDescription(supplierName: string | null, rawText: string): string {
  const parts: string[] = [];
  if (supplierName) parts.push(supplierName);
  const ctx = [/prenumeration/i, /licens/i, /abonnemang/i, /subscription/i, /hosting/i, /material/i, /frakt/i, /konsult/i, /tjänst/i];
  for (const p of ctx) { const m = rawText.match(p); if (m) { parts.push(m[0].toLowerCase()); break; } }
  const dm = rawText.match(/(\d{4})-(\d{2})/);
  if (dm) {
    const months = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
    const mi = parseInt(dm[2]) - 1;
    if (mi >= 0 && mi < 12) parts.push(`${months[mi]} ${dm[1]}`);
  }
  return parts.join(' ').trim();
}
