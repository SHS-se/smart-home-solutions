/// <reference lib="deno.ns" />

import {
  buildSkatteverketXml,
  calculateDeclarationBoxAmount,
  finalizeVatDeclarationAmounts,
  isDeclarationBoxFilter,
  lineMatchesDeclarationBox,
  purchaseMatchesDeclarationBox,
  reverseChargeVatRate,
  roundVatDeclarationAmount,
  summarizeDeclarationBoxLines,
  validateSkatteverketXml,
} from './vat-declaration.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('finalizeVatDeclarationAmounts truncates öre per Skatteverket and derives MomsBetala', () => {
  const amounts = finalizeVatDeclarationAmounts({
    box05: 0,
    box10: 0,
    box11: 0,
    box12: 0,
    box20: 0,
    box21: 0,
    box22: 1730.64,
    box30: 432.75,
    box31: 0,
    box32: 0,
    box48: 2116.49,
  });

  // Whole kronor with the öre dropped (truncated), never rounded up.
  assertEqual(amounts.box22, 1730, 'box22');
  assertEqual(amounts.box30, 432, 'box30');
  assertEqual(amounts.box48, 2116, 'box48');
  assertEqual(amounts.momsBetala, -1684, 'momsBetala');
});

Deno.test('roundVatDeclarationAmount drops öre toward zero for both signs', () => {
  assertEqual(roundVatDeclarationAmount(432.99), 432, 'positive');
  assertEqual(roundVatDeclarationAmount(-432.99), -432, 'negative');
  assertEqual(roundVatDeclarationAmount(0.6), 0, 'sub-krona');
});

Deno.test('reverseChargeVatRate reads the line rate and falls back to 25%', () => {
  assertEqual(reverseChargeVatRate({ vat_treatment: 'reverse_charge_eu_goods', vat_rate: 12 }), 12, 'rate12');
  assertEqual(reverseChargeVatRate({ vat_treatment: 'reverse_charge_eu_goods', vat_rate: 6 }), 6, 'rate6');
  assertEqual(reverseChargeVatRate({ vat_treatment: 'reverse_charge_eu_goods', vat_rate: 25 }), 25, 'rate25');
  assertEqual(reverseChargeVatRate({ vat_treatment: 'reverse_charge_eu_goods', vat_rate: 0 }), 25, 'rate0Fallback');
  assertEqual(reverseChargeVatRate({ vat_treatment: 'reverse_charge_eu_goods' }), 25, 'missingFallback');
});

Deno.test('reverse-charge output VAT splits into boxes 30/31/32 by line rate', () => {
  const lines = [
    { vat_treatment: 'reverse_charge_eu_goods', net_amount: 1000, vat_amount: 0, vat_rate: 25 },
    { vat_treatment: 'reverse_charge_eu_goods', net_amount: 500, vat_amount: 0, vat_rate: 12 },
    { vat_treatment: 'reverse_charge_eu_services', net_amount: 200, vat_amount: 0, vat_rate: 6 },
  ];

  assertEqual(calculateDeclarationBoxAmount(lines, '30'), 250, 'box30');
  assertEqual(calculateDeclarationBoxAmount(lines, '31'), 60, 'box31');
  assertEqual(calculateDeclarationBoxAmount(lines, '32'), 12, 'box32');
  // Box 48 deducts the same deemed VAT across all rates.
  assertEqual(calculateDeclarationBoxAmount(lines, '48'), 322, 'box48');
  assertEqual(lineMatchesDeclarationBox(lines[1], '31'), true, 'lineBox31');
  assertEqual(lineMatchesDeclarationBox(lines[1], '30'), false, 'lineBox30For12');
  assertEqual(isDeclarationBoxFilter('31'), true, 'filter31');
  assertEqual(isDeclarationBoxFilter('32'), true, 'filter32');
});

Deno.test('buildSkatteverketXml emits internally consistent integer VAT boxes', () => {
  const xml = buildSkatteverketXml('790519-7591', '202603', [
    { xmlTag: 'InkopTjanstUtomEg', amount: 1731 },
    { xmlTag: 'MomsInkopUtgHog', amount: 433 },
    { xmlTag: 'MomsIngAvdr', amount: 2116 },
    { xmlTag: 'MomsBetala', amount: -1683 },
  ]);

  if (!xml.includes('<MomsBetala>-1683</MomsBetala>')) {
    throw new Error('Expected XML to contain the reconciled MomsBetala value');
  }
});

