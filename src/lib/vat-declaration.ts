export interface VatDeclarationRawAmounts {
  box05: number;
  box10: number;
  box11: number;
  box12: number;
  box20: number;
  box21: number;
  box22: number;
  box30: number;
  box31: number;
  box32: number;
  box48: number;
}

export interface VatDeclarationRoundedAmounts extends Record<keyof VatDeclarationRawAmounts, number> {
  momsBetala: number;
}

export interface VatDeclarationXmlBox {
  xmlTag: string;
  amount: number;
}

export type DeclarationBoxFilter = '20' | '21' | '22' | '30' | '31' | '32' | '48';

export interface VatDeclarationXmlValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface DeclarationBoxPurchaseLike {
  lines: Array<{
    vat_treatment: string;
    gross_amount?: number | null;
    net_amount?: number | null;
    vat_amount?: number | null;
    /** Percent (25/12/6), as stored on acc_purchase_lines. */
    vat_rate?: number | null;
  }>;
}

export interface DeclarationBoxLineTotals {
  gross: number;
  net: number;
  vat: number;
}

function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Skatteverket VAT declarations are filed in whole kronor with the öre
 * dropped ("öretalen faller bort"), i.e. truncated toward zero — not rounded
 * to the nearest krona.
 */
export function roundVatDeclarationAmount(amount: number): number {
  return Math.trunc(amount);
}

const REVERSE_CHARGE_TREATMENTS = new Set([
  'reverse_charge_eu_goods',
  'reverse_charge_eu_services',
  'reverse_charge_non_eu_services',
]);

/**
 * The Swedish VAT rate that applies to a reverse-charge purchase line, used
 * for the deemed output VAT (boxes 30/31/32) and the matching input VAT
 * deduction (box 48). Lines with a missing or unrecognised rate fall back to
 * 25% — the correct rate for virtually everything this business buys.
 */
export function reverseChargeVatRate(line: DeclarationBoxPurchaseLike['lines'][number]): 25 | 12 | 6 {
  const rate = Number(line.vat_rate);
  if (rate === 12 || rate === 6) return rate;
  return 25;
}

export function finalizeVatDeclarationAmounts(raw: VatDeclarationRawAmounts): VatDeclarationRoundedAmounts {
  const rounded = {
    box05: roundVatDeclarationAmount(raw.box05),
    box10: roundVatDeclarationAmount(raw.box10),
    box11: roundVatDeclarationAmount(raw.box11),
    box12: roundVatDeclarationAmount(raw.box12),
    box20: roundVatDeclarationAmount(raw.box20),
    box21: roundVatDeclarationAmount(raw.box21),
    box22: roundVatDeclarationAmount(raw.box22),
    box30: roundVatDeclarationAmount(raw.box30),
    box31: roundVatDeclarationAmount(raw.box31),
    box32: roundVatDeclarationAmount(raw.box32),
    box48: roundVatDeclarationAmount(raw.box48),
  };

  return {
    ...rounded,
    momsBetala: (rounded.box10 + rounded.box11 + rounded.box12 + rounded.box30 + rounded.box31 + rounded.box32) - rounded.box48,
  };
}

export function buildSkatteverketXml(
  orgNr: string,
  periodYYYYMM: string,
  declarationBoxes: VatDeclarationXmlBox[],
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="ISO-8859-1"?>',
    '<!DOCTYPE eSKDUpload PUBLIC "-//Skatteverket, Sweden//DTD Skatteverket eSKDUpload-DTD Version 6.0//SV" "https://www1.skatteverket.se/demoeskd/eSKDUpload_6p0.dtd">',
    '<eSKDUpload Version="6.0">',
    `<OrgNr>${orgNr}</OrgNr>`,
    '<Moms>',
    `<Period>${periodYYYYMM}</Period>`,
  ];

  for (const box of declarationBoxes) {
    if (box.xmlTag === 'MomsBetala' || box.amount !== 0) {
      lines.push(`<${box.xmlTag}>${box.amount}</${box.xmlTag}>`);
    }
  }

  lines.push('</Moms>');
  lines.push('</eSKDUpload>');
  return lines.join('\n');
}

