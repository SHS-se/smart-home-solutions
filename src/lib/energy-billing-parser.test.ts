/// <reference lib="deno.ns" />

import {
  parseEnergyBillingDocument,
  parseEnergyDate,
  parseEnergyNumber,
} from './energy-billing-parser.ts';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const ELLEVIO_PEAK_TEXT = `
  Faktura elnät 6 oktober 2025
  Faktura/OCR-nummer: 6504083761333
  Ellevio AB (publ)
  Belopp att betala: 2 158,00 kr
  Moms 25%: 431,60 kr
  Kostnad 1 sep 2025 t o m 30 sep 2025
  Fast avgift 30 dagar 915,00 kr/mån 915,00 kr
  Överföringsavgift 1 323 kWh 6,25 öre/kWh 82,66 kr
  Effektavgift 5,35 kW 81,25 kr/kW, mån 434,53 kr
  Dina 3 högsta effekttoppar
  Energiskatt 1 323 kWh 54,88 öre/kWh 725,82 kr
`;

const ELLEVIO_FLAT_EXPORT_TEXT = `
  Faktura elnät 6 juli 2026
  Faktura/OCR-nummer: 6604848654532
  Ellevio AB (publ)
  Belopp att betala: 1 144,00 kr
  Moms 25%: 231,01 kr
  Sedan den 1 juni 2026 består din elnätskostnad av en fast avgift och en rörlig
  överföringsavgift, utan effektavgift.
  Kostnad 1 jun 2026 t o m 30 jun 2026
  Fast avgift 30 dagar 1 130,00 kr/mån 1 130,00 kr
  Överföringsavgift 35 kWh 26,00 öre/kWh 9,16 kr
  Energiskatt 35 kWh 45,00 öre/kWh 15,87 kr
  Produktionsersättning, Elnät Låglast 337 kWh -3,30 öre/kWh -11,11 kr
`;

const KARLSTAD_DETAILED_TEXT = `
  Fakturadatum: 2025-08-14
  OCR-/Fakturanummer: 40487450211
  Karlstads Energi AB
  Medelspotpris 2025-07-01 - 2025-07-31 1543 kWh 46,266 öre/kWh 713,89 kr
  x Profilkostnad 2025-07-01 - 2025-07-31 1543 kWh 1,563 öre/kWh 24,11 kr
  x Elcertifikat 2025-07-01 - 2025-07-31 1543 kWh 0,100 öre/kWh 1,54 kr
  x Ursprungsgarantier 2025-07-01 - 2025-07-31 1543 kWh 0,300 öre/kWh 4,63 kr
  x Grundavgift SVK 2025-07-01 - 2025-07-31 1543 kWh 2,790 öre/kWh 43,05 kr
  x Balansansvar & rörlig obalans 2025-07-01 - 2025-07-31 1543 kWh 0,426 öre/kWh 6,58 kr
  x Fast obalansavgift 2025-07-01 - 2025-07-31 1543 kWh 0,080 öre/kWh 1,24 kr
  Fast Påslag 2025-07-01 - 2025-07-31 1543 kWh 3,750 öre/kWh 57,86 kr
  Fast avgift 2025-07-01 - 2025-07-31 31 dag 24,00 kr/mån 24,00 kr
  Moms 25% på 701,51 kr ingår med 175,39 kr
  Summa Karlstads Energi AB 876,90 kr
`;

const KARLSTAD_CONSOLIDATED_TEXT = `
  Fakturadatum: 2026-04-13
  OCR-/Fakturanummer: 40535922112
  Karlstads Energi AB
  Medelspotpris 2026-03-01 - 2026-03-31 1980 kWh 73,328 öre/kWh 1 451,89 kr
  Rörliga kostnader 2026-03-01 - 2026-03-31 1980 kWh 6,737 öre/kWh 133,39 kr
  Fast Påslag 2026-03-01 - 2026-03-31 1980 kWh 3,750 öre/kWh 74,25 kr
  Fast avgift 2026-03-01 - 2026-03-31 31 dag 24,00 kr/mån 24,00 kr
  Moms 25% på 1 346,81 kr ingår med 336,72 kr
  Summa Karlstads Energi AB 1 683,53 kr
`;

