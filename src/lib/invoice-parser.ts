/**
 * Rule-based invoice text parser.
 * Extracts structured data from raw text using label-aware regex + heuristics.
 * Supports Swedish and English invoice fields.
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

type MoneyValue = {
  amount: number;
  currency: string | null;
};

const MONTH_MAP: Record<string, string> = {
  januari: '01',
  februari: '02',
  mars: '03',
  april: '04',
  maj: '05',
  juni: '06',
  juli: '07',
  augusti: '08',
  september: '09',
  oktober: '10',
  november: '11',
  december: '12',
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  sept: '09',
  okt: '10',
  nov: '11',
  dec: '12',
  january: '01',
  february: '02',
  march: '03',
  april_en: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september_en: '09',
  october: '10',
  november_en: '11',
  december_en: '12',
};

const SERVICE_MONTH_NAMES_SV: Record<string, string> = {
  '01': 'januari',
  '02': 'februari',
  '03': 'mars',
  '04': 'april',
  '05': 'maj',
  '06': 'juni',
  '07': 'juli',
  '08': 'augusti',
  '09': 'september',
  '10': 'oktober',
  '11': 'november',
  '12': 'december',
};

const FIELD_STOPS = [
  'Invoice',
  'Invoice number',
  'Date of issue',
  'Date due',
  'OpenAI VAT',
  'Bill to',
  'Ship to',
  'Pay online',
  'Description',
  'Qty',
  'Unit price',
  'Tax',
  'Amount',
  'Subtotal',
  'Amount due',
  'Faktura',
  'Sida',
  'Fakturauppgifter',
  'Beställningsdatum',
  'Ordernr',
  'Betald',
  'Referens-ID för betalning',
  'Såld av',
  'Fakturadatum/Leveransdatum',
  'Fakturanr',
  'Fakturanummer',
  'Summa att betala',
  'Faktureringsadress',
  'Leveransadress',
  'Beställningsinformation',
  'Beskrivning',
  'Account Number',
  'Invoice Number',
  'Invoice Date',
  'Service Month',
  'Stripe VAT Number',
  'Customer VAT Number',
  'Bill to',
  'Transfer Currency',
  'Fee Amount',
  'VAT',
  'Invoicing',
  'Total VAT',
  'Total VAT in EUR',
  'Total fees in EUR',
  'Total',
  'Debited from your Balance',
  'Amount Due',
  'Exchange Rates',
  'Questions?',
  'Page',
];

const GROSS_KW = [
  /att\s*betala/i,
  /totalt?\s*(belopp|att)/i,
  /total\s*(amount|due)/i,
  /summa/i,
  /slutsumma/i,
  /brutto/i,
  /gross/i,
  /amount\s*due/i,
];
const VAT_KW = [
  /moms/i,
  /varav\s*moms/i,
  /vat/i,
];
const NET_KW = [
  /netto/i,
  /exkl\.?\s*moms/i,
  /ex\.?\s*vat/i,
  /net/i,
  /subtotal/i,
  /delsumma/i,
  /summa\s*exkl/i,
];
const AMOUNT_RE = /-?\d[\d\s.,]*\d|-?\d/g;
const MONEY_RE = /-?\d[\d\s.,]*\d\s*(?:kr|sek|€|eur|\$|usd)?/gi;
const COMPANY_SUFFIX_RE = /(.+?(?:AB|ApS|AS|BV|Corp\.?|Corporation|GmbH|Inc\.?|Limited|LLC|Ltd\.?|Oy|PLC|S\.?A\.?R\.?L\.?|S\.?R\.?L\.?))(?:\s|$)/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanSupplierName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[;:]+$/, '');
}

function cleanProductName(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*ASIN:.*$/i, '')
    .split(',')[0]
    .trim();
}

function parseAmount(text: string): number | null {
  let c = text
    .replace(/\u00a0/g, ' ')
    .replace(/(?:kr|sek|eur|usd|€|\$)/gi, '')
    .replace(/\s/g, '')
    .trim();
  if (!c) return null;

  const negative = c.startsWith('-');
  c = c.replace(/^-/, '');

  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(c)) {
    c = c.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(c)) {
    c = c.replace(/,/g, '');
  } else if (/^\d+(,\d{1,2})?$/.test(c)) {
    c = c.replace(',', '.');
  }

  const n = parseFloat(c);
  if (Number.isNaN(n)) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

function parseDate(text: string): string | null {
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  m = text.match(/([A-Za-zÅÄÖåäö]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const monthKey = m[1].toLowerCase();
    const month = MONTH_MAP[monthKey] || MONTH_MAP[`${monthKey}_en`];
    if (month) return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
  }

  for (const [name, num] of Object.entries(MONTH_MAP)) {
    const re = new RegExp(`(\\d{1,2})\\s+${name.replace('_en', '')}\\s+(\\d{4})`, 'i');
    m = text.match(re);
    if (m) return `${m[2]}-${num}-${m[1].padStart(2, '0')}`;
  }

  return null;
}

function parseMonthYear(text: string): { year: string; month: string } | null {
  const m = text.match(/([A-Za-zÅÄÖåäö]+)\s+(\d{4})/);
  if (!m) return null;
  const monthKey = m[1].toLowerCase();
  const month = MONTH_MAP[monthKey] || MONTH_MAP[`${monthKey}_en`];
  if (!month) return null;
  return { year: m[2], month };
}

function extractLabelValue(text: string, labels: string[], stops = FIELD_STOPS): string | null {
  const stopPattern = stops.map(escapeRegExp).join('|');
  for (const label of labels) {
    const re = new RegExp(
      `${escapeRegExp(label)}\\s*:?\\s*(.+?)(?=\\s+(?:${stopPattern})\\b|$)`,
      'i',
    );
    const match = re.exec(text);
    if (match) {
      const value = match[1].trim();
      if (value) return value;
    }
  }
  return null;
}

function extractSectionAfterLabel(text: string, labels: string[], stops: string[], maxChars = 120): string | null {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\s)${escapeRegExp(label)}\\s*:?\\s+`, 'i');
    const match = re.exec(text);
    if (!match) continue;

    const start = match.index + match[0].length;
    const tail = text.slice(start, start + maxChars);
    let end = tail.length;

    for (const stop of stops) {
      const stopMatch = new RegExp(`\\s${escapeRegExp(stop)}\\b`, 'i').exec(tail);
      if (stopMatch && stopMatch.index < end) end = stopMatch.index;
    }

    const section = tail.slice(0, end).trim();
    if (section) return section;
  }
  return null;
}

function parseMoneyValues(text: string): MoneyValue[] {
  const values: MoneyValue[] = [];

  for (const match of text.matchAll(MONEY_RE)) {
    const chunk = match[0].trim();
    const amount = parseAmount(chunk);
    if (amount === null) continue;

    let currency: string | null = null;
    if (/kr|sek/i.test(chunk)) currency = 'SEK';
    else if (/€|eur/i.test(chunk)) currency = 'EUR';
    else if (/\$|usd/i.test(chunk)) currency = 'USD';

    values.push({ amount, currency });
  }

  return values;
}

function selectAmount(values: MoneyValue[], preferredCurrency: string | null): number | null {
  if (!values.length) return null;
  if (preferredCurrency) {
    const preferred = values.find((value) => value.currency === preferredCurrency);
    if (preferred) return preferred.amount;
  }
  return values[0].amount;
}

function extractMoneyForLabel(text: string, labels: string[], stops: string[], preferredCurrency: string | null): number | null {
  for (const label of labels) {
    const re = new RegExp(
      `(?:^|\\s)${escapeRegExp(label)}\\s*:?\\s+(?=(?:SEK|EUR|USD|kr|€|\\$|-?\\d[\\d\\s.,]*[.,]\\d{2}))`,
      'i',
    );
    const match = re.exec(text);
    if (!match) continue;

    const start = match.index + match[0].length;
    const tail = text.slice(start, start + 120);
    let end = tail.length;

    for (const stop of stops) {
      const stopMatch = new RegExp(`\\s${escapeRegExp(stop)}\\b`, 'i').exec(tail);
      if (stopMatch && stopMatch.index < end) end = stopMatch.index;
    }

    const section = tail.slice(0, end).trim();
    if (!section) continue;

    const amount = selectAmount(parseMoneyValues(section), preferredCurrency);
    if (amount !== null) return amount;
  }

  return null;
}

function inferCurrency(text: string): string | null {
  const transferCurrency = extractLabelValue(text, ['Transfer Currency', 'Currency']);
  if (transferCurrency) {
    const codeMatch = transferCurrency.match(/\b(SEK|EUR|USD)\b/i);
    if (codeMatch) return codeMatch[1].toUpperCase();
    if (/kr/i.test(transferCurrency)) return 'SEK';
    if (/€/.test(transferCurrency)) return 'EUR';
    if (/\$/.test(transferCurrency)) return 'USD';
  }

  const usdDueBanner = text.match(/\$[\d.,]+\s+USD\s+due\b/i);
  if (usdDueBanner) return 'USD';

  const amountDueSection = extractSectionAfterLabel(
    text,
    ['Amount due', 'Total due'],
    ['Pay online', 'Description', 'Tax to be paid on reverse charge basis', 'Page'],
    80,
  );
  const amountDueValues = amountDueSection ? parseMoneyValues(amountDueSection) : [];
  if (amountDueValues.some((value) => value.currency)) {
    return amountDueValues.find((value) => value.currency)?.currency || null;
  }

  const totalSection = extractSectionAfterLabel(
    text,
    ['Total'],
    ['Debited from your Balance', 'Amount Due', 'Exchange Rates', 'Questions?', 'Page'],
  );
  const totalValues = totalSection ? parseMoneyValues(totalSection) : [];
  if (totalValues.some((value) => value.currency)) {
    return totalValues.find((value) => value.currency)?.currency || null;
  }

  const currencyCounts = {
    SEK: (text.match(/\bSEK\b|(?<![A-Z])kr\b/gi) || []).length,
    EUR: (text.match(/\bEUR\b|€/g) || []).length,
    USD: (text.match(/\bUSD\b|\$/g) || []).length,
  };

  if (currencyCounts.USD > 0 && currencyCounts.USD >= currencyCounts.SEK && currencyCounts.USD >= currencyCounts.EUR) return 'USD';
  if (currencyCounts.EUR > 0 && currencyCounts.EUR >= currencyCounts.SEK) return 'EUR';
  if (currencyCounts.SEK > 0) return 'SEK';
  return null;
}

function extractSupplierName(lines: string[], normalizedText: string): string | null {
  const openAiHeaderMatch = normalizedText.match(/OpenAI OpCo,\s*LLC/i);
  if (openAiHeaderMatch) return 'OpenAI OpCo, LLC';

  const soldBySection = extractSectionAfterLabel(
    normalizedText,
    ['Såld av', 'Sold by'],
    ['Moms #', 'Moms', 'VAT', 'Fakturadatum', 'Invoice Date', 'Beställningsinformation', 'Billing Address', 'Leveransadress'],
    160,
  );
  if (soldBySection) {
    const company = soldBySection.match(COMPANY_SUFFIX_RE);
    if (company) return cleanSupplierName(company[1]);
    return cleanSupplierName(soldBySection.split(/\s{2,}/)[0]);
  }

  const leadingStorefront = normalizedText.match(/^(.+?)\s+(?:Receipt(?:\s*\/\s*VAT)?\s+Invoice|Tax Invoice|VAT Invoice)\b/i);
  if (leadingStorefront) return cleanSupplierName(leadingStorefront[1]);

  const header = extractSectionAfterLabel(
    normalizedText,
    ['Tax Invoice', 'Invoice', 'Faktura'],
    ['Account Number', 'Invoice Number', 'Fakturanummer', 'Bill to'],
    220,
  );
  if (header) {
    const company = header.match(COMPANY_SUFFIX_RE);
    if (company) return cleanSupplierName(company[1]);
    const leading = header.match(/([A-ZÅÄÖ][\w,&.\- ]{2,80})/);
    if (leading) return cleanSupplierName(leading[1]);
  }

  for (const line of lines.slice(0, 8)) {
    if (line.length < 3 || line.length > 80) continue;
    if (/^\d/.test(line) || /(invoice|faktura|bill to|account number)/i.test(line)) continue;
    return cleanSupplierName(line);
  }

  return null;
}

function extractInvoiceNumber(text: string): string | null {
  const direct = extractLabelValue(text, ['Invoice Number', 'Invoice No', 'Invoice #', 'Fakturanr', 'Fakturanummer']);
  if (direct) {
    const compact = direct.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
    const multiPartToken = compact.match(/[A-Z0-9][A-Z0-9._/-]*(?:\s+[A-Z0-9][A-Z0-9._/-]*){0,3}/i);
    if (multiPartToken) return multiPartToken[0].replace(/\s+/g, '-');
  }

  const invPats = [
    /invoice\s*(?:nr|number|no)?\.?\s*:?\s*([A-Z0-9][\w-]{2,40})/i,
    /faktura(?:nr|nummer|no)\.?\s*:?\s*([A-Z0-9][\w-]{2,40})/i,
  ];
  for (const pattern of invPats) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function extractDate(text: string, labels: string[]): string | null {
  const value = extractLabelValue(text, labels);
  return value ? parseDate(value) : null;
}

function extractProductName(text: string): string | null {
  const amazonMatch = text.match(/Delsumma för artikel \(inkl\. moms\)\s+(.+?)\s+ASIN:/i);
  if (amazonMatch) {
    const productName = cleanProductName(amazonMatch[1]);
    return productName || null;
  }

  const descriptionMatch = text.match(/Beskrivning\s+Antal\s+Enhetspris.*?\s+(.+?)\s+ASIN:/i);
  if (descriptionMatch) {
    const productName = cleanProductName(descriptionMatch[1]);
    return productName || null;
  }

  const fallbackMatch = text.match(/(?:PRODUCT DESCRIPTION|Beskrivning)\s+.+?\s+([A-ZÅÄÖa-zåäö0-9][^€$]{5,120}?)\s+(?:ASIN:|Fraktavgifter|Shipping Amount)/i);
  if (fallbackMatch) {
    const productName = cleanProductName(fallbackMatch[1]);
    return productName || null;
  }

  return null;
}

function extractDescription(supplierName: string | null, rawText: string): string | null {
  const description = generateDescription(supplierName, rawText);
  return description || null;
}

function extractSwedishVatSummary(text: string): { vatRate: number | null; netAmount: number | null; vatAmount: number | null } | null {
  const match = text.match(/Delsumma moms\s+(\d{1,2})\s*%\s+([\d\s.,]+)\s*kr\s+([\d\s.,]+)\s*kr/i);
  if (!match) return null;

  return {
    vatRate: Number(match[1]),
    netAmount: parseAmount(`${match[2]} kr`),
    vatAmount: parseAmount(`${match[3]} kr`),
  };
}

/* ── Main parser ────────────────────────────────────── */

