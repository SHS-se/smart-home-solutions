// Parser for Boverket energideklaration PDFs.
//
// Why this belongs in the existing upload pipeline (Energy history → Data):
// a customer's official certificate is the only authoritative statement about
// their building that we can obtain without a year of measurement. It gives a
// surveyed Atemp, a certified energy class, a normal-year energy figure, and
// Boverket's own "similar buildings" reference value — the last of which is the
// only external check we have on the archetype priors in `energy-archetypes.ts`.
//
// Two shapes exist in the wild and both are accepted:
//   - the one-page "sammanfattning av ENERGIDEKLARATION" most owners have;
//   - the full multi-page declaration, which additionally carries the numbered
//     energy posts and the measurement period.
//
// The numbered posts (1)–(19) are a stable part of Boverket's form, so they are
// parsed by number rather than by label. Labels are translated, reordered and
// footnote-marked between versions; the numbers are not.
//
// Verified against declaration 1110952 (2020-08-27), retained in
// `docs/energideklaration-1110952-2020.pdf`.

/** Boverket's numbered energy posts. Stable across form versions. */
export const DECLARATION_POSTS: Readonly<Record<number, string>> = {
  1: 'fjarrvarme',
  2: 'eldningsolja',
  3: 'naturgas_stadsgas',
  4: 'ved',
  5: 'flis_pellets_briketter',
  6: 'ovrigt_biobransle',
  7: 'el_vattenburen',
  8: 'el_direktverkande',
  9: 'el_luftburen',
  10: 'markvarmepump_el',
  11: 'varmepump_franluft_el',
  12: 'varmepump_luft_luft_el',
  13: 'varmepump_luft_vatten_el',
  14: 'tappvarmvatten_el',
  15: 'fjarrkyla',
  16: 'el_komfortkyla',
  17: 'fastighetsel',
  18: 'hushallsel',
  19: 'verksamhetsel',
};

/** Posts that are excluded from the primary-energy number by definition. */
export const EXCLUDED_POSTS = [18, 19] as const;

export type EnergyDeclarationIssue =
  | 'not_a_declaration'
  | 'missing_primary_energy'
  | 'missing_energy_class'
  | 'missing_atemp'
  | 'missing_issue_date';

export interface ParsedEnergyDeclaration {
  formatRecognized: boolean;
  importable: boolean;
  /** Boverket's Energideklarations-ID. */
  declarationId: string | null;
  issuedOn: string | null;
  validUntil: string | null;
  /** Primary energy number as printed, on the factor in force when issued. */
  primaryEnergyKwhM2: number | null;
  energyClass: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | null;
  /** Referensvärde 1: the new-build requirement for this building. */
  newBuildRequirementKwhM2: number | null;
  /** Referensvärde 2: Boverket's own figure for similar buildings. */
  similarBuildingsKwhM2: number | null;
  /** The pre-2011 metric, kWh/m² without primary-energy weighting. */
  specificEnergyKwhM2: number | null;
  /** Surveyed Atemp, excluding warm garage. Authoritative over our estimate. */
  atempM2: number | null;
  yearBuilt: number | null;
  heatingSystem: string | null;
  municipality: string | null;
  address: string | null;
  ventilationType: string | null;
  /** Normal-year corrected building energy, kWh/year. */
  buildingEnergyKwhPerYear: number | null;
  /** Weighted primary energy, kWh/year. */
  primaryEnergyKwhPerYear: number | null;
  /** Measured energy by Boverket post number, kWh over the measured period. */
  postsKwh: Record<number, number>;
  measurementPeriodStart: string | null;
  measurementPeriodEnd: string | null;
  /**
   * Electricity weighting factor implied by the document itself
   * (primary ÷ building energy), when both are present. This is how we detect
   * a pre-BBR-29 certificate without trusting the issue date alone.
   */
  impliedWeightingFactor: number | null;
  errors: EnergyDeclarationIssue[];
}

