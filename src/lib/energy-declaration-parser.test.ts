/// <reference lib="deno.ns" />

// Fixture text is the real extraction of declaration 1110952, retained at
// docs/energideklaration-1110952-2020.pdf. Soft hyphens in the summary date and
// the run-together units ("19567kWh/år", "72kWh/m² ,år") are preserved on
// purpose — they are what a PDF text layer actually produces, and they are the
// reason the parser normalises before matching.

import {
  declaredWeightingFactor,
  parseEnergyDeclaration,
} from './energy-declaration-parser.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

const SUMMARY_PAGE = `sammanfattning av
ENERGIDEKLARATION
Porfyrvägen 10, 187 34 Täby
Täby kommun
Nybyggnadsår: 1970
Energideklarations-ID: 1110952
Energiprestanda, primärenergital:
72 kWh/m² och år
Krav vid uppförande av
ny byggnad, primärenergital:
Energiklass C, 90 kWh/m² och år
Specifik energianvändning
(tidigare energiprestanda):
45 kWh/m² och år
Uppvärmningssystem:
Värmepump-luft/luft (el) och el
(direktverkande)
Radonmätning:
Utförd
Energideklarationen är utförd av:
John Eriksson, Svensk
Kvalitetssäkring, 2020 ­ 08 ­ 27
Energideklarationen är giltig till:
2030-08-27`;

const FULL_DECLARATION = `${SUMMARY_PAGE}
Byggnadens - Egenskaper
Typkod Byggnadskategori
220 - Småhusenhet, bebyggd En- och tvåbostadshus
Byggnadens komplexitet Byggnadstyp Nybyggnadsår
Enkel Komplex Friliggande 1970
Atemp mätt värde (exkl. Avarmgarage) Verksamhet Procent av
Fördela enligt nedan: Atemp (exkl.
435 m²
Avarmgarage)
Energianvändning
Mätperiod
1908 - 2007
Fjärrvärme (1) kWh
Eldningsolja (2) kWh
Ved (4) kWh
El (vattenburen) (7) kWh
El (direktverkande) (8) 2200 kWh
Markvärmepump (el) (10) kWh
Värmepump-luft/luft (el) (12) 8350 kWh
Tappvarmvatten (el) (14) 6700 kWh
Fjärrkyla (15) kWh
Fastighetsel¹ (17) kWh
Hushållsel² (18) 13050 kWh
Summa 1 - 174 17250 kWh
Byggnadens energianvändning5 Byggnadens primärenergianvändning6
19567kWh/år 31307kWh/år
Energiprestanda Referensvärde 1 Referensvärde 2 Referensvärde 3
72kWh/m² ,år 90 kWh/m² ,år 148 kWh/m² ,år kWh/m² ,år
Typ av ventilationssystem FTX FT F med återvinning
F Självdrag
Expert
Datum för godkännande E-postadress
2020-08-27 john.eriksson@svks.se`;

Deno.test('rejects a document that is not an energy declaration', () => {
  const parsed = parseEnergyDeclaration('Faktura 12345\nEllevio AB\nElnätsavgift 450 kr');
  assertEqual(parsed.formatRecognized, false, 'formatRecognized');
  assertEqual(parsed.importable, false, 'importable');
  assertEqual(parsed.errors[0], 'not_a_declaration', 'error code');
});

Deno.test('parses the one-page summary most owners have', () => {
  const parsed = parseEnergyDeclaration(SUMMARY_PAGE);
  assertEqual(parsed.importable, true, 'importable');
  assertEqual(parsed.declarationId, '1110952', 'declaration id');
  assertEqual(parsed.primaryEnergyKwhM2, 72, 'primary energy');
  assertEqual(parsed.energyClass, 'C', 'energy class');
  assertEqual(parsed.newBuildRequirementKwhM2, 90, 'new-build requirement');
  assertEqual(parsed.specificEnergyKwhM2, 45, 'specific energy');
  assertEqual(parsed.yearBuilt, 1970, 'year built');
  assertEqual(parsed.municipality, 'Täby', 'municipality');
  assertEqual(parsed.validUntil, '2030-08-27', 'valid until');
});