export function parseInvoiceText(rawText: string): ParsedInvoice {
  const conf: Record<string, number> = {};
  const normalizedText = normalizeWhitespace(rawText);
  const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);

  const supplierName = extractSupplierName(lines, normalizedText);
  if (supplierName) conf.supplierName = 0.9;

  let orgNumber: string | null = null;
  const orgMatch = normalizedText.match(/(?:org\.?\s*(?:nr|nummer|no)?\.?\s*:?\s*)(\d{6}-?\d{4})/i);
  if (orgMatch) orgNumber = orgMatch[1];

  let vatNumber: string | null = null;
  const vatValue = extractLabelValue(normalizedText, ['VAT Number', 'VAT No', 'VAT Nr', 'Stripe VAT Number', 'VAT ID', 'Moms #', 'momsnummer']);
  if (vatValue) {
    const vatMatch = vatValue.match(/\b[A-Z]{2}\s?\d[\dA-Z ]+\b/i);
    if (vatMatch) vatNumber = vatMatch[0].replace(/\s+/g, ' ').trim();
  } else {
    const fallbackVatMatch = normalizedText.match(/VAT ID:\s*([A-Z]{2}\s?\d[\dA-Z ]+)/i);
    if (fallbackVatMatch) vatNumber = fallbackVatMatch[0].replace(/\s+/g, ' ').trim();
  }

  const invoiceNumber = extractInvoiceNumber(normalizedText);
  if (invoiceNumber) conf.invoiceNumber = 0.95;

  const invoiceDate = extractDate(normalizedText, ['Invoice Date', 'Fakturadatum', 'Fakturadatum/Leveransdatum', 'Date']);
  if (invoiceDate) conf.invoiceDate = 0.95;

  const dueDate = extractDate(normalizedText, ['Due Date', 'Förfallodatum', 'Förfaller']);
  if (dueDate) conf.dueDate = 0.9;

  const currency = inferCurrency(normalizedText) || 'SEK';
  conf.currency = 0.9;

  let vatAmount = extractMoneyForLabel(
    normalizedText,
    ['Total VAT', 'VAT Amount', 'Varav moms', 'Delsumma moms', 'Moms'],
    ['Total', 'Amount Due', 'Total VAT in EUR', 'Exchange Rates', 'Questions?'],
    currency,
  );
  if (vatAmount !== null) conf.vatAmount = 0.95;
  else if (/vat exempt|reverse charge/i.test(normalizedText)) {
    vatAmount = 0;
    conf.vatAmount = 0.85;
  }

  let grossAmount = extractMoneyForLabel(
    normalizedText,
    ['Total', 'Amount due', 'Amount Due', 'Total Amount', 'Att betala', 'Summa att betala'],
    ['Debited from your Balance', 'Exchange Rates', 'Questions?', 'Page'],
    currency,
  );
  if (grossAmount !== null) conf.grossAmount = 0.95;

  let netAmount = extractMoneyForLabel(
    normalizedText,
    ['Net Amount', 'Netto', 'Subtotal', 'Delsumma för artikel (exkl. moms)', 'Delsumma', 'Exkl moms'],
    ['VAT', 'Moms', 'Total', 'Amount Due', 'Questions?'],
    currency,
  );
  if (netAmount !== null) conf.netAmount = 0.9;

  const swedishVatSummary = extractSwedishVatSummary(normalizedText);
  if (swedishVatSummary) {
    if (netAmount === null && swedishVatSummary.netAmount !== null) {
      netAmount = swedishVatSummary.netAmount;
      conf.netAmount = 0.95;
    }
    if (vatAmount === null && swedishVatSummary.vatAmount !== null) {
      vatAmount = swedishVatSummary.vatAmount;
      conf.vatAmount = 0.95;
    }
  }

  if (grossAmount === null || vatAmount === null || netAmount === null) {
    for (const line of lines) {
      const amounts = line.match(AMOUNT_RE);
      if (!amounts) continue;
      const last = parseAmount(amounts[amounts.length - 1]);
      if (last === null || last < 1) continue;

      if (grossAmount === null && GROSS_KW.some((kw) => kw.test(line)) && last >= 0) {
        grossAmount = last;
        conf.grossAmount = Math.max(conf.grossAmount || 0, 0.6);
      }
      if (vatAmount === null && VAT_KW.some((kw) => kw.test(line)) && last >= 0) {
        vatAmount = last;
        conf.vatAmount = Math.max(conf.vatAmount || 0, 0.5);
      }
      if (netAmount === null && NET_KW.some((kw) => kw.test(line)) && last >= 0) {
        netAmount = last;
        conf.netAmount = Math.max(conf.netAmount || 0, 0.5);
      }
    }
  }

  if (grossAmount !== null && vatAmount !== null && netAmount === null) {
    netAmount = Math.round((grossAmount - vatAmount) * 100) / 100;
    conf.netAmount = 0.95;
  } else if (netAmount !== null && vatAmount !== null && grossAmount === null) {
    grossAmount = Math.round((netAmount + vatAmount) * 100) / 100;
    conf.grossAmount = 0.95;
  } else if (grossAmount !== null && vatAmount === 0 && netAmount === null) {
    netAmount = grossAmount;
    conf.netAmount = 0.95;
  }

  let vatRate: number | null = null;
  if (netAmount !== null && vatAmount !== null) {
    if (vatAmount === 0) {
      vatRate = 0;
    } else if (netAmount > 0) {
      const ratio = vatAmount / netAmount;
      if (Math.abs(ratio - 0.25) < 0.02) vatRate = 25;
      else if (Math.abs(ratio - 0.12) < 0.02) vatRate = 12;
      else if (Math.abs(ratio - 0.06) < 0.02) vatRate = 6;
    }
  }
  if (vatRate === null && swedishVatSummary?.vatRate != null) {
    vatRate = swedishVatSummary.vatRate;
  }

  const description = extractDescription(supplierName, normalizedText);
  if (description) conf.description = 0.85;

  return {
    supplierName,
    invoiceNumber,
    invoiceDate,
    dueDate,
    grossAmount,
    netAmount,
    vatAmount,
    vatRate,
    currency,
    orgNumber,
    vatNumber,
    description,
    confidence: conf,
  };
}