const EMPTY: ParsedEnergyDeclaration = {
  formatRecognized: false,
  importable: false,
  declarationId: null,
  issuedOn: null,
  validUntil: null,
  primaryEnergyKwhM2: null,
  energyClass: null,
  newBuildRequirementKwhM2: null,
  similarBuildingsKwhM2: null,
  specificEnergyKwhM2: null,
  atempM2: null,
  yearBuilt: null,
  heatingSystem: null,
  municipality: null,
  address: null,
  ventilationType: null,
  buildingEnergyKwhPerYear: null,
  primaryEnergyKwhPerYear: null,
  postsKwh: {},
  measurementPeriodStart: null,
  measurementPeriodEnd: null,
  impliedWeightingFactor: null,
  errors: [],
};

/**
 * Extracted PDF text carries soft hyphens, non-breaking spaces and inconsistent
 * spacing around units ("19567kWh/år", "72kWh/m² ,år", "2020 ­ 08 ­ 27").
 * Normalising once is far more robust than making every pattern tolerant.
 */
function normalize(raw: string): string {
  return raw
    .replace(/\u00ad/g, '') // soft hyphen, e.g. "2020 - 08 - 27"
    .replace(/[\u00a0\u2007\u202f]/g, ' ') // non-breaking spaces
    .replace(/[\u2010-\u2015]/g, '-') // dash variants
    .replace(/\r\n?/g, '\n');
}