const KARLSTAD_MICRO_TEXT = `
  Fakturadatum: 2026-07-14
  OCR-/Fakturanummer: 40556754014
  Karlstads Energi AB
  Medelspotpris 2026-06-01 - 2026-06-15 22 kWh 97,479 öre/kWh 21,45 kr
  Rörliga kostnader 2026-06-01 - 2026-06-15 22 kWh 6,683 öre/kWh 1,46 kr
  Fast Påslag 2026-06-01 - 2026-06-15 22 kWh 3,750 öre/kWh 0,83 kr
  Fast avgift 2026-06-01 - 2026-06-15 15 dag 24,00 kr/mån 12,00 kr
  Moms 25% på 28,59 kr ingår med 7,15 kr
  Summa Elhandel 35,74 kr
  Elhandel Självfaktura
  Mikroproduktion
  Energiersättning 2026-06-01 - 2026-06-15 190 kWh -68,66 öre/kWh -130,52 kr
  Rörlig produktionsavgift 2026-06-01 - 2026-06-15 190 kWh 6,466 öre/kWh 12,28 kr
  Moms 0% på -118,24 kr ingår med 0,00 kr
  Summa Karlstads Energi AB -82,50 kr
`;

const TIBBER_TEXT = `
  Faktura
  Fakturadatum: 3 juli 2026
  OCR-nummer: 293637955
  Fakturanummer: 10524495
  Avtal: Kvartspris, löpande
  Spotpris för 16 juni 2026 - 30 juni 2026 7,64 kr
  13,00 kWh à 58,77 öre/kWh.
  Fasta påslag för 16 juni 2026 - 30 juni 2026 0,78 kr
  13,00 kWh à 6,00 öre/kWh.
  Rörliga kostnader för 16 juni 2026 - 30 juni 2026 0,42 kr
  13,00 kWh à 3,28 öre/kWh.
  Elproduktion för 16 juni 2026 - 30 juni 2026 −96,00 kr
  146,58 kWh à −65,49 öre/kWh.
  Månadsavgift för 16 juni 2026 - 30 juni 2026 19,60 kr
  15 dagar à 39,20 kr/mån.
  Rabatt månadsavgift för 16 juni 2026 - 30 juni 2026 −19,60 kr
  15 dagar à −39,20 kr/mån.
  Moms 25% 2,21 kr
  Öresavrundning −0,05 kr
  Överförs till nästkommande faktura −85 kr
  Tibber AB
`;

Deno.test('energy number and Swedish date parsing normalize invoice notation', () => {
  assertEqual(parseEnergyNumber('1 451,89'), 1451.89, 'spaced Swedish amount');
  assertEqual(parseEnergyNumber('−96,00'), -96, 'Unicode minus');
  assertEqual(parseEnergyNumber('5.35'), 5.35, 'decimal point');
  assertEqual(parseEnergyDate('6 oktober 2025'), '2025-10-06', 'Swedish long date');
  assertEqual(parseEnergyDate('2026-02-29'), null, 'invalid leap date');
});

Deno.test('Ellevio peak-demand format extracts normalized grid charges', () => {
  const parsed = parseEnergyBillingDocument(ELLEVIO_PEAK_TEXT, 'grid');
  assert(parsed.importable, `Ellevio parser errors: ${parsed.errors.join(', ')}`);
  assertEqual(parsed.parserId, 'ellevio_peak_demand', 'parser id');
  assertEqual(parsed.invoiceDate, '2025-10-06', 'invoice date');
  assertEqual(parsed.periodStart, '2025-09-01', 'period start');
  assertEqual(parsed.consumptionKwh, 1323, 'consumption');
  assertEqual(parsed.peakDemandKw, 5.35, 'peak');
  assertEqual(parsed.totalAmountSek, 2158, 'total');
  assertEqual(parsed.lineItems.length, 4, 'line count');
});