/* ── Supplier fuzzy matching ────────────────────────── */

export function fuzzyMatchSupplier(
  name: string,
  suppliers: { id: string; name: string }[],
): { id: string; name: string; score: number } | null {
  if (!name || !suppliers.length) return null;
  const norm = (value: string) => value.toLowerCase().replace(/[^a-zåäö0-9]/g, '');
  const normalizedName = norm(name);
  let best: { id: string; name: string; score: number } | null = null;

  for (const supplier of suppliers) {
    const normalizedSupplier = norm(supplier.name);
    if (normalizedName === normalizedSupplier) return { ...supplier, score: 1.0 };
    if (normalizedName.includes(normalizedSupplier) || normalizedSupplier.includes(normalizedName)) {
      const score =
        Math.min(normalizedName.length, normalizedSupplier.length) /
          Math.max(normalizedName.length, normalizedSupplier.length) +
        0.3;
      if (!best || score > best.score) {
        best = { ...supplier, score: Math.min(0.95, score) };
      }
    }
  }

  return best && best.score > 0.5 ? best : null;
}

/* ── Auto description ───────────────────────────────── */

export function generateDescription(supplierName: string | null, rawText: string): string {
  const text = normalizeWhitespace(rawText);
  const productName = extractProductName(text);

  if ((supplierName?.match(/\bAmazon\b/i) || /amazon\.se\/contact-us|moms deklarerat av amazon|fakturauppgifter/i.test(text)) && productName) {
    return `${productName} (Amazon inköp)`;
  }

  const supplier =
    supplierName?.match(/\bStripe\b/i)
      ? 'Stripe'
      : supplierName?.replace(/\s+/g, ' ').trim() || '';

  const serviceMonthValue =
    extractLabelValue(text, ['Service Month', 'Tjänsteperiod']) ||
    text.match(/([A-Za-zÅÄÖåäö]{3,9}\s+\d{4})\s+—\s+Page/i)?.[1] ||
    text.match(/(\d{4})-(\d{2})/)?.[0] ||
    null;

  let serviceMonth = '';
  if (serviceMonthValue) {
    const parsedMonth = serviceMonthValue.includes('-')
      ? (() => {
          const match = serviceMonthValue.match(/(\d{4})-(\d{2})/);
          return match ? { year: match[1], month: match[2] } : null;
        })()
      : parseMonthYear(serviceMonthValue);

    if (parsedMonth) {
      const monthName = SERVICE_MONTH_NAMES_SV[parsedMonth.month];
      if (monthName) serviceMonth = `${monthName} ${parsedMonth.year}`;
    }
  }

  let context = '';
  if (/stripe processing fees|fees for invoicing|stripe fees|fee amount|avgift/i.test(text)) {
    context = 'avgifter';
  } else if (/amazon/i.test(text) && productName) {
    context = productName;
  } else if (/subscription|prenumeration|abonnemang/i.test(text)) {
    context = 'abonnemang';
  } else if (/hosting/i.test(text)) {
    context = 'hosting';
  } else if (/konsult|consult/i.test(text)) {
    context = 'konsulttjänster';
  } else if (/frakt|shipping/i.test(text)) {
    context = 'frakt';
  }

  const parts = [supplier, context, serviceMonth].filter(Boolean);
  return parts.join(' ').trim();
}