function number(match: RegExpMatchArray | null, group = 1): number | null {
  if (!match) return null;
  const value = Number(match[group].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** "1908 - 2007" means 2019-08 through 2020-07: YYMM, first month to last. */
function measurementPeriod(text: string): { start: string | null; end: string | null } {
  const match = text.match(/(\d{4})\s*-\s*(\d{4})(?![\d-])/);
  if (!match) return { start: null, end: null };
  const toIso = (yymm: string): string | null => {
    const year = Number(yymm.slice(0, 2));
    const month = Number(yymm.slice(2, 4));
    if (month < 1 || month > 12) return null;
    return `${2000 + year}-${String(month).padStart(2, '0')}-01`;
  };
  const start = toIso(match[1]);
  const end = toIso(match[2]);
  if (start === null || end === null || end < start) return { start: null, end: null };
  return { start, end };
}

function posts(text: string): Record<number, number> {
  const found: Record<number, number> = {};
  // "(8) 2200 kWh" — a post with no value prints "(2) kWh" and must not match.
  const pattern = /\((\d{1,2})\)\s*(\d[\d\s]*?)\s*kWh/g;
  for (const match of text.matchAll(pattern)) {
    const post = Number(match[1]);
    if (!(post in DECLARATION_POSTS)) continue;
    const value = Number(match[2].replace(/\s/g, ''));
    if (Number.isFinite(value)) found[post] = value;
  }
  return found;
}

export function parseEnergyDeclaration(rawText: string): ParsedEnergyDeclaration {
  const text = normalize(rawText);

  const looksLikeDeclaration = /ENERGIDEKLARATION/i.test(text)
    && /(primärenergital|Energideklarations-ID|Energiklass)/i.test(text);
  if (!looksLikeDeclaration) {
    return { ...EMPTY, errors: ['not_a_declaration'] };
  }

  const declarationId = text.match(/Energideklarations-ID:?\s*(\d+)/i)?.[1] ?? null;
  const energyClass = (text.match(/Energiklass\s*([A-G])\b/i)?.[1]?.toUpperCase()
    ?? null) as ParsedEnergyDeclaration['energyClass'];

  const primaryEnergyKwhM2 = number(
    text.match(/Energiprestanda,\s*primärenergital:?\s*\n?\s*(\d+(?:[.,]\d+)?)\s*kWh/i),
  );
  const specificEnergyKwhM2 = number(
    text.match(/tidigare energiprestanda\)?:?\s*\n?\s*(\d+(?:[.,]\d+)?)\s*kWh/i),
  );

  // Page 4 prints the three reference values on one line:
  // "72kWh/m² ,år 90 kWh/m² ,år 148 kWh/m² ,år"
  const referenceRow = text.match(
    /(?:^|\s)(\d+(?:[.,]\d+)?)\s*kWh\/m²\s*,?\s*år\s+(\d+(?:[.,]\d+)?)\s*kWh\/m²\s*,?\s*år\s+(\d+(?:[.,]\d+)?)\s*kWh\/m²/im,
  );
  const newBuildRequirementKwhM2 = number(referenceRow, 2)
    ?? number(text.match(/Energiklass\s*[A-G],\s*(\d+(?:[.,]\d+)?)\s*kWh/i));
  const similarBuildingsKwhM2 = number(referenceRow, 3);

  const atempM2 = number(text.match(/Atemp[\s\S]{0,220}?(?:^|\s)(\d[\d ]{0,6})\s*m²/im));
  const yearBuilt = number(text.match(/Nybyggnadsår:?\s*\n?\s*(\d{4})/i));

  // Boverket prints these two side by side: "19567kWh/år 31307kWh/år".
  //
  // The leading `(?:^|\s)` and the space-only inner class are load-bearing. The
  // heading above them ends in a footnote marker ("primärenergianvändning6"),
  // and a pattern that allowed the digit run to start mid-word or to span a
  // newline read that 6 as part of the value — 19,567 became 619,567, which in
  // turn made the implied weighting factor nonsense. Caught by the fixture,
  // not by the live document, which happened to lay out differently.
  const energyPerYear = text.match(
    /(?:^|\s)(\d[\d ]*?)\s*kWh\/år\s+(\d[\d ]*?)\s*kWh\/år/im,
  );
  const buildingEnergyKwhPerYear = number(energyPerYear, 1);
  const primaryEnergyKwhPerYear = number(energyPerYear, 2);

  const issuedOn = text.match(/Datum för godkännande[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})/i)?.[1]
    ?? text.match(/(\d{4})\s*-?\s*(\d{2})\s*-?\s*(\d{2})\s*$/m)?.[0]?.replace(/\s/g, '')
    ?? null;
  const validUntil = text.match(/giltig till:?\s*\n?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;

  const heatingSystem = text
    .match(/Uppvärmningssystem:?\s*\n([\s\S]{0,90}?)(?:\nRadonmätning|\nÅtgärdsförslag|\n\n)/i)?.[1]
    ?.replace(/\s*\n\s*/g, ' ')
    .trim() ?? null;
  const municipality = text.match(/^([A-ZÅÄÖ][\wåäöÅÄÖ\- ]+?)\s+kommun$/im)?.[1]?.trim() ?? null;
  const address = text.match(/^(.+?,\s*\d{3}\s?\d{2}\s+[A-ZÅÄÖ][\wåäöÅÄÖ\- ]+)$/m)?.[1]?.trim()
    ?? null;
  const ventilationType = /Självdrag/i.test(text)
    ? 'sjalvdrag'
    : /FTX/i.test(text)
      ? 'ftx'
      : null;

  const period = measurementPeriod(text);

  const impliedWeightingFactor =
    buildingEnergyKwhPerYear !== null
    && primaryEnergyKwhPerYear !== null
    && buildingEnergyKwhPerYear > 0
      ? primaryEnergyKwhPerYear / buildingEnergyKwhPerYear
      : null;

  const errors: EnergyDeclarationIssue[] = [];
  if (primaryEnergyKwhM2 === null) errors.push('missing_primary_energy');
  if (energyClass === null) errors.push('missing_energy_class');
  if (issuedOn === null && validUntil === null) errors.push('missing_issue_date');

  return {
    formatRecognized: true,
    importable: errors.length === 0,
    declarationId,
    issuedOn,
    validUntil,
    primaryEnergyKwhM2,
    energyClass,
    newBuildRequirementKwhM2,
    similarBuildingsKwhM2,
    specificEnergyKwhM2,
    atempM2,
    yearBuilt,
    heatingSystem,
    municipality,
    address,
    ventilationType,
    buildingEnergyKwhPerYear,
    primaryEnergyKwhPerYear,
    postsKwh: posts(text),
    measurementPeriodStart: period.start,
    measurementPeriodEnd: period.end,
    impliedWeightingFactor,
    errors,
  };
}

/**
 * The weighting factor to restate this certificate with.
 *
 * Prefer the factor the document itself implies over the issue date: it is
 * derived from two printed numbers and is immune to a misparsed date or to a
 * certificate issued under transitional rules. Rounded to one decimal because
 * the printed values are whole kWh.
 */
export function declaredWeightingFactor(
  parsed: ParsedEnergyDeclaration,
): number | null {
  if (parsed.impliedWeightingFactor === null) return null;
  const rounded = Math.round(parsed.impliedWeightingFactor * 10) / 10;
  return rounded >= 1 && rounded <= 3 ? rounded : null;
}
