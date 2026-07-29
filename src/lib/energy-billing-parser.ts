export const ENERGY_DOCUMENT_KINDS = ['grid', 'electricity'] as const;
export type EnergyDocumentKind = (typeof ENERGY_DOCUMENT_KINDS)[number];

export const ENERGY_CHARGE_CATEGORIES = [
  'spot_energy',
  'variable_fee',
  'markup',
  'fixed_fee',
  'energy_transfer',
  'peak_demand',
  'energy_tax',
  'export_credit',
  'export_fee',
  'discount',
  'vat',
] as const;
export type EnergyChargeCategory = (typeof ENERGY_CHARGE_CATEGORIES)[number];

export type EnergyParserIssueCode =
  | 'unknown_format'
  | 'wrong_document_kind'
  | 'missing_invoice_number'
  | 'missing_invoice_date'
  | 'missing_service_period'
  | 'missing_consumption'
  | 'missing_total'
  | 'missing_required_charges'
  | 'invalid_service_period'
  | 'partial_service_period';

export interface ParsedEnergyLineItem {
  category: EnergyChargeCategory;
  label: string;
  amountSek: number;
  quantity: number | null;
  unit: string | null;
  unitPriceSek: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  amountIncludesVat: boolean;
}

export interface ParsedEnergyDocument {
  formatRecognized: boolean;
  importable: boolean;
  documentKind: EnergyDocumentKind | null;
  providerKey: string | null;
  providerName: string | null;
  parserId: string | null;
  parserVersion: number | null;
  recognitionLabel: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  consumptionKwh: number | null;
  exportedKwh: number | null;
  peakDemandKw: number | null;
  vatSek: number | null;
  totalAmountSek: number | null;
  currency: 'SEK';
  lineItems: ParsedEnergyLineItem[];
  errors: EnergyParserIssueCode[];
  warnings: EnergyParserIssueCode[];
}

interface ParserDefinition {
  id: string;
  version: number;
  label: string;
  documentKind: EnergyDocumentKind;
  providerKey: string;
  providerName: string;
  matches: (text: string) => boolean;
  parse: (text: string) => ParsedFields;
}

interface ParsedFields {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  consumptionKwh: number | null;
  exportedKwh: number | null;
  peakDemandKw: number | null;
  vatSek: number | null;
  totalAmountSek: number | null;
  lineItems: ParsedEnergyLineItem[];
  requiredChargeCategories: EnergyChargeCategory[];
}