Deno.test('parses the full declaration including the numbered posts', () => {
  const parsed = parseEnergyDeclaration(FULL_DECLARATION);

  assertEqual(parsed.importable, true, 'importable');
  assertEqual(parsed.atempM2, 435, 'surveyed Atemp');
  assertEqual(parsed.buildingEnergyKwhPerYear, 19567, 'normal-year building energy');
  assertEqual(parsed.primaryEnergyKwhPerYear, 31307, 'primary energy per year');
  assertEqual(parsed.similarBuildingsKwhM2, 148, 'Referensvärde 2');
  assertEqual(parsed.issuedOn, '2020-08-27', 'issue date');
  assertEqual(parsed.ventilationType, 'sjalvdrag', 'ventilation');

  assertEqual(parsed.postsKwh[8], 2200, 'post 8, el direktverkande');
  assertEqual(parsed.postsKwh[12], 8350, 'post 12, luft/luft heat pump');
  assertEqual(parsed.postsKwh[14], 6700, 'post 14, hot water');
  assertEqual(parsed.postsKwh[18], 13050, 'post 18, household electricity');
});

Deno.test('a post printed without a value is absent, not zero', () => {
  // "Fjärrvärme (1) kWh" must not be read as a number, or an all-electric house
  // gains phantom district heating.
  const parsed = parseEnergyDeclaration(FULL_DECLARATION);
  assertEqual(parsed.postsKwh[1], undefined, 'post 1 absent');
  assertEqual(parsed.postsKwh[17], undefined, 'post 17 absent');
  assertEqual(Object.keys(parsed.postsKwh).length, 4, 'only the four printed posts');
});

Deno.test('"Summa 1 - 174 17250 kWh" is not mistaken for a post', () => {
  const parsed = parseEnergyDeclaration(FULL_DECLARATION);
  for (const post of Object.keys(parsed.postsKwh)) {
    assert(Number(post) <= 19, `post number ${post} is out of range`);
  }
  assertEqual(parsed.postsKwh[17], undefined, 'the summa line did not become post 17');
});

Deno.test('the measurement period decodes YYMM into real dates', () => {
  const parsed = parseEnergyDeclaration(FULL_DECLARATION);
  assertEqual(parsed.measurementPeriodStart, '2019-08-01', 'period start');
  assertEqual(parsed.measurementPeriodEnd, '2020-07-01', 'period end');
});

Deno.test('the weighting factor is taken from the document, not the date', () => {
  const parsed = parseEnergyDeclaration(FULL_DECLARATION);
  // 31,307 / 19,567 = 1.6000 — this certificate predates BBR 29.
  assert(
    Math.abs((parsed.impliedWeightingFactor ?? 0) - 1.6) < 0.001,
    `implied factor was ${parsed.impliedWeightingFactor}`,
  );
  assertEqual(declaredWeightingFactor(parsed), 1.6, 'rounded factor');
});

Deno.test('an implausible implied factor is rejected rather than used', () => {
  const broken = FULL_DECLARATION.replace('31307kWh/år', '99999999kWh/år');
  assertEqual(declaredWeightingFactor(parseEnergyDeclaration(broken)), null, 'rejected');
});

Deno.test('soft hyphens and run-together units do not defeat the parser', () => {
  const parsed = parseEnergyDeclaration(FULL_DECLARATION);
  // These are the exact artefacts of the real PDF text layer.
  assert(FULL_DECLARATION.includes('2020 ­ 08 ­ 27'), 'fixture keeps the soft hyphens');
  assert(FULL_DECLARATION.includes('19567kWh/år'), 'fixture keeps the run-together unit');
  assertEqual(parsed.buildingEnergyKwhPerYear, 19567, 'parsed anyway');
});

Deno.test('a declaration missing its class is not importable', () => {
  const parsed = parseEnergyDeclaration(SUMMARY_PAGE.replace('Energiklass C,', ''));
  assertEqual(parsed.formatRecognized, true, 'still recognised as a declaration');
  assertEqual(parsed.importable, false, 'not importable');
  assert(parsed.errors.includes('missing_energy_class'), 'names the missing field');
});
