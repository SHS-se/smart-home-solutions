/// <reference lib="deno.ns" />

import { buildSkatteverketXml, finalizeVatDeclarationAmounts } from './vat-declaration.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('finalizeVatDeclarationAmounts derives MomsBetala from rounded declaration boxes', () => {
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

  assertEqual(amounts.box22, 1731, 'box22');
  assertEqual(amounts.box30, 433, 'box30');
  assertEqual(amounts.box48, 2116, 'box48');
  assertEqual(amounts.momsBetala, -1683, 'momsBetala');
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