export function isDeclarationBoxFilter(value: string | null | undefined): value is DeclarationBoxFilter {
  return value === '20' || value === '21' || value === '22'
    || value === '30' || value === '31' || value === '32' || value === '48';
}

export function lineMatchesDeclarationBox(
  line: DeclarationBoxPurchaseLike['lines'][number],
  box: DeclarationBoxFilter,
): boolean {
  switch (box) {
    case '20':
      return line.vat_treatment === 'reverse_charge_eu_goods';
    case '21':
      return line.vat_treatment === 'reverse_charge_eu_services';
    case '22':
      return line.vat_treatment === 'reverse_charge_non_eu_services';
    case '30':
      return REVERSE_CHARGE_TREATMENTS.has(line.vat_treatment) && reverseChargeVatRate(line) === 25;
    case '31':
      return REVERSE_CHARGE_TREATMENTS.has(line.vat_treatment) && reverseChargeVatRate(line) === 12;
    case '32':
      return REVERSE_CHARGE_TREATMENTS.has(line.vat_treatment) && reverseChargeVatRate(line) === 6;
    case '48':
      return (
        line.vat_treatment === 'domestic_deductible' ||
        REVERSE_CHARGE_TREATMENTS.has(line.vat_treatment)
      );
    default:
      return false;
  }
}

export function purchaseMatchesDeclarationBox(
  purchase: DeclarationBoxPurchaseLike,
  box: DeclarationBoxFilter,
): boolean {
  return purchase.lines.some((line) => lineMatchesDeclarationBox(line, box));
}

export function summarizeDeclarationBoxLines(
  lines: DeclarationBoxPurchaseLike['lines'],
  box: DeclarationBoxFilter,
): DeclarationBoxLineTotals {
  return lines.reduce<DeclarationBoxLineTotals>((summary, line) => {
    if (!lineMatchesDeclarationBox(line, box)) return summary;

    return {
      gross: summary.gross + Number(line.gross_amount ?? 0),
      net: summary.net + Number(line.net_amount ?? 0),
      vat: summary.vat + Number(line.vat_amount ?? 0),
    };
  }, { gross: 0, net: 0, vat: 0 });
}

export function calculateDeclarationBoxAmount(
  lines: DeclarationBoxPurchaseLike['lines'],
  box: DeclarationBoxFilter,
): number {
  const matchingLines = lines.filter((line) => lineMatchesDeclarationBox(line, box));

  switch (box) {
    case '20':
    case '21':
    case '22':
      return matchingLines.reduce((sum, line) => sum + Number(line.net_amount ?? 0), 0);
    case '30':
    case '31':
    case '32':
      // Deemed output VAT on reverse-charge purchases at the line's rate.
      return matchingLines.reduce(
        (sum, line) => sum + roundToCents(Number(line.net_amount ?? 0) * reverseChargeVatRate(line) / 100),
        0,
      );
    case '48':
      return matchingLines.reduce((sum, line) => {
        if (line.vat_treatment === 'domestic_deductible') {
          return sum + Number(line.vat_amount ?? 0);
        }

        return sum + roundToCents(Number(line.net_amount ?? 0) * reverseChargeVatRate(line) / 100);
      }, 0);
    default:
      return 0;
  }
}

function parseSingleTag(xml: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escaped}>([^<]+)</${escaped}>`));
  return match ? match[1].trim() : null;
}

function parseSection(xml: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`));
  return match ? match[1] : null;
}

function parseIntegerTag(xml: string, tagName: string): { raw: string | null; value: number | null } {
  const raw = parseSingleTag(xml, tagName);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    return { raw, value: null };
  }
  return { raw, value: Number(raw) };
}