const SWEDISH_MONTHS: Record<string, number> = {
  januari: 1,
  jan: 1,
  februari: 2,
  feb: 2,
  mars: 3,
  mar: 3,
  april: 4,
  apr: 4,
  maj: 5,
  juni: 6,
  jun: 6,
  juli: 7,
  jul: 7,
  augusti: 8,
  aug: 8,
  september: 9,
  sep: 9,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const NUMBER_PATTERN = String.raw`-?(?:\d{1,3}(?: \d{3})+|\d+)(?:[,.]\d+)?`;
const ISO_DATE_PATTERN = String.raw`\d{4}-\d{2}-\d{2}`;
const SWEDISH_DATE_PATTERN = String.raw`\d{1,2}\s+[a-zåäö]+\s+\d{4}`;
const SWEDISH_SHORT_DATE_PATTERN = String.raw`\d{1,2}\s+[a-zåäö]{3}-\d{2}`;

function normalizeText(rawText: string): string {
  return rawText
    // eslint-disable-next-line no-control-regex -- extracted PDFs occasionally contain NUL bytes
    .replace(/\u0000/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/\u2011/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parseEnergyNumber(value: string): number | null {
  const compact = value
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/\s/g, '')
    .trim();
  if (!compact) return null;

  const negative = compact.startsWith('-');
  let unsigned = compact.replace(/^[+-]/, '');
  if (unsigned.includes(',') && unsigned.includes('.')) {
    const decimalSeparator = unsigned.lastIndexOf(',') > unsigned.lastIndexOf('.') ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? /\./g : /,/g;
    unsigned = unsigned.replace(thousandsSeparator, '');
    if (decimalSeparator === ',') unsigned = unsigned.replace(',', '.');
  } else if (unsigned.includes(',')) {
    unsigned = unsigned.replace(',', '.');
  }

  const parsed = Number(unsigned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseEnergyDate(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase('sv-SE');
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const swedishMatch = normalized.match(/^(\d{1,2})\s+([a-zåäö]+)\s+(\d{4})$/i);
  const shortSwedishMatch = normalized.match(/^(\d{1,2})\s+([a-zåäö]{3})-(\d{2})$/i);
  const dateMatch = swedishMatch ?? shortSwedishMatch;
  if (!dateMatch) return null;
  const month = SWEDISH_MONTHS[dateMatch[2]];
  if (!month) return null;
  const year = shortSwedishMatch
    ? 2000 + Number(dateMatch[3])
    : Number(dateMatch[3]);
  return toIsoDate(year, month, Number(dateMatch[1]));
}

function firstCapture(text: string, expression: RegExp, index = 1): string | null {
  return text.match(expression)?.[index]?.trim() ?? null;
}

function lastCapture(text: string, expression: RegExp, index = 1): string | null {
  const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`;
  const globalExpression = new RegExp(expression.source, flags);
  let value: string | null = null;
  for (const match of text.matchAll(globalExpression)) {
    value = match[index]?.trim() ?? value;
  }
  return value;
}

function parseCapturedNumber(value: string | null): number | null {
  return value === null ? null : parseEnergyNumber(value);
}

function parseCapturedDate(value: string | null): string | null {
  return value === null ? null : parseEnergyDate(value);
}

function makeLineItem(params: {
  category: EnergyChargeCategory;
  label: string;
  amount: string;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  unitPriceIsOre?: boolean;
  periodStart?: string | null;
  periodEnd?: string | null;
  amountIncludesVat: boolean;
}): ParsedEnergyLineItem | null {
  const amountSek = parseEnergyNumber(params.amount);
  if (amountSek === null) return null;
  const parsedUnitPrice = params.unitPrice ? parseEnergyNumber(params.unitPrice) : null;
  const unitPriceSek = parsedUnitPrice === null
    ? null
    : params.unitPriceIsOre
      ? parsedUnitPrice / 100
      : parsedUnitPrice;

  return {
    category: params.category,
    label: params.label,
    amountSek: roundMoney(amountSek),
    quantity: params.quantity ? parseEnergyNumber(params.quantity) : null,
    unit: params.unit ?? null,
    unitPriceSek,
    periodStart: params.periodStart ? parseEnergyDate(params.periodStart) : null,
    periodEnd: params.periodEnd ? parseEnergyDate(params.periodEnd) : null,
    amountIncludesVat: params.amountIncludesVat,
  };
}

function pushIfPresent(
  lineItems: ParsedEnergyLineItem[],
  item: ParsedEnergyLineItem | null,
): void {
  if (item) lineItems.push(item);
}

function sumLineItems(lineItems: ParsedEnergyLineItem[]): number | null {
  if (lineItems.length === 0) return null;
  return roundMoney(lineItems.reduce((sum, item) => sum + item.amountSek, 0));
}

function endOfMonth(date: string, maximum: string): string {
  const start = new Date(`${date}T00:00:00Z`);
  const monthEnd = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    0,
  )).toISOString().slice(0, 10);
  return monthEnd < maximum ? monthEnd : maximum;
}

function normalizeInvoiceNumber(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

function scaleLineItem(
  item: ParsedEnergyLineItem | null,
  multiplier: number,
): ParsedEnergyLineItem | null {
  if (!item) return null;
  return {
    ...item,
    amountSek: roundMoney(item.amountSek * multiplier),
    unitPriceSek: item.unitPriceSek === null
      ? null
      : Math.round((item.unitPriceSek * multiplier + Number.EPSILON) * 10_000) / 10_000,
    amountIncludesVat: true,
  };
}

function parseEllevioLegacyLines(
  text: string,
  periodStart: string | null,
  periodEnd: string | null,
): ParsedEnergyLineItem[] {
  if (!periodStart || !periodEnd) return [];
  const amountsIncludeVat = /Pris inkl\. moms/i.test(text);
  const multiplier = amountsIncludeVat ? 1 : 1.25;
  const definitions: Array<{
    label: string;
    category: EnergyChargeCategory;
    unit: 'days' | 'kWh';
  }> = [
    { label: 'Fast elnätsavgift', category: 'fixed_fee', unit: 'days' },
    { label: 'Rörlig elnätsavgift låglast', category: 'energy_transfer', unit: 'kWh' },
    { label: 'Rörlig elnätsavgift höglast', category: 'energy_transfer', unit: 'kWh' },
    { label: 'Energiskatt', category: 'energy_tax', unit: 'kWh' },
  ];
  const lineItems: ParsedEnergyLineItem[] = [];

  for (const definition of definitions) {
    const label = definition.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quantityUnit = definition.unit === 'days'
      ? String.raw`dag(?:ar)?`
      : String.raw`kWh`;
    const priceUnit = definition.unit === 'days'
      ? String.raw`kr\/mån`
      : String.raw`öre\/kWh`;
    const expression = new RegExp(
      `${label}\\s+(?:(${SWEDISH_SHORT_DATE_PATTERN})\\s+)?(${NUMBER_PATTERN})\\s+${quantityUnit}\\s+(${NUMBER_PATTERN})\\s+${priceUnit}\\s+(${NUMBER_PATTERN})\\s+kr`,
      'gi',
    );
    for (const match of text.matchAll(expression)) {
      const rowStart = parseEnergyDate(match[1] ?? '') ?? periodStart;
      const rowEnd = definition.unit === 'days'
        ? periodEnd
        : endOfMonth(rowStart, periodEnd);
      const item = scaleLineItem(makeLineItem({
        category: definition.category,
        label: definition.label,
        amount: match[4],
        quantity: match[2],
        unit: definition.unit,
        unitPrice: match[3],
        unitPriceIsOre: definition.unit === 'kWh',
        periodStart: rowStart,
        periodEnd: rowEnd,
        amountIncludesVat: true,
      }), multiplier);
      pushIfPresent(lineItems, item);
    }
  }
  return lineItems;
}

function parseEllevioLegacy(text: string): ParsedFields {
  const periodMatch = text.match(new RegExp(
    `Kostnad\\s+(${SWEDISH_DATE_PATTERN})\\s+t\\s*o\\s*m\\s+(${SWEDISH_DATE_PATTERN})`,
    'i',
  ));
  const periodStart = parseCapturedDate(periodMatch?.[1] ?? null);
  const periodEnd = parseCapturedDate(periodMatch?.[2] ?? null);
  const lineItems = parseEllevioLegacyLines(text, periodStart, periodEnd);
  const transferItems = lineItems.filter((item) => item.category === 'energy_transfer');

  return {
    invoiceNumber: normalizeInvoiceNumber(firstCapture(
      text,
      /Faktura\/OCR-nummer:\s*((?:\d[\s]*){8,})/i,
    )),
    invoiceDate: parseCapturedDate(firstCapture(
      text,
      new RegExp(`(?:Faktura elnät|Kreditfaktura)\\s+(${SWEDISH_DATE_PATTERN})`, 'i'),
    )),
    periodStart,
    periodEnd,
    consumptionKwh: transferItems.length === 0
      ? null
      : transferItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    exportedKwh: null,
    peakDemandKw: null,
    vatSek: parseCapturedNumber(firstCapture(
      text,
      new RegExp(`Moms\\s+25%:\\s*(${NUMBER_PATTERN})\\s*kr`, 'i'),
    )),
    totalAmountSek: sumLineItems(lineItems),
    lineItems,
    requiredChargeCategories: ['fixed_fee', 'energy_transfer', 'energy_tax'],
  };
}

function parseEllevioLine(
  text: string,
  label: string,
  category: EnergyChargeCategory,
  quantityUnit: 'days' | 'kWh' | 'kW',
  periodStart: string | null,
  periodEnd: string | null,
  amountIncludesVat: boolean,
): ParsedEnergyLineItem | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unitPattern = quantityUnit === 'days'
    ? String.raw`dag(?:ar)?`
    : quantityUnit;
  const priceUnitPattern = quantityUnit === 'days'
    ? String.raw`kr\/mån`
    : quantityUnit === 'kW'
      ? String.raw`kr\/kW,\s*mån`
      : String.raw`öre\/kWh`;
  const expression = new RegExp(
    `${escapedLabel}\\s+(${NUMBER_PATTERN})\\s+${unitPattern}\\s+(${NUMBER_PATTERN})\\s+${priceUnitPattern}\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  );
  const match = text.match(expression);
  if (!match) return null;

  return makeLineItem({
    category,
    label,
    amount: match[3],
    quantity: match[1],
    unit: quantityUnit,
    unitPrice: match[2],
    unitPriceIsOre: quantityUnit === 'kWh',
    periodStart,
    periodEnd,
    amountIncludesVat,
  });
}

function parseEllevio(text: string, includePeakDemand: boolean): ParsedFields {
  const periodMatch = text.match(
    new RegExp(`Kostnad(?:\\s+för perioden)?\\s+(${SWEDISH_DATE_PATTERN})\\s+t\\s*o\\s*m\\s+(${SWEDISH_DATE_PATTERN})`, 'i'),
  );
  const periodStart = parseCapturedDate(periodMatch?.[1] ?? null);
  const periodEnd = parseCapturedDate(periodMatch?.[2] ?? null);
  const lineItems: ParsedEnergyLineItem[] = [];

  pushIfPresent(lineItems, parseEllevioLine(
    text,
    'Fast avgift',
    'fixed_fee',
    'days',
    periodStart,
    periodEnd,
    true,
  ));
  pushIfPresent(lineItems, parseEllevioLine(
    text,
    'Överföringsavgift',
    'energy_transfer',
    'kWh',
    periodStart,
    periodEnd,
    true,
  ));
  if (includePeakDemand) {
    pushIfPresent(lineItems, parseEllevioLine(
      text,
      'Effektavgift',
      'peak_demand',
      'kW',
      periodStart,
      periodEnd,
      true,
    ));
  }

  const taxMatch = text.match(new RegExp(
    `Energiskatt\\s+(${NUMBER_PATTERN})\\s+kWh\\s+(${NUMBER_PATTERN})\\s+öre\\/kWh\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  ));
  if (taxMatch) {
    pushIfPresent(lineItems, makeLineItem({
      category: 'energy_tax',
      label: 'Energiskatt',
      amount: taxMatch[3],
      quantity: taxMatch[1],
      unit: 'kWh',
      unitPrice: taxMatch[2],
      unitPriceIsOre: true,
      periodStart,
      periodEnd,
      amountIncludesVat: true,
    }));
  }

  const exportMatch = text.match(new RegExp(
    `Produktionsersättning,\\s*Elnät[^\\d-]*(${NUMBER_PATTERN})\\s+kWh\\s+(${NUMBER_PATTERN})\\s+öre\\/kWh\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  ));
  if (exportMatch) {
    pushIfPresent(lineItems, makeLineItem({
      category: 'export_credit',
      label: 'Produktionsersättning, Elnät',
      amount: exportMatch[3],
      quantity: exportMatch[1],
      unit: 'kWh',
      unitPrice: exportMatch[2],
      unitPriceIsOre: true,
      periodStart,
      periodEnd,
      amountIncludesVat: false,
    }));
  }

  const transfer = lineItems.find((item) => item.category === 'energy_transfer');
  const peak = lineItems.find((item) => item.category === 'peak_demand');
  const exportCredit = lineItems.find((item) => item.category === 'export_credit');

  return {
    invoiceNumber: normalizeInvoiceNumber(firstCapture(
      text,
      /Faktura\/OCR-nummer:\s*((?:\d[\s]*){8,})/i,
    )),
    invoiceDate: parseCapturedDate(firstCapture(
      text,
      new RegExp(`Faktura elnät\\s+(${SWEDISH_DATE_PATTERN})`, 'i'),
    )),
    periodStart,
    periodEnd,
    consumptionKwh: transfer?.quantity ?? null,
    exportedKwh: exportCredit?.quantity ?? null,
    peakDemandKw: peak?.quantity ?? null,
    vatSek: parseCapturedNumber(firstCapture(text, new RegExp(`Moms\\s+25%:\\s*(${NUMBER_PATTERN})\\s*kr`, 'i'))),
    totalAmountSek: parseCapturedNumber(firstCapture(
      text,
      new RegExp(`Belopp att betala:\\s*(${NUMBER_PATTERN})\\s*kr`, 'i'),
    )),
    lineItems,
    requiredChargeCategories: includePeakDemand
      ? ['fixed_fee', 'energy_transfer', 'peak_demand', 'energy_tax']
      : ['fixed_fee', 'energy_transfer', 'energy_tax'],
  };
}

function parseVarbergsortens(text: string): ParsedFields {
  const periodMatch = text.match(new RegExp(
    `Avstämd period\\s+(${SWEDISH_DATE_PATTERN})\\s+-\\s+(${SWEDISH_DATE_PATTERN})`,
    'i',
  ));
  const periodStart = parseCapturedDate(periodMatch?.[1] ?? null);
  const periodEnd = parseCapturedDate(periodMatch?.[2] ?? null);
  const lineItems: ParsedEnergyLineItem[] = [];
  const fixedMatch = text.match(new RegExp(
    `(?:Fast (?:månads)?avgift\\s+)?(${SWEDISH_DATE_PATTERN})\\s+-\\s+(${SWEDISH_DATE_PATTERN})\\s+(${NUMBER_PATTERN})\\s+dag(?:ar)?\\s+(${NUMBER_PATTERN})\\s+kr\\/mån\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  ));
  if (fixedMatch) {
    pushIfPresent(lineItems, makeLineItem({
      category: 'fixed_fee',
      label: 'Fast avgift',
      amount: fixedMatch[5],
      quantity: fixedMatch[3],
      unit: 'days',
      unitPrice: fixedMatch[4],
      periodStart: fixedMatch[1],
      periodEnd: fixedMatch[2],
      amountIncludesVat: false,
    }));
  }
  const energyMatch = text.match(new RegExp(
    `(?:Elhandel SE3|Fast pris\\s+3\\s+år\\s+Förnybar el\\s+SE3)\\s+(${SWEDISH_DATE_PATTERN})\\s+-\\s+(${SWEDISH_DATE_PATTERN})\\s+(${NUMBER_PATTERN})\\s+kWh\\s+(${NUMBER_PATTERN})\\s+öre\\/kWh\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  ));
  if (energyMatch) {
    pushIfPresent(lineItems, makeLineItem({
      category: 'spot_energy',
      label: 'Elhandel',
      amount: energyMatch[5],
      quantity: energyMatch[3],
      unit: 'kWh',
      unitPrice: energyMatch[4],
      unitPriceIsOre: true,
      periodStart: energyMatch[1],
      periodEnd: energyMatch[2],
      amountIncludesVat: false,
    }));
  }
  const vatMatch = text.match(new RegExp(
    `Moms\\s+25\\s*%\\s+på\\s+${NUMBER_PATTERN}\\s+kr\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  ));
  if (vatMatch) {
    pushIfPresent(lineItems, makeLineItem({
      category: 'vat',
      label: 'Moms 25%',
      amount: vatMatch[1],
      amountIncludesVat: true,
    }));
  }

  return {
    invoiceNumber: normalizeInvoiceNumber(firstCapture(
      text,
      /Fakturanummer\s+(\d{8,})/i,
    )),
    invoiceDate: parseCapturedDate(firstCapture(
      text,
      new RegExp(`Fakturadatum\\s+(${SWEDISH_DATE_PATTERN})`, 'i'),
    )),
    periodStart,
    periodEnd,
    consumptionKwh: parseCapturedNumber(energyMatch?.[3] ?? null),
    exportedKwh: null,
    peakDemandKw: null,
    vatSek: parseCapturedNumber(vatMatch?.[1] ?? null),
    totalAmountSek: parseCapturedNumber(lastCapture(
      text,
      new RegExp(`Summa Elhandel\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'),
    )),
    lineItems,
    requiredChargeCategories: ['spot_energy', 'fixed_fee'],
  };
}

function inclusivePeriodDays(periodStart: string, periodEnd: string): number {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

function parseStockholmsElbolag(text: string): ParsedFields {
  const summaryMatch = text.match(new RegExp(
    `Fakturor\\s*&\\s*Avgifter\\s+Elhandel\\s+(${ISO_DATE_PATTERN})\\s+-\\s+(${ISO_DATE_PATTERN}).{0,150}?(${NUMBER_PATTERN})\\s+kr`,
    'i',
  ));
  const periodStart = parseCapturedDate(summaryMatch?.[1] ?? null);
  const periodEnd = parseCapturedDate(summaryMatch?.[2] ?? null);
  const totalAmountSek = parseCapturedNumber(summaryMatch?.[3] ?? null);
  const consumptionKwh = parseCapturedNumber(firstCapture(
    text,
    new RegExp(`Förbrukat:\\s*(${NUMBER_PATTERN})\\s+kWh`, 'i'),
  ));
  const fixedAmountSek = parseCapturedNumber(firstCapture(
    text,
    new RegExp(`Månadsavgift\\s+inkl\\s+moms:\\s*(${NUMBER_PATTERN})\\s+kr`, 'i'),
  ));
  const lineItems: ParsedEnergyLineItem[] = [];

  if (
    periodStart
    && periodEnd
    && totalAmountSek !== null
    && consumptionKwh !== null
    && fixedAmountSek !== null
  ) {
    const coveredDays = inclusivePeriodDays(periodStart, periodEnd);
    const periodDate = new Date(`${periodStart}T00:00:00Z`);
    const daysInMonth = new Date(Date.UTC(
      periodDate.getUTCFullYear(),
      periodDate.getUTCMonth() + 1,
      0,
    )).getUTCDate();
    const fullCalendarMonth = periodDate.getUTCDate() === 1
      && coveredDays === daysInMonth;
    const energyAmountSek = roundMoney(totalAmountSek - fixedAmountSek);
    const effectiveUnitPriceSek = consumptionKwh > 0
      ? energyAmountSek / consumptionKwh
      : null;

    pushIfPresent(lineItems, makeLineItem({
      category: 'spot_energy',
      label: 'Elhandel',
      amount: String(energyAmountSek),
      quantity: String(consumptionKwh),
      unit: 'kWh',
      unitPrice: effectiveUnitPriceSek === null ? null : String(effectiveUnitPriceSek),
      periodStart,
      periodEnd,
      amountIncludesVat: true,
    }));
    pushIfPresent(lineItems, makeLineItem({
      category: 'fixed_fee',
      label: 'Månadsavgift',
      amount: String(fixedAmountSek),
      quantity: String(coveredDays),
      unit: 'days',
      unitPrice: fullCalendarMonth ? String(fixedAmountSek) : null,
      periodStart,
      periodEnd,
      amountIncludesVat: true,
    }));
  }

  const providerVat = firstCapture(
    text,
    new RegExp(`Debiterad moms från Stockholms Elbolag\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'),
  );
  const invoiceVat = firstCapture(
    text,
    new RegExp(`Varav moms\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'),
  );

  return {
    invoiceNumber: normalizeInvoiceNumber(firstCapture(text, /Fakturanr:\s*(\d{8,})/i)),
    invoiceDate: parseCapturedDate(firstCapture(
      text,
      new RegExp(`Fakturadatum:\\s*(${ISO_DATE_PATTERN})`, 'i'),
    )),
    periodStart,
    periodEnd,
    consumptionKwh,
    exportedKwh: null,
    peakDemandKw: null,
    vatSek: parseCapturedNumber(providerVat ?? invoiceVat),
    totalAmountSek,
    lineItems,
    requiredChargeCategories: ['spot_energy', 'fixed_fee'],
  };
}

const KARLSTAD_LINE_DEFINITIONS: Array<{
  label: string;
  category: EnergyChargeCategory;
}> = [
  { label: 'Medelspotpris', category: 'spot_energy' },
  { label: 'Profilkostnad', category: 'variable_fee' },
  { label: 'Elcertifikat', category: 'variable_fee' },
  { label: 'Ursprungsgarantier', category: 'variable_fee' },
  { label: 'Grundavgift SVK', category: 'variable_fee' },
  { label: 'Balansansvar & rörlig obalans', category: 'variable_fee' },
  { label: 'Fast obalansavgift', category: 'variable_fee' },
  { label: 'Rörliga kostnader', category: 'variable_fee' },
  { label: 'Fast Påslag', category: 'markup' },
  { label: 'Fast avgift', category: 'fixed_fee' },
  { label: 'Energiersättning', category: 'export_credit' },
  { label: 'Rörlig produktionsavgift', category: 'export_fee' },
];

function parseKarlstadLine(
  text: string,
  label: string,
  category: EnergyChargeCategory,
): ParsedEnergyLineItem | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    `(?:x\\s+)?${escapedLabel}\\s+(${ISO_DATE_PATTERN})\\s+-\\s+(${ISO_DATE_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(kWh|dag(?:ar)?)\\s+(${NUMBER_PATTERN})\\s+(öre\\/kWh|kr\\/mån)\\s+(${NUMBER_PATTERN})\\s+kr`,
    'i',
  );
  const match = text.match(expression);
  if (!match) return null;

  return makeLineItem({
    category,
    label,
    amount: match[7],
    quantity: match[3],
    unit: /^dag/i.test(match[4]) ? 'days' : 'kWh',
    unitPrice: match[5],
    unitPriceIsOre: /^öre/i.test(match[6]),
    periodStart: match[1],
    periodEnd: match[2],
    amountIncludesVat: true,
  });
}

function parseKarlstad(text: string): ParsedFields {
  const lineItems = KARLSTAD_LINE_DEFINITIONS
    .map(({ label, category }) => parseKarlstadLine(text, label, category))
    .filter((item): item is ParsedEnergyLineItem => item !== null);
  const spot = lineItems.find((item) => item.category === 'spot_energy');
  const exportCredit = lineItems.find((item) => item.category === 'export_credit');
  const vatMatches = Array.from(text.matchAll(new RegExp(
    `Moms\\s+\\d+(?:[,.]\\d+)?%\\s+på\\s+${NUMBER_PATTERN}\\s+kr\\s+ingår med\\s+(${NUMBER_PATTERN})\\s+kr`,
    'gi',
  )));
  const vatSek = vatMatches.reduce((sum, match) => {
    const amount = parseEnergyNumber(match[1]);
    return sum + (amount ?? 0);
  }, 0);

  return {
    invoiceNumber: firstCapture(text, /OCR-\/Fakturanummer:\s*(\d{8,})/i),
    invoiceDate: parseCapturedDate(firstCapture(text, new RegExp(`Fakturadatum:\\s*(${ISO_DATE_PATTERN})`, 'i'))),
    periodStart: spot?.periodStart ?? null,
    periodEnd: spot?.periodEnd ?? null,
    consumptionKwh: spot?.quantity ?? null,
    exportedKwh: exportCredit?.quantity ?? null,
    peakDemandKw: null,
    vatSek: vatMatches.length > 0 ? roundMoney(vatSek) : null,
    totalAmountSek: parseCapturedNumber(lastCapture(
      text,
      new RegExp(`Summa Karlstads Energi AB\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'),
    )),
    lineItems,
    requiredChargeCategories: ['spot_energy', 'fixed_fee'],
  };
}

const TIBBER_USAGE_LINE_DEFINITIONS: Array<{
  label: string;
  category: EnergyChargeCategory;
}> = [
  { label: 'Spotpris', category: 'spot_energy' },
  { label: 'Fasta påslag', category: 'markup' },
  { label: 'Rörliga kostnader', category: 'variable_fee' },
  { label: 'Elproduktion', category: 'export_credit' },
];

function parseTibberUsageLine(
  text: string,
  label: string,
  category: EnergyChargeCategory,
): ParsedEnergyLineItem | null {
  const expression = new RegExp(
    `${label}\\s+för\\s+(${SWEDISH_DATE_PATTERN})\\s+-\\s+(${SWEDISH_DATE_PATTERN})\\s+(${NUMBER_PATTERN})\\s+kr\\s+(${NUMBER_PATTERN})\\s+kWh\\s+à\\s+(${NUMBER_PATTERN})\\s+öre\\/kWh`,
    'i',
  );
  const match = text.match(expression);
  if (!match) return null;

  return makeLineItem({
    category,
    label,
    amount: match[3],
    quantity: match[4],
    unit: 'kWh',
    unitPrice: match[5],
    unitPriceIsOre: true,
    periodStart: match[1],
    periodEnd: match[2],
    amountIncludesVat: false,
  });
}

function parseTibberFixedLine(
  text: string,
  label: string,
  category: 'fixed_fee' | 'discount',
): ParsedEnergyLineItem | null {
  const expression = new RegExp(
    `${label}\\s+för\\s+(${SWEDISH_DATE_PATTERN})\\s+-\\s+(${SWEDISH_DATE_PATTERN})\\s+(${NUMBER_PATTERN})\\s+kr\\s+(${NUMBER_PATTERN})\\s+dag(?:ar)?\\s+à\\s+(${NUMBER_PATTERN})\\s+kr\\/mån`,
    'i',
  );
  const match = text.match(expression);
  if (!match) return null;

  return makeLineItem({
    category,
    label,
    amount: match[3],
    quantity: match[4],
    unit: 'days',
    unitPrice: match[5],
    periodStart: match[1],
    periodEnd: match[2],
    amountIncludesVat: false,
  });
}

function parseTibber(text: string): ParsedFields {
  const lineItems = TIBBER_USAGE_LINE_DEFINITIONS
    .map(({ label, category }) => parseTibberUsageLine(text, label, category))
    .filter((item): item is ParsedEnergyLineItem => item !== null);
  pushIfPresent(lineItems, parseTibberFixedLine(text, 'Månadsavgift', 'fixed_fee'));
  pushIfPresent(lineItems, parseTibberFixedLine(text, 'Rabatt månadsavgift', 'discount'));

  const vatMatch = text.match(new RegExp(`Moms\\s+25%\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'));
  if (vatMatch) {
    pushIfPresent(lineItems, makeLineItem({
      category: 'vat',
      label: 'Moms 25%',
      amount: vatMatch[1],
      amountIncludesVat: true,
    }));
  }
  const spot = lineItems.find((item) => item.category === 'spot_energy');
  const exportCredit = lineItems.find((item) => item.category === 'export_credit');
  const transferAmount = lastCapture(
    text,
    new RegExp(`Överförs till nästkommande faktura\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'),
  );
  const payableAmount = lastCapture(
    text,
    new RegExp(`(?:Totalt att betala|Att betala)\\s+(${NUMBER_PATTERN})\\s+kr`, 'i'),
  );

  return {
    invoiceNumber: firstCapture(text, /Fakturanummer:\s*(\d{5,})/i),
    invoiceDate: parseCapturedDate(firstCapture(
      text,
      new RegExp(`Fakturadatum:\\s*(${SWEDISH_DATE_PATTERN})`, 'i'),
    )),
    periodStart: spot?.periodStart ?? null,
    periodEnd: spot?.periodEnd ?? null,
    consumptionKwh: spot?.quantity ?? null,
    exportedKwh: exportCredit?.quantity ?? null,
    peakDemandKw: null,
    vatSek: vatMatch ? parseEnergyNumber(vatMatch[1]) : null,
    totalAmountSek: parseCapturedNumber(transferAmount ?? payableAmount),
    lineItems,
    requiredChargeCategories: ['spot_energy', 'fixed_fee'],
  };
}

const PARSERS: ParserDefinition[] = [
  {
    id: 'ellevio_time_of_use',
    version: 1,
    label: 'Ellevio time-of-use tariff',
    documentKind: 'grid',
    providerKey: 'ellevio',
    providerName: 'Ellevio',
    matches: (text) => (
      /(?:Faktura elnät|Kreditfaktura)/i.test(text)
      && /Ellevio AB/i.test(text)
      && /Fast elnätsavgift/i.test(text)
      && /Rörlig elnätsavgift/i.test(text)
    ),
    parse: parseEllevioLegacy,
  },
  {
    id: 'ellevio_flat_transfer',
    version: 3,
    label: 'Ellevio flat transfer tariff (June 2026)',
    documentKind: 'grid',
    providerKey: 'ellevio',
    providerName: 'Ellevio',
    matches: (text) => (
      /Faktura elnät/i.test(text)
      && /Ellevio AB/i.test(text)
      && /Överföringsavgift/i.test(text)
      && /utan effektavgift/i.test(text)
    ),
    parse: (text) => parseEllevio(text, false),
  },
  {
    id: 'ellevio_peak_demand',
    version: 2,
    label: 'Ellevio peak-demand tariff',
    documentKind: 'grid',
    providerKey: 'ellevio',
    providerName: 'Ellevio',
    matches: (text) => (
      /Faktura elnät/i.test(text)
      && /Ellevio AB/i.test(text)
      && /Överföringsavgift/i.test(text)
      && /Effektavgift/i.test(text)
      && /Dina 3 högsta effekttoppar/i.test(text)
    ),
    parse: (text) => parseEllevio(text, true),
  },
  {
    id: 'karlstads_energi_microproduction',
    version: 3,
    label: 'Karlstads Energi monthly invoice with microproduction',
    documentKind: 'electricity',
    providerKey: 'karlstads_energi',
    providerName: 'Karlstads Energi',
    matches: (text) => (
      /Karlstads Energi AB/i.test(text)
      && /Medelspotpris/i.test(text)
      && /Elhandel Självfaktura/i.test(text)
      && /Energiersättning/i.test(text)
    ),
    parse: parseKarlstad,
  },
  {
    id: 'karlstads_energi_detailed',
    version: 1,
    label: 'Karlstads Energi detailed monthly fees',
    documentKind: 'electricity',
    providerKey: 'karlstads_energi',
    providerName: 'Karlstads Energi',
    matches: (text) => (
      /Karlstads Energi AB/i.test(text)
      && /Medelspotpris/i.test(text)
      && /Profilkostnad/i.test(text)
      && /Grundavgift SVK/i.test(text)
    ),
    parse: parseKarlstad,
  },
  {
    id: 'karlstads_energi_consolidated',
    version: 2,
    label: 'Karlstads Energi consolidated monthly fees',
    documentKind: 'electricity',
    providerKey: 'karlstads_energi',
    providerName: 'Karlstads Energi',
    matches: (text) => (
      /Karlstads Energi AB/i.test(text)
      && /Medelspotpris/i.test(text)
      && /Rörliga kostnader/i.test(text)
      && /Fast Påslag/i.test(text)
    ),
    parse: parseKarlstad,
  },
  {
    id: 'tibber_quarterly',
    version: 1,
    label: 'Tibber quarterly-price invoice',
    documentKind: 'electricity',
    providerKey: 'tibber',
    providerName: 'Tibber',
    matches: (text) => (
      /Tibber AB/i.test(text)
      && /Avtal:\s*Kvartspris/i.test(text)
      && /Spotpris för/i.test(text)
      && /Rörliga kostnader för/i.test(text)
    ),
    parse: parseTibber,
  },
  {
    id: 'varbergsortens_fixed_price',
    version: 1,
    label: 'Varbergsortens fixed-price electricity invoice',
    documentKind: 'electricity',
    providerKey: 'varbergsortens_elforsaljning',
    providerName: 'Varbergsortens Elförsäljning',
    matches: (text) => (
      /Varbergsortens Elförsäljning AB/i.test(text)
      && /Avstämd period/i.test(text)
      && /Summa Elhandel/i.test(text)
    ),
    parse: parseVarbergsortens,
  },
  {
    id: 'stockholms_elbolag_combined',
    version: 1,
    label: 'Stockholms Elbolag electricity invoice',
    documentKind: 'electricity',
    providerKey: 'stockholms_elbolag',
    providerName: 'Stockholms Elbolag',
    matches: (text) => (
      /Stockholms Elbolag AB/i.test(text)
      && /Fakturor\s*&\s*Avgifter\s+Elhandel/i.test(text)
      && /DITT ELAVTAL/i.test(text)
    ),
    parse: parseStockholmsElbolag,
  },
];

function isCalendarAlignedPeriod(periodStart: string, periodEnd: string): boolean {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return start.getUTCDate() === 1 && end.getUTCDate() === lastDay;
}

function unknownResult(): ParsedEnergyDocument {
  return {
    formatRecognized: false,
    importable: false,
    documentKind: null,
    providerKey: null,
    providerName: null,
    parserId: null,
    parserVersion: null,
    recognitionLabel: null,
    invoiceNumber: null,
    invoiceDate: null,
    periodStart: null,
    periodEnd: null,
    consumptionKwh: null,
    exportedKwh: null,
    peakDemandKw: null,
    vatSek: null,
    totalAmountSek: null,
    currency: 'SEK',
    lineItems: [],
    errors: ['unknown_format'],
    warnings: [],
  };
}

export function parseEnergyBillingDocument(
  rawText: string,
  expectedKind?: EnergyDocumentKind,
): ParsedEnergyDocument {
  const text = normalizeText(rawText);
  const parser = PARSERS.find((candidate) => candidate.matches(text));
  if (!parser) return unknownResult();

  const fields = parser.parse(text);
  const errors: EnergyParserIssueCode[] = [];
  const warnings: EnergyParserIssueCode[] = [];

  if (expectedKind && parser.documentKind !== expectedKind) errors.push('wrong_document_kind');
  if (!fields.invoiceNumber) errors.push('missing_invoice_number');
  if (!fields.invoiceDate) errors.push('missing_invoice_date');
  if (!fields.periodStart || !fields.periodEnd) {
    errors.push('missing_service_period');
  } else if (fields.periodStart > fields.periodEnd) {
    errors.push('invalid_service_period');
  } else if (!isCalendarAlignedPeriod(fields.periodStart, fields.periodEnd)) {
    warnings.push('partial_service_period');
  }
  if (fields.consumptionKwh === null) errors.push('missing_consumption');
  if (fields.totalAmountSek === null) errors.push('missing_total');
  if (
    fields.requiredChargeCategories.some(
      (category) => !fields.lineItems.some((lineItem) => lineItem.category === category),
    )
  ) {
    errors.push('missing_required_charges');
  }

  return {
    formatRecognized: true,
    importable: errors.length === 0,
    documentKind: parser.documentKind,
    providerKey: parser.providerKey,
    providerName: parser.providerName,
    parserId: parser.id,
    parserVersion: parser.version,
    recognitionLabel: parser.label,
    invoiceNumber: fields.invoiceNumber,
    invoiceDate: fields.invoiceDate,
    periodStart: fields.periodStart,
    periodEnd: fields.periodEnd,
    consumptionKwh: fields.consumptionKwh,
    exportedKwh: fields.exportedKwh,
    peakDemandKw: fields.peakDemandKw,
    vatSek: fields.vatSek,
    totalAmountSek: fields.totalAmountSek,
    currency: 'SEK',
    lineItems: fields.lineItems,
    errors,
    warnings,
  };
}