Deno.test('Ellevio flat-transfer format keeps solar export separate', () => {
  const parsed = parseEnergyBillingDocument(ELLEVIO_FLAT_EXPORT_TEXT, 'grid');
  assert(parsed.importable, `Ellevio parser errors: ${parsed.errors.join(', ')}`);
  assertEqual(parsed.parserId, 'ellevio_flat_transfer', 'parser id');
  assertEqual(parsed.exportedKwh, 337, 'exported energy');
  assertEqual(
    parsed.lineItems.find((line) => line.category === 'export_credit')?.amountSek,
    -11.11,
    'export credit',
  );
  assertEqual(parsed.peakDemandKw, null, 'no peak demand');
});

Deno.test('Karlstads Energi parser fingerprints detailed and consolidated layouts', () => {
  const detailed = parseEnergyBillingDocument(KARLSTAD_DETAILED_TEXT, 'electricity');
  const consolidated = parseEnergyBillingDocument(KARLSTAD_CONSOLIDATED_TEXT, 'electricity');

  assert(detailed.importable, `Detailed parser errors: ${detailed.errors.join(', ')}`);
  assert(consolidated.importable, `Consolidated parser errors: ${consolidated.errors.join(', ')}`);
  assertEqual(detailed.parserId, 'karlstads_energi_detailed', 'detailed parser id');
  assertEqual(consolidated.parserId, 'karlstads_energi_consolidated', 'consolidated parser id');
  assertEqual(detailed.consumptionKwh, 1543, 'detailed consumption');
  assertEqual(consolidated.totalAmountSek, 1683.53, 'consolidated total');
});

Deno.test('Karlstads Energi microproduction invoice is partial and preserves export fees', () => {
  const parsed = parseEnergyBillingDocument(KARLSTAD_MICRO_TEXT, 'electricity');
  assert(parsed.importable, `Microproduction parser errors: ${parsed.errors.join(', ')}`);
  assertEqual(parsed.parserId, 'karlstads_energi_microproduction', 'parser id');
  assertEqual(parsed.exportedKwh, 190, 'exported energy');
  assertEqual(parsed.totalAmountSek, -82.5, 'net invoice total');
  assert(parsed.warnings.includes('partial_service_period'), 'partial period warning missing');
  assertEqual(
    parsed.lineItems.find((line) => line.category === 'export_fee')?.amountSek,
    12.28,
    'production fee',
  );
});

Deno.test('Tibber credit invoice extracts a split-month electricity period', () => {
  const parsed = parseEnergyBillingDocument(TIBBER_TEXT, 'electricity');
  assert(parsed.importable, `Tibber parser errors: ${parsed.errors.join(', ')}`);
  assertEqual(parsed.parserId, 'tibber_quarterly', 'parser id');
  assertEqual(parsed.periodStart, '2026-06-16', 'period start');
  assertEqual(parsed.consumptionKwh, 13, 'consumption');
  assertEqual(parsed.exportedKwh, 146.58, 'export');
  assertEqual(parsed.totalAmountSek, -85, 'carried credit');
  assertEqual(parsed.lineItems.length, 7, 'line count excluding invoice rounding');
  assert(
    parsed.lineItems.every((line) => line.label !== 'Öresavrundning'),
    'rounding must not be retained',
  );
  assert(parsed.warnings.includes('partial_service_period'), 'partial period warning missing');
});

Deno.test('recognized document in the wrong upload area is rejected with specific feedback', () => {
  const parsed = parseEnergyBillingDocument(TIBBER_TEXT, 'grid');
  assert(parsed.formatRecognized, 'format should still be recognized');
  assertEqual(parsed.importable, false, 'wrong-kind document must not import');
  assert(parsed.errors.includes('wrong_document_kind'), 'wrong-kind error missing');
});

Deno.test('unknown energy invoice layouts fail closed', () => {
  const parsed = parseEnergyBillingDocument('Generic invoice with 100 kWh and 500 kr', 'grid');
  assertEqual(parsed.formatRecognized, false, 'unknown layout recognition');
  assertEqual(parsed.importable, false, 'unknown layout importability');
  assertEqual(parsed.errors[0], 'unknown_format', 'unknown layout error');
});