Deno.test('validateSkatteverketXml accepts a generated XML file that matches expectations', () => {
  const xml = buildSkatteverketXml('790519-7591', '202603', [
    { xmlTag: 'InkopTjanstUtomEg', amount: 1731 },
    { xmlTag: 'MomsInkopUtgHog', amount: 433 },
    { xmlTag: 'MomsIngAvdr', amount: 2116 },
    { xmlTag: 'MomsBetala', amount: -1683 },
  ]);

  const result = validateSkatteverketXml({
    xml,
    expectedOrgNr: '790519-7591',
    expectedPeriodYYYYMM: '202603',
    declarationBoxes: [
      { xmlTag: 'InkopTjanstUtomEg', amount: 1731 },
      { xmlTag: 'MomsInkopUtgHog', amount: 433 },
      { xmlTag: 'MomsIngAvdr', amount: 2116 },
      { xmlTag: 'MomsBetala', amount: -1683 },
    ],
  });

  assertEqual(result.ok, true, 'ok');
  assertEqual(result.errors.length, 0, 'errorCount');
});

Deno.test('validateSkatteverketXml rejects non-reconciling MomsBetala values', () => {
  const xml = buildSkatteverketXml('790519-7591', '202603', [
    { xmlTag: 'InkopTjanstUtomEg', amount: 1731 },
    { xmlTag: 'MomsInkopUtgHog', amount: 433 },
    { xmlTag: 'MomsIngAvdr', amount: 2116 },
    { xmlTag: 'MomsBetala', amount: -1684 },
  ]);

  const result = validateSkatteverketXml({
    xml,
    expectedOrgNr: '790519-7591',
    expectedPeriodYYYYMM: '202603',
    declarationBoxes: [
      { xmlTag: 'InkopTjanstUtomEg', amount: 1731 },
      { xmlTag: 'MomsInkopUtgHog', amount: 433 },
      { xmlTag: 'MomsIngAvdr', amount: 2116 },
      { xmlTag: 'MomsBetala', amount: -1683 },
    ],
  });

  assertEqual(result.ok, false, 'ok');
  assertEqual(
    result.errors.some((error) => error.includes('MomsBetala does not reconcile')),
    true,
    'reconciliationError',
  );
});

Deno.test('isDeclarationBoxFilter accepts only supported purchase declaration box filters', () => {
  assertEqual(isDeclarationBoxFilter('22'), true, 'box22');
  assertEqual(isDeclarationBoxFilter('48'), true, 'box48');
  assertEqual(isDeclarationBoxFilter('49'), false, 'box49');
});

Deno.test('purchaseMatchesDeclarationBox maps purchases to declaration box filters', () => {
  const purchase = {
    lines: [
      { vat_treatment: 'reverse_charge_non_eu_services' },
      { vat_treatment: 'domestic_deductible' },
    ],
  };

  assertEqual(purchaseMatchesDeclarationBox(purchase, '22'), true, 'box22');
  assertEqual(purchaseMatchesDeclarationBox(purchase, '30'), true, 'box30');
  assertEqual(purchaseMatchesDeclarationBox(purchase, '48'), true, 'box48');
  assertEqual(purchaseMatchesDeclarationBox(purchase, '20'), false, 'box20');
});

Deno.test('lineMatchesDeclarationBox and box calculations mirror declaration logic', () => {
  const lines = [
    { vat_treatment: 'reverse_charge_non_eu_services', gross_amount: 125, net_amount: 100, vat_amount: 0 },
    { vat_treatment: 'domestic_deductible', gross_amount: 250, net_amount: 200, vat_amount: 50 },
  ];

  assertEqual(lineMatchesDeclarationBox(lines[0], '22'), true, 'lineBox22');
  assertEqual(lineMatchesDeclarationBox(lines[1], '22'), false, 'lineBox22Domestic');

  const box22Summary = summarizeDeclarationBoxLines(lines, '22');
  assertEqual(box22Summary.gross, 125, 'box22Gross');
  assertEqual(box22Summary.net, 100, 'box22Net');
  assertEqual(box22Summary.vat, 0, 'box22Vat');
  assertEqual(calculateDeclarationBoxAmount(lines, '22'), 100, 'box22Amount');

  const box48Summary = summarizeDeclarationBoxLines(lines, '48');
  assertEqual(box48Summary.gross, 375, 'box48Gross');
  assertEqual(box48Summary.net, 300, 'box48Net');
  assertEqual(box48Summary.vat, 50, 'box48Vat');
  assertEqual(calculateDeclarationBoxAmount(lines, '48'), 75, 'box48Amount');
});
