/**
 * Rule-based invoice text parser.
 * Extracts structured data from raw text using label-aware regex + heuristics.
 * Supports Swedish and English invoice fields.
 */

export interface ParsedInvoice {
  supplierName: string | null;
  supplierCountry: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  /** 'receipt' when the layout shows the document is already paid; null = no opinion */
  documentType: 'receipt' | null;
  grossAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  vatRate: number | null;
  currency: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  description: string | null;
  confidence: Record<string, number>;
  fingerprint: InvoiceFingerprint;
  parserReviewRequired: boolean;
  parserReviewReasons: string[];
}

export interface InvoiceFingerprint {
  id: string;
  label: string;
  recognized: boolean;
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
  'Kundnummer',
  'Betalning',
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
const MONEY_RE = /-?\d[\d\s.,]*\d\s*(?::-\b|kr|sek|€|eur|\$|usd)?/gi;
const COMPANY_SUFFIX_RE = /([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.,'’\- ]{1,120}?(?:AB|ApS|AS|BV|Corp\.?|Corporation|GmbH|Inc\.?|Incorporated|Limited|LLC|Ltd\.?|Oy|PBC|PLC|S\.?A\.?R\.?L\.?|S\.?R\.?L\.?))(?:\s|$)/i;
const VAT_NUMBER_RE = /\b([A-Z]{2}\s?[A-Z0-9]{2,14})\b/i;
const SUPPLIER_COUNTRY_CODE_SET = new Set([
  ...['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'],
  'CN',
  'GB',
  'NO',
  'CH',
  'SG',
  'US',
]);
const COUNTRY_NAME_TO_CODE: Array<[string, string]> = [
  ['united states', 'US'],
  ['usa', 'US'],
  ['sverige', 'SE'],
  ['sweden', 'SE'],
  ['ireland', 'IE'],
  ['luxemburg', 'LU'],
  ['luxembourg', 'LU'],
  ['nederländerna', 'NL'],
  ['netherlands', 'NL'],
  ['frankrike', 'FR'],
  ['france', 'FR'],
  ['bulgarien', 'BG'],
  ['bulgaria', 'BG'],
  ['kina', 'CN'],
  ['china', 'CN'],
  ['singapore', 'SG'],
  ['schweiz', 'CH'],
  ['switzerland', 'CH'],
  ['norge', 'NO'],
  ['norway', 'NO'],
  ['storbritannien', 'GB'],
  ['united kingdom', 'GB'],
];

const ORDER_DOCUMENT_FINGERPRINTS = new Set([
  'cs_megastore_order_summary',
  'digikey_order_acknowledgement',
]);

const KNOWN_INVOICE_FINGERPRINTS: Array<{
  id: string;
  label: string;
  match: (text: string) => boolean;
}> = [
  {
    id: 'apple_subscription_receipt',
    label: 'Apple subscription receipt',
    match: (text) => /Apple Distribution International Ltd\./i.test(text) && /Apple Account:/i.test(text) && /Billing and Payment/i.test(text) && /Document:/i.test(text),
  },
  {
    id: 'cs_megastore_order_summary',
    label: 'CS Megastore order summary',
    match: (text) => /cs megastore ab/i.test(text) && /Beställningssammanfattning/i.test(text) && /Ordernr\.:/i.test(text) && /Total inkl\. moms/i.test(text),
  },
  {
    id: 'supabase_invoice',
    label: 'Supabase invoice',
    match: (text) => /Supabase Pte\. Ltd\./i.test(text) && /Invoice number/i.test(text) && /Invoice date/i.test(text) && /Amount due/i.test(text),
  },
  {
    id: 'coolshop_receipt',
    label: 'Coolshop receipt',
    match: (text) => /Coolshop\.se/i.test(text) && /Kvitto nr\.:/i.test(text) && /Kvittodatum:/i.test(text) && /Totalt inkl\. MOMS:/i.test(text),
  },
  {
    id: 'digikey_invoice',
    label: 'DigiKey invoice',
    match: (text) => /Fakturanummer\s+\d+\s+Invoice\s*#/i.test(text) && /www\.digikey\.com/i.test(text) && /Completed Salesorder/i.test(text) && /Total charged to Paypal/i.test(text),
  },
  {
    id: 'digikey_order_acknowledgement',
    label: 'DigiKey order acknowledgement',
    match: (text) => /PO Acknowledgement\s+\d+/i.test(text) && /www\.digikey\.com/i.test(text) && /DIGI-KEY\s+ELECTRONICS/i.test(text),
  },
  {
    id: 'global_e_invoice',
    label: 'Global-e VAT invoice',
    match: (text) => /Global-e NL B\.V/i.test(text) && /Date\/Tax Point:/i.test(text) && /Total Invoice Amount/i.test(text),
  },
  {
    id: 'elbutik_scandinavia_invoice',
    label: 'Elbutik Scandinavia invoice',
    match: (text) => (
      /elbutik scandinavia ab/i.test(text) &&
      /info@elbutik\.se/i.test(text) &&
      /faktura nr\s+datum\s+kund nr\s+ordernr/i.test(text) &&
      /att betala/i.test(text)
    ),
  },
  {
    id: 'cs_megastore_receipt',
    label: 'CS Megastore receipt',
    match: (text) => (
      /cs megastore ab/i.test(text) &&
      /kvittonr\.?/i.test(text) &&
      /total inkl\. moms/i.test(text) &&
      /ordern är betald/i.test(text)
    ),
  },
  {
    id: 'lunar_bank_invoice',
    label: 'Lunar Bank invoice',
    match: (text) => (
      /lunar bank a\/s/i.test(text) &&
      /support@lunar\.app/i.test(text) &&
      /invoice no\s*:/i.test(text) &&
      /cvr\s*:\s*39697696/i.test(text)
    ),
  },
  {
    id: 'zai_receipt',
    label: 'Z.ai receipt',
    match: (text) => (
      /user_feedback@z\.ai/i.test(text) &&
      /receipt number/i.test(text) &&
      /invoice number/i.test(text) &&
      /amount paid/i.test(text)
    ),
  },
  {
    id: 'stripe_tax_invoice',
    label: 'Stripe tax invoice',
    match: (text) => /tax invoice/i.test(text) && /stripe vat number/i.test(text) && /service month/i.test(text),
  },
  {
    id: 'mnu_invoice',
    label: 'M.nu invoice',
    match: (text) => /info@m\.nu/i.test(text) && /fakturanr\/order-id/i.test(text) && /momsreg\.nr/i.test(text),
  },
  {
    id: 'amazon_sweden_invoice',
    label: 'Amazon Sweden invoice',
    match: (text) => /amazon\.se/i.test(text) && /fakturauppgifter/i.test(text) && /såld av amazon eu s\./i.test(text),
  },
  {
    id: 'amazon_marketplace_invoice',
    label: 'Amazon marketplace invoice',
    match: (text) => (
      (/amazon\.se/i.test(text) && /fakturauppgifter/i.test(text) && /såld av/i.test(text)) ||
      (/moms deklarerat av amazon/i.test(text) && /såld av/i.test(text) && /fakturanr/i.test(text))
    ),
  },
  {
    id: 'openai_invoice',
    label: 'OpenAI invoice',
    match: (text) => /openai opco,\s*llc/i.test(text) && /openai vat/i.test(text) && /pay online/i.test(text),
  },
  {
    id: 'anthropic_invoice',
    label: 'Anthropic invoice',
    match: (text) => (
      /anthropic,\s*pbc/i.test(text) &&
      /invoice number/i.test(text) &&
      /pay online/i.test(text) &&
      (/\bamount due\b/i.test(text) || /\bUSD due\b/i.test(text))
    ),
  },
  {
    id: 'lovable_invoice',
    label: 'Lovable invoice',
    match: (text) => (
      (/\blovable labs incorporated\b/i.test(text) || (/\blovable\b/i.test(text) && /support@lovable\.dev/i.test(text))) &&
      /pay online/i.test(text) &&
      /invoice number/i.test(text) &&
      (/\bamount due\b/i.test(text) || /€[\d.,]+\s+due\b/i.test(text))
    ),
  },
  {
    id: 'ubiquiti_receipt_invoice',
    label: 'Ubiquiti receipt / VAT invoice',
    match: (text) => /ubiquiti store europe/i.test(text) && /receipt\s*\/\s*vat invoice/i.test(text) && /invoice no\.:/i.test(text),
  },
  {
    id: 'bbqkees_invoice',
    label: 'BBQKees invoice',
    match: (text) => (
      /bbqkees electronics b\.v\./i.test(text) &&
      /shop@bbqkees-electronics\.nl/i.test(text) &&
      /invoice number/i.test(text) &&
      /order number/i.test(text)
    ),
  },
];

function normalizeWhitespace(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- strip NUL bytes from extracted PDF text
    .replace(/\u0000/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2011/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectInvoiceFingerprint(text: string): InvoiceFingerprint {
  for (const fingerprint of KNOWN_INVOICE_FINGERPRINTS) {
    if (fingerprint.match(text)) {
      return {
        id: fingerprint.id,
        label: fingerprint.label,
        recognized: true,
      };
    }
  }

  return {
    id: 'unknown_layout',
    label: 'Unknown invoice layout',
    recognized: false,
  };
}

function collectParserReviewReasons(params: {
  fingerprint: InvoiceFingerprint;
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currencyDetected: boolean;
  grossAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  paymentStatusConflict: boolean;
}): string[] {
  const reasons: string[] = [];

  if (!params.fingerprint.recognized) {
    reasons.push('Unknown invoice layout');
  }
  if (ORDER_DOCUMENT_FINGERPRINTS.has(params.fingerprint.id)) {
    reasons.push('Order document only — confirm against a supplier invoice or receipt');
  }
  if (!params.supplierName) reasons.push('Supplier was not extracted');
  if (!params.invoiceNumber) reasons.push('Invoice number was not extracted');
  if (!params.invoiceDate) reasons.push('Invoice date was not extracted');
  if (!params.currencyDetected) reasons.push('Currency fell back to default SEK');
  if (params.grossAmount === null) reasons.push('Gross amount was not extracted');
  if (params.netAmount === null) reasons.push('Net amount was not extracted');
  if (params.vatAmount === null) reasons.push('VAT amount was not extracted');
  if (params.paymentStatusConflict) {
    reasons.push('Payment status unclear — document shows both paid markers and credit terms');
  }

  return reasons;
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
    .replace(/:-/g, '')
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
  // DigiKey prints dates as 04-AUG-2026.
  text = text.replace(/\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/g, '$1 $2 $3');
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
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

function extractSectionAfterLastLabel(text: string, labels: string[], stops: string[], maxChars = 120): string | null {
  const candidateStarts: number[] = [];

  for (const label of labels) {
    const re = new RegExp(`(?:^|\\s)${escapeRegExp(label)}\\s*:?\\s+`, 'ig');
    for (const match of text.matchAll(re)) {
      candidateStarts.push(match.index + match[0].length);
    }
  }

  const start = candidateStarts.sort((a, b) => b - a)[0];
  if (start == null) return null;

  const tail = text.slice(start, start + maxChars);
  let end = tail.length;

  for (const stop of stops) {
    const stopMatch = new RegExp(`\\s${escapeRegExp(stop)}\\b`, 'i').exec(tail);
    if (stopMatch && stopMatch.index < end) end = stopMatch.index;
  }

  const section = tail.slice(0, end).trim();
  return section || null;
}

function extractSellerSection(text: string): string | null {
  const soldBySection = extractSectionAfterLastLabel(
    text,
    ['Såld av', 'Sold by'],
    ['Beställningsinformation', 'Billing Address', 'Leveransadress', 'Description', 'PRODUCT DESCRIPTION', 'Qty'],
    320,
  );
  if (soldBySection) return soldBySection;

  return extractSectionAfterLabel(
    text,
    ['Date due', 'Date of issue'],
    ['Bill to', 'Ship to', 'Pay online', 'Description'],
    260,
  );
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

    // Only read a monetary value immediately after the label. Looking farther
    // ahead can interpret dates or quantities in a table header as totals.
    const money = section.match(/^(?:SEK|EUR|USD|kr|€|\$)?\s*-?\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)*\s*(?:kr|SEK|EUR|USD|€|\$)?/i);
    const amount = money ? selectAmount(parseMoneyValues(money[0]), preferredCurrency) : null;
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
  if (/:-/.test(text)) return 'SEK';
  return null;
}

function extractSupplierName(lines: string[], normalizedText: string): string | null {
  if (/Apple Distribution International Ltd\./i.test(normalizedText)) return 'Apple Distribution International Ltd.';
  if (/Supabase Pte\. Ltd\./i.test(normalizedText)) return 'Supabase Pte. Ltd.';
  if (/Coolshop\.se/i.test(normalizedText)) return 'Coolshop.se';
  if (/Global-e NL B\.V/i.test(normalizedText)) return 'Global-e NL B.V';
  if (/DIGI-KEY\s+ELECTRONICS|DIGI-KEYS momsregistreringsnr\./i.test(normalizedText)) return 'Digi-Key Electronics';
  if (/elbutik scandinavia ab/i.test(normalizedText) && /info@elbutik\.se/i.test(normalizedText)) {
    return 'Elbutik Scandinavia AB';
  }
  if (/cs megastore ab/i.test(normalizedText) && /csmegastore\.se/i.test(normalizedText)) {
    return 'CS MEGASTORE AB';
  }
  if (/lunar bank a\/s/i.test(normalizedText) && /support@lunar\.app/i.test(normalizedText)) {
    return 'Lunar Bank A/S';
  }
  if (/user_feedback@z\.ai/i.test(normalizedText) && /receipt number/i.test(normalizedText)) {
    return 'zai';
  }
  const openAiHeaderMatch = normalizedText.match(/OpenAI OpCo,\s*LLC/i);
  if (openAiHeaderMatch) return 'OpenAI OpCo, LLC';
  if (/bbqkees electronics b\.v\./i.test(normalizedText)) return 'BBQKees Electronics B.V.';
  if (/info@m\.nu/i.test(normalizedText)) return 'a m punkt nu Sverige AB';
  if (/support@lovable\.dev/i.test(normalizedText) && /\blovable\b/i.test(normalizedText)) {
    return 'Lovable Labs Incorporated';
  }

  const sellerSectionAfterDates = extractSectionAfterLabel(
    normalizedText,
    ['Date due', 'Date of issue'],
    ['Bill to', 'Ship to', 'Pay online', 'Description'],
    220,
  );
  if (sellerSectionAfterDates) {
    const trimmedSection = sellerSectionAfterDates
      .replace(/^(?:[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*)+/, '')
      .trim();
    const company = trimmedSection.match(COMPANY_SUFFIX_RE);
    if (company) return cleanSupplierName(company[1]);
  }

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

function extractSupplierCountry(text: string): string | null {
  if (/Apple Distribution International Ltd\./i.test(text) && /Ireland VAT Reg No\./i.test(text)) return 'IE';
  if (/Supabase Pte\. Ltd\./i.test(text) && /Singapore/i.test(text)) return 'SG';
  if (/Coolshop\.se/i.test(text) && /VAT No\.:\s*DK/i.test(text)) return 'DK';
  if (/Global-e NL B\.V/i.test(text) && /Netherlands/i.test(text)) return 'NL';
  if (/DIGI-KEY\s+ELECTRONICS|DIGI-KEYS momsregistreringsnr\./i.test(text) && /USA/i.test(text)) return 'US';
  if (/elbutik scandinavia ab/i.test(text) || /cs megastore ab/i.test(text)) return 'SE';
  if (/lunar bank a\/s/i.test(text) && /dk-8000 aarhus/i.test(text)) return 'DK';
  if (/user_feedback@z\.ai/i.test(text) && /singapore/i.test(text)) return 'SG';
  if (/info@m\.nu/i.test(text)) return 'SE';
  if (/bbqkees electronics b\.v\./i.test(text) && /netherlands/i.test(text)) return 'NL';
  if (/stripe payments europe,\s*limited/i.test(text) && /ireland/i.test(text)) return 'IE';

  const sellerSection = extractSellerSection(text);
  if (!sellerSection) return null;

  const normalizedSellerSection = normalizeWhitespace(sellerSection);
  const loweredSection = normalizedSellerSection.toLowerCase();

  for (const [countryName, countryCode] of COUNTRY_NAME_TO_CODE) {
    if (loweredSection.includes(countryName)) return countryCode;
  }

  const codeMatches = normalizedSellerSection.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
  for (const match of codeMatches.reverse()) {
    const candidate = match === 'UK' ? 'GB' : match;
    if (SUPPLIER_COUNTRY_CODE_SET.has(candidate) && candidate !== 'EU') return candidate;
  }

  return null;
}

function extractSupplierVatNumber(text: string, supplierName: string | null): string | null {
  if (supplierName === 'Apple Distribution International Ltd.') {
    return text.match(/Ireland VAT Reg No\.\s*(IE[A-Z0-9]+)/i)?.[1] || null;
  }
  if (supplierName === 'Global-e NL B.V') {
    return text.match(/VAT Reg\. No\.\s*([A-Z]{2}\s?\d+)/i)?.[1] || null;
  }
  if (supplierName === 'Digi-Key Electronics') {
    return text.match(/DIGI-KEYS momsregistreringsnr\.\s*:\s*([A-Z]{2}\d+)/i)?.[1] || null;
  }
  // This layout only displays the customer's VAT number.
  if (supplierName === 'Supabase Pte. Ltd.') return null;
  if (/cs megastore ab/i.test(text)) {
    const csMegastoreVatMatch = text.match(/\bVat-no\s*:\s*(SE\d{10,12})\b/i);
    if (csMegastoreVatMatch) return csMegastoreVatMatch[1].toUpperCase();
  }

  if (/bbqkees electronics b\.v\./i.test(text)) {
    const bbqKeesVatMatch = text.match(/\bVAT\s*:\s*(NL\s?[A-Z0-9]{2,14})\b/i);
    if (bbqKeesVatMatch) return bbqKeesVatMatch[1].replace(/\s+/g, ' ').trim();
  }

  const sellerSection = extractSellerSection(text);
  if (sellerSection) {
    const sanitizedSellerSection = sellerSection.replace(
      /Moms deklarerat av Amazon.+?Moms #\s*[A-Z]{2}\s?\d[\dA-Z ]+/i,
      ' ',
    );
    const sectionVatMatch = sanitizedSellerSection.match(
      new RegExp(`\\b(?:VAT(?:\\s*(?:ID|Number|No|Nr))?|Stripe VAT Number|OpenAI VAT|EU OSS VAT|Moms #|momsnummer)\\s*[:#]?\\s*${VAT_NUMBER_RE.source}`, 'i'),
    );
    if (sectionVatMatch) return sectionVatMatch[1].replace(/\s+/g, ' ').trim();
  }

  const vatValue = extractLabelValue(
    text,
    ['VAT Number', 'VAT No', 'VAT Nr', 'Stripe VAT Number', 'VAT ID', 'momsnummer', 'Momsreg.nr', 'Momsregnr', 'OpenAI VAT', 'EU OSS VAT'],
  );
  if (vatValue) {
    const vatMatch = vatValue.match(VAT_NUMBER_RE);
    if (vatMatch) return vatMatch[0].replace(/\s+/g, ' ').trim();
  }

  const shouldTreatGenericMomsHashAsSupplierVat =
    !!supplierName && /amazon/i.test(supplierName)
      ? true
      : !/moms deklarerat av amazon|vat declared by amazon/i.test(text);

  if (shouldTreatGenericMomsHashAsSupplierVat) {
    const genericMomsHash = extractLabelValue(text, ['Moms #']);
    if (genericMomsHash) {
      const vatMatch = genericMomsHash.match(VAT_NUMBER_RE);
      if (vatMatch) return vatMatch[0].replace(/\s+/g, ' ').trim();
    }
  }

  const fallbackVatMatch = text.match(new RegExp(`VAT ID:\\s*${VAT_NUMBER_RE.source}`, 'i'));
  if (fallbackVatMatch) return fallbackVatMatch[1].replace(/\s+/g, ' ').trim();

  return null;
}

function extractInvoiceNumber(text: string): string | null {
  if (/Apple Distribution International Ltd\./i.test(text)) return text.match(/Document:\s*(\d+)/i)?.[1] || null;
  if (/Beställningssammanfattning/i.test(text) && /cs megastore ab/i.test(text)) return null;
  if (/Coolshop\.se/i.test(text)) return text.match(/Kvitto nr\.:\s*(\d+)/i)?.[1] || null;
  if (/Global-e NL B\.V/i.test(text)) return text.match(/Invoice No\.:\s*(\d+)/i)?.[1] || null;
  if (/www\.digikey\.com/i.test(text)) return text.match(/(?:Fakturanummer|PO Acknowledgement)\s+(\d+)/i)?.[1] || null;
  if (/Supabase Pte\. Ltd\./i.test(text)) return text.match(/Invoice number\s+(\S+)/i)?.[1] || null;
  const lunarMatch = text.match(/Invoice No\s*:\s*([A-Z0-9][A-Z0-9-]*)/i);
  if (lunarMatch && /lunar bank a\/s/i.test(text)) return lunarMatch[1];

  const zaiMatch = text.match(/Invoice number\s+(INV-[A-Z0-9-]+)/i);
  if (zaiMatch && /user_feedback@z\.ai/i.test(text)) return zaiMatch[1];

  const elbutikMatch = text.match(/Faktura nr\s+Datum\s+Kund nr\s+Ordernr\s+Sida\s+(\d+)/i);
  if (elbutikMatch) return elbutikMatch[1];

  const receiptMatch = text.match(/Kvittonr\.?\s*:?\s*(\d+)/i);
  if (receiptMatch) return receiptMatch[1];

  const direct = extractLabelValue(text, ['Invoice Number', 'Invoice No', 'Invoice #', 'Fakturanr/Order-id', 'Fakturanr', 'Fakturanummer']);
  if (direct) {
    // eslint-disable-next-line no-control-regex -- strip NUL bytes from extracted PDF text
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

function extractInvoiceDate(text: string, fingerprintId: string): string | null {
  if (fingerprintId === 'apple_subscription_receipt') {
    const match = text.match(/Invoice\s+(.+?)\s+Sequence:/i);
    return match ? parseDate(match[1]) : null;
  }
  if (fingerprintId === 'cs_megastore_order_summary') return null;
  if (fingerprintId === 'coolshop_receipt') return extractDate(text, ['Kvittodatum']);
  if (fingerprintId === 'global_e_invoice') return extractDate(text, ['Date/Tax Point']);
  if (fingerprintId === 'digikey_invoice') {
    // The date row is Order Source, Order Date, Invoice Date, Ship Date.
    const match = text.match(/INTERNET\s+\d{2}-[A-Z]{3}-\d{4}\s+(\d{2}-[A-Z]{3}-\d{4})\s+\d{2}-[A-Z]{3}-\d{4}/i);
    return match ? parseDate(match[1]) : null;
  }
  if (fingerprintId === 'digikey_order_acknowledgement') {
    // PDF.js emits the form's labels before their values. The order date
    // follows INTERNET; later dates belong to product compliance information.
    const match = text.match(/INTERNET\s+(\d{2}-[A-Z]{3}-\d{4})/i);
    return match ? parseDate(match[1]) : null;
  }
  if (fingerprintId === 'elbutik_scandinavia_invoice') {
    const match = text.match(/Faktura nr\s+Datum\s+Kund nr\s+Ordernr\s+Sida\s+\d+\s+(\d{2}\.\d{2}\.\d{4})/i);
    return match ? parseDate(match[1]) : null;
  }

  return extractDate(text, [
    'Invoice Date',
    'Fakturadatum',
    'Fakturadatum/Leveransdatum',
    'Date of issue',
    'Date paid',
    'Date',
  ]);
}

/**
 * Fingerprints whose documents are always settled at issue: true receipts,
 * plus Stripe-billed suppliers that auto-charge the card on the invoice date
 * (confirmed for these accounts) even though the document says "Amount due".
 */
const RECEIPT_FINGERPRINTS = new Set([
  'digikey_invoice',
  'apple_subscription_receipt',
  'coolshop_receipt',
  'cs_megastore_receipt',
  'zai_receipt',
  'openai_invoice',
  'anthropic_invoice',
  'lovable_invoice',
  'lunar_bank_invoice',
]);

/** Explicit on-document evidence that payment is already settled */
const PAID_SIGNALS: RegExp[] = [
  /ordern är betald/i,
  /denna faktura ska inte betalas/i,
  /betalning sker via klarna/i,
  /klarna checkout/i,
  /marked as paid/i,
  /\bdate paid\b/i,
  /\bkvitto\b/i,
  /(?<!ej )(?<!inte )(?<!icke )\bbetald\b/i,
  /debited from your (?:stripe )?balance/i,
  /payment received|paid in full|thank you for your payment/i,
  /payment status\s*:?\s*(?:paid|authorized|captured)/i,
  /(?:payment method|betalningsmetod)\s*:?\s*(?:credit ?card|card|mastercard|visa|klarna|paypal|swish|quickpay)/i,
  /betalning\s*:?\s*\S*checkout/i,
];

/** Payment terms that imply a supplier debt outstanding until a later due date */
const CREDIT_TERMS_SIGNALS: RegExp[] = [
  /\b\d+\s*dagar\s+netto\b/i,
  /\bnetto\s+\d+\s*dagar\b/i,
  /betalningsvillkor\s*:?\s*\d+\s*dagar/i,
  /\bnet\s*\d+\b/i,
  /\bpayment terms\s*:?\s*\d+\s*days\b/i,
  /\bdue in \d+ days\b/i,
];

function detectDocumentType(fingerprintId: string, text: string): {
  documentType: 'receipt' | null;
  paymentStatusConflict: boolean;
} {
  if (ORDER_DOCUMENT_FINGERPRINTS.has(fingerprintId)) {
    return { documentType: null, paymentStatusConflict: false };
  }
  if (RECEIPT_FINGERPRINTS.has(fingerprintId)) {
    return { documentType: 'receipt', paymentStatusConflict: false };
  }
  const paidSignal = PAID_SIGNALS.some((pattern) => pattern.test(text));
  const creditTerms = CREDIT_TERMS_SIGNALS.some((pattern) => pattern.test(text));
  if (paidSignal && creditTerms) {
    return { documentType: null, paymentStatusConflict: true };
  }
  return { documentType: paidSignal ? 'receipt' : null, paymentStatusConflict: false };
}

function extractDueDate(text: string, fingerprintId: string): string | null {
  if (fingerprintId === 'elbutik_scandinavia_invoice') {
    const match = text.match(/Betalningsvillkor:\s+.+?\s+(\d{2}\.\d{2}\.\d{4})\b/i);
    return match ? parseDate(match[1]) : null;
  }

  return extractDate(text, ['Invoice Due', 'Due Date', 'Förfallodatum', 'Förfaller']);
}

function extractProductName(text: string): string | null {
  if (/www\.digikey\.com/i.test(text)) {
    const match = text.match(/DESC:\s+(.+?)\s+\d+\.\d{5}\s+\d+(?:,\d{3})*\.\d{2}/i);
    return match ? cleanProductName(match[1]) : null;
  }
  const elbutikMatch = text.match(
    /Product no\.\s+Description\s+Quantity\s+Price\s+Disc\. %\s+Amount\s+\S+\s+(.+?)\s+\d+\s+[\d.,]+\s+[\d.,]+/i,
  );
  if (elbutikMatch) return cleanProductName(elbutikMatch[1]) || null;

  const csMegastoreMatch = text.match(
    /Artikelnr\.\s+Benämning\s+Antal\s+Pris \/ St\.\s+Moms %\s+Pris \(ex\. moms\)\s+\d+\s+(.+?)\s+(?:\d{8,14}\s+)?\d+\s+[\d.,]+\s+\d{1,2}[.,]\d{2}\s+[\d.,]+/i,
  );
  if (csMegastoreMatch) return cleanProductName(csMegastoreMatch[1]) || null;

  const lunarMatch = text.match(/Product\s+Details\s+Price\s+(.+?)\s+1x\s+/i);
  if (lunarMatch) return cleanProductName(lunarMatch[1]) || null;

  const zaiMatch = text.match(/Description\s+Qty\s+Unit price\s+Amount\s+(.+?)\s+1\s+\$[\d.,]+/i);
  if (zaiMatch) return cleanProductName(zaiMatch[1]) || null;

  const bbqKeesMatch = text.match(/Product\s+HS Code\s+Quantity\s+Total\s+VAT\s+Price\s+(.+?)\s+VAT EXEMPT\s+SKU:/i);
  if (bbqKeesMatch) {
    const productName = cleanProductName(bbqKeesMatch[1]);
    return productName || null;
  }

  const mnuMatch = text.match(/Art\.nr:\s+Namn \/ Färg\s+Typ:\s+Pris\s+Moms\s+Summa\s+\S+\s+\d+\s+\S+\s+(.+?)\s+-\s+\d+st à/i);
  if (mnuMatch) {
    const productName = cleanProductName(mnuMatch[1]);
    return productName || null;
  }

  const genericEnglishMatch = text.match(/Description\s+Qty\s+Unit price\s+Tax\s+Amount\s+(.+?)\s+\d+\s+(?:€|\$|kr|SEK|EUR|USD)/i);
  if (genericEnglishMatch) {
    const productName = cleanProductName(genericEnglishMatch[1]);
    return productName || null;
  }

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

function extractSwedishSimpleInvoiceSummary(text: string): { vatRate: number | null; netAmount: number | null; vatAmount: number | null; grossAmount: number | null } | null {
  const netMatch = text.match(/Netto\s*:?\s*([\d\s.,]+)\s*:-/i);
  const vatMatch = text.match(/Moms\s*\((\d{1,2})%\)\s*:?\s*([\d\s.,]+)\s*:-/i);
  const grossMatch = text.match(/Summa:\s*([\d\s.,]+)\s*:-/i);

  if (!netMatch && !vatMatch && !grossMatch) return null;

  return {
    vatRate: vatMatch ? Number(vatMatch[1]) : null,
    netAmount: netMatch ? parseAmount(netMatch[1]) : null,
    vatAmount: vatMatch ? parseAmount(vatMatch[2]) : null,
    grossAmount: grossMatch ? parseAmount(grossMatch[1]) : null,
  };
}

function extractInclusiveVatSummary(text: string): { vatRate: number | null; netAmount: number | null; vatAmount: number | null } | null {
  const match = text.match(
    /(?:VAT|Tax)(?:\s*-\s*[A-Za-zÅÄÖåäö]+)?\s+\(?\s*(\d{1,2})%\s*(?:incl\.?\s*)?on\s+((?:€|\$)?[\d\s.,]+(?:\s*(?:kr|sek|eur|usd))?)\s*\)?\s+((?:€|\$)?[\d\s.,]+(?:\s*(?:kr|sek|eur|usd))?)/i,
  );
  if (!match) return null;

  return {
    vatRate: Number(match[1]),
    netAmount: parseAmount(match[2]),
    vatAmount: parseAmount(match[3]),
  };
}

function extractKnownLayoutSummary(
  text: string,
  fingerprintId: string,
): { grossAmount: number | null; netAmount: number | null; vatAmount: number | null } | null {
  const money = '(\\d+(?:[ .]\\d{3})*(?:[.,]\\d{2}))';
  let summaryMatch: RegExpMatchArray | null = null;
  switch (fingerprintId) {
    case 'apple_subscription_receipt':
      summaryMatch = text.match(new RegExp(`Subtotal\\s+${money}\\s*kr\\s+VAT charged at\\s+\\d+\\s*%\\s+${money}\\s*kr\\s+(?:Mastercard|Visa|American Express)\\s+[^\\d]*\\d{4}\\s+${money}\\s*kr`, 'i'));
      break;
    case 'cs_megastore_order_summary':
      // This explicitly disclaims being an order confirmation or invoice.
      // Do not populate invoice fields from its provisional order totals.
      return { netAmount: null, vatAmount: null, grossAmount: null };
    case 'coolshop_receipt':
      summaryMatch = text.match(new RegExp(`Totalt exkl\\. MOMS:\\s+${money}\\s*kr\\.\\s+MOMS:\\s+${money}\\s*kr\\.\\s+Totalt inkl\\. MOMS:\\s+${money}\\s*kr`, 'i'));
      break;
    case 'global_e_invoice':
      summaryMatch = text.match(new RegExp(`Total subject to \\d+% VAT\\s+kr\\s+${money}\\s+Total VAT\\s+kr\\s+${money}\\s+Total Invoice Amount\\s+kr\\s+${money}`, 'i'));
      break;
    case 'supabase_invoice': {
      const netAmount = extractMoneyForLabel(text, ['Subtotal'], ['Amount due'], 'USD');
      const grossAmount = extractMoneyForLabel(text, ['Amount due'], ['Description'], 'USD');
      return {
        netAmount,
        grossAmount,
        // The memo explains several tax regimes; use the actual billed
        // difference, rather than interpreting the generic reverse-charge text.
        vatAmount: netAmount !== null && grossAmount !== null
          ? Math.round((grossAmount - netAmount) * 100) / 100
          : null,
      };
    }
    case 'digikey_invoice':
    case 'digikey_order_acknowledgement': {
      const amount = '(\\d+(?:,\\d{3})*\\.\\d{2})';
      const match = text.match(new RegExp(`${amount}\\s+${amount}\\s+${amount}\\s+(?:[^\\s@]+@[^\\s@]+\\s+)?USD\\s+\\$\\s+INCOTERM`, 'i'));
      // The invoice's second column is Charges subtotal; the order's first
      // column is Sales Amount. Both put the final total in the third column.
      const netAmount = match ? parseAmount(match[fingerprintId === 'digikey_invoice' ? 2 : 1]) : null;
      const grossAmount = match ? parseAmount(match[3]) : null;
      const selfAssessedVat = /recipient is required to account for or to self-assess the intra-community acquisition VAT/i.test(text);
      return {
        netAmount,
        grossAmount,
        // Only the invoice states that the recipient accounts for VAT.
        // An acknowledgement or a missing tax statement cannot establish zero VAT.
        vatAmount: fingerprintId === 'digikey_invoice' && selfAssessedVat && netAmount !== null && netAmount === grossAmount ? 0 : null,
      };
    }
    default:
      break;
  }
  if (['apple_subscription_receipt', 'coolshop_receipt', 'global_e_invoice'].includes(fingerprintId)) {
    return {
      netAmount: summaryMatch ? parseAmount(summaryMatch[1]) : null,
      vatAmount: summaryMatch ? parseAmount(summaryMatch[2]) : null,
      grossAmount: summaryMatch ? parseAmount(summaryMatch[3]) : null,
    };
  }
  if (fingerprintId === 'elbutik_scandinavia_invoice') {
    const match = text.match(
      /Summa\s+(\d[\d ]*[.,]\d+)\s+Moms %\s+(\d[\d ]*[.,]\d+).*?Att betala\s+(\d[\d ]*[.,]\d+)/i,
    );
    if (match) {
      return {
        netAmount: parseAmount(match[1]),
        vatAmount: parseAmount(match[2]),
        grossAmount: parseAmount(match[3]),
      };
    }
  }

  if (fingerprintId === 'cs_megastore_receipt') {
    const match = text.match(
      /Totalt ex\. moms\s+(\d[\d ]*[.,]\d+)\s+Moms\s+(\d[\d ]*[.,]\d+)\s+Total inkl\. moms\s+SEK\s+(\d[\d ]*[.,]\d+)/i,
    );
    if (match) {
      return {
        netAmount: parseAmount(match[1]),
        vatAmount: parseAmount(match[2]),
        grossAmount: parseAmount(match[3]),
      };
    }
  }

  if (fingerprintId === 'lunar_bank_invoice') {
    const match = text.match(
      /Subtotal\s*:\s*(\d[\d ]*(?:[.,]\d+)?)\s*kr\s+VAT\s*:\s*(\d[\d ]*(?:[.,]\d+)?)\s*kr\s+Total\s*:\s*(\d[\d ]*(?:[.,]\d+)?)\s*kr/i,
    );
    if (match) {
      return {
        netAmount: parseAmount(match[1]),
        vatAmount: parseAmount(match[2]),
        grossAmount: parseAmount(match[3]),
      };
    }
  }

  if (fingerprintId === 'zai_receipt') {
    const match = text.match(
      /Subtotal\s+\$(\d[\d.,]*)\s+Total\s+\$(\d[\d.,]*)\s+Amount paid\s+\$(\d[\d.,]*)\s+USD/i,
    );
    if (match) {
      return {
        netAmount: parseAmount(match[1]),
        vatAmount: 0,
        grossAmount: parseAmount(match[3]),
      };
    }
  }

  return null;
}

/* ── Main parser ────────────────────────────────────── */

export function parseInvoiceText(rawText: string): ParsedInvoice {
  const conf: Record<string, number> = {};
  // eslint-disable-next-line no-control-regex -- strip NUL bytes from extracted PDF text
  const sanitizedRawText = rawText.replace(/\u0000/g, ' ').replace(/\u2011/g, '-');
  const normalizedText = normalizeWhitespace(sanitizedRawText);
  const lines = sanitizedRawText.split('\n').map((line) => line.trim()).filter(Boolean);
  const fingerprint = detectInvoiceFingerprint(normalizedText);

  const supplierName = extractSupplierName(lines, normalizedText);
  if (supplierName) conf.supplierName = 0.9;
  const supplierCountry = extractSupplierCountry(normalizedText);
  if (supplierCountry) conf.supplierCountry = 0.8;

  let orgNumber: string | null = null;
  const orgMatch = normalizedText.match(/(?:org\.?\s*(?:nr|nummer|no)?\.?\s*:?\s*)(\d{6}-?\d{4})/i);
  if (orgMatch) orgNumber = orgMatch[1];
  if (!orgNumber && fingerprint.id === 'elbutik_scandinavia_invoice') {
    orgNumber = normalizedText.match(/Elbutik Scandinavia AB\s+(\d{6}-\d{4})\s+\+46/i)?.[1] || null;
  }
  if (!orgNumber && fingerprint.id === 'lunar_bank_invoice') {
    orgNumber = normalizedText.match(/CVR\s*:\s*(\d{8})/i)?.[1] || null;
  }

  const vatNumber = extractSupplierVatNumber(normalizedText, supplierName);

  const invoiceNumber = extractInvoiceNumber(normalizedText);
  if (invoiceNumber) conf.invoiceNumber = 0.95;

  const invoiceDate = extractInvoiceDate(normalizedText, fingerprint.id);
  if (invoiceDate) conf.invoiceDate = 0.95;

  const { documentType, paymentStatusConflict } = detectDocumentType(fingerprint.id, normalizedText);

  // A receipt is already settled — a due date would misread as an open payable.
  const dueDate = documentType === 'receipt' ? null : extractDueDate(normalizedText, fingerprint.id);
  if (dueDate) conf.dueDate = 0.9;

  const inferredCurrency = inferCurrency(normalizedText);
  const currency = inferredCurrency || 'SEK';
  conf.currency = inferredCurrency ? 0.9 : 0.2;

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
    ['Net Amount', 'Netto', 'Total excluding tax', 'Delsumma för artikel (exkl. moms)', 'Delsumma', 'Exkl moms', 'Subtotal'],
    ['VAT', 'Moms', 'Total', 'Amount Due', 'Questions?'],
    currency,
  );
  if (netAmount !== null) conf.netAmount = 0.9;

  const swedishVatSummary = extractSwedishVatSummary(normalizedText);
  const swedishSimpleInvoiceSummary = extractSwedishSimpleInvoiceSummary(normalizedText);
  const inclusiveVatSummary = extractInclusiveVatSummary(normalizedText);
  const knownLayoutSummary = extractKnownLayoutSummary(normalizedText, fingerprint.id);
  if (knownLayoutSummary) {
    grossAmount = knownLayoutSummary.grossAmount;
    netAmount = knownLayoutSummary.netAmount;
    vatAmount = knownLayoutSummary.vatAmount;
    if (grossAmount !== null) conf.grossAmount = 0.99;
    if (netAmount !== null) conf.netAmount = 0.99;
    if (vatAmount !== null) conf.vatAmount = 0.99;
  }
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
  if (swedishSimpleInvoiceSummary) {
    if (netAmount === null && swedishSimpleInvoiceSummary.netAmount !== null) {
      netAmount = swedishSimpleInvoiceSummary.netAmount;
      conf.netAmount = 0.95;
    }
    if (vatAmount === null && swedishSimpleInvoiceSummary.vatAmount !== null) {
      vatAmount = swedishSimpleInvoiceSummary.vatAmount;
      conf.vatAmount = 0.95;
    }
    if (grossAmount === null && swedishSimpleInvoiceSummary.grossAmount !== null) {
      grossAmount = swedishSimpleInvoiceSummary.grossAmount;
      conf.grossAmount = 0.95;
    }
  }
  if (inclusiveVatSummary) {
    if (netAmount === null && inclusiveVatSummary.netAmount !== null) {
      netAmount = inclusiveVatSummary.netAmount;
      conf.netAmount = 0.95;
    }
    if (vatAmount === null && inclusiveVatSummary.vatAmount !== null) {
      vatAmount = inclusiveVatSummary.vatAmount;
      conf.vatAmount = 0.95;
    }
  }

  if (!knownLayoutSummary && (grossAmount === null || vatAmount === null || netAmount === null)) {
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
  if (vatRate === null) {
    vatRate = swedishVatSummary?.vatRate ?? swedishSimpleInvoiceSummary?.vatRate ?? inclusiveVatSummary?.vatRate ?? null;
  }

  const description = extractDescription(supplierName, normalizedText);
  if (description) conf.description = 0.85;
  const parserReviewReasons = collectParserReviewReasons({
    fingerprint,
    supplierName,
    invoiceNumber,
    invoiceDate,
    currencyDetected: inferredCurrency !== null,
    grossAmount,
    netAmount,
    vatAmount,
    paymentStatusConflict,
  });

  return {
    supplierName,
    supplierCountry,
    invoiceNumber,
    invoiceDate,
    dueDate,
    documentType,
    grossAmount,
    netAmount,
    vatAmount,
    vatRate,
    currency,
    orgNumber,
    vatNumber,
    description,
    confidence: conf,
    fingerprint,
    parserReviewRequired: parserReviewReasons.length > 0,
    parserReviewReasons,
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

  if (productName) return productName;

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