export function validateSkatteverketXml(params: {
  xml: string;
  expectedOrgNr: string;
  expectedPeriodYYYYMM: string;
  declarationBoxes: VatDeclarationXmlBox[];
}): VatDeclarationXmlValidationResult {
  const { xml, expectedOrgNr, expectedPeriodYYYYMM, declarationBoxes } = params;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!xml.startsWith('<?xml version="1.0" encoding="ISO-8859-1"?>')) {
    errors.push('Missing or incorrect XML declaration.');
  }

  if (!xml.includes('<!DOCTYPE eSKDUpload PUBLIC "-//Skatteverket, Sweden//DTD Skatteverket eSKDUpload-DTD Version 6.0//SV"')) {
    errors.push('Missing or incorrect Skatteverket DTD declaration.');
  }

  if (!/<eSKDUpload\s+Version="6\.0">/.test(xml)) {
    errors.push('Root element eSKDUpload with Version="6.0" is missing.');
  }

  const orgNr = parseSingleTag(xml, 'OrgNr');
  if (orgNr !== expectedOrgNr) {
    errors.push(`OrgNr mismatch: expected ${expectedOrgNr}, got ${orgNr ?? 'missing'}.`);
  }

  const momsSection = parseSection(xml, 'Moms');
  if (!momsSection) {
    errors.push('Missing Moms section.');
  } else {
    const period = parseSingleTag(momsSection, 'Period');
    if (period !== expectedPeriodYYYYMM) {
      errors.push(`Period mismatch: expected ${expectedPeriodYYYYMM}, got ${period ?? 'missing'}.`);
    }

    const momsTagMatches = [...momsSection.matchAll(/<([A-Za-z][A-Za-z0-9]*)>/g)].map((match) => match[1]);
    const allowedTags = new Set(['Period', ...declarationBoxes.map((box) => box.xmlTag)]);
    for (const tag of momsTagMatches) {
      if (!allowedTags.has(tag)) {
        warnings.push(`Unexpected VAT tag in Moms section: ${tag}.`);
      }
    }

    const expectedTagAmounts = new Map(
      declarationBoxes
        .filter((box) => box.xmlTag === 'MomsBetala' || box.amount !== 0)
        .map((box) => [box.xmlTag, box.amount]),
    );

    for (const [xmlTag, amount] of expectedTagAmounts.entries()) {
      const parsed = parseIntegerTag(momsSection, xmlTag);
      if (parsed.value === null) {
        errors.push(`Missing or non-integer value for ${xmlTag}.`);
        continue;
      }
      if (parsed.value !== amount) {
        errors.push(`${xmlTag} mismatch: expected ${amount}, got ${parsed.value}.`);
      }
    }

    const parsedBox10 = parseIntegerTag(momsSection, 'MomsUtgHog').value ?? 0;
    const parsedBox11 = parseIntegerTag(momsSection, 'MomsUtgMedel').value ?? 0;
    const parsedBox12 = parseIntegerTag(momsSection, 'MomsUtgLag').value ?? 0;
    const parsedBox30 = parseIntegerTag(momsSection, 'MomsInkopUtgHog').value ?? 0;
    const parsedBox31 = parseIntegerTag(momsSection, 'MomsInkopUtgMedel').value ?? 0;
    const parsedBox32 = parseIntegerTag(momsSection, 'MomsInkopUtgLag').value ?? 0;
    const parsedBox48 = parseIntegerTag(momsSection, 'MomsIngAvdr').value ?? 0;
    const parsedMomsBetala = parseIntegerTag(momsSection, 'MomsBetala').value;
    const expectedMomsBetala = (parsedBox10 + parsedBox11 + parsedBox12 + parsedBox30 + parsedBox31 + parsedBox32) - parsedBox48;

    if (parsedMomsBetala === null) {
      errors.push('Missing or non-integer value for MomsBetala.');
    } else if (parsedMomsBetala !== expectedMomsBetala) {
      errors.push(`MomsBetala does not reconcile with the XML values: expected ${expectedMomsBetala}, got ${parsedMomsBetala}.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
