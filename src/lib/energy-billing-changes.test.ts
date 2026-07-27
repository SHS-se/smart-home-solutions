/// <reference lib="deno.ns" />

import {
  detectEnergyBillingChanges,
  type EnergyBillingChangeDocument,
} from './energy-billing-changes.ts';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function document(
  overrides: Partial<EnergyBillingChangeDocument> & Pick<
    EnergyBillingChangeDocument,
    'id' | 'document_kind' | 'provider_key' | 'provider_name' | 'parser_id' | 'period_start' | 'period_end'
  >,
): EnergyBillingChangeDocument {
  return {
    parser_version: 1,
    lineItems: [],
    ...overrides,
  };
}

Deno.test('billing changes detect price, model and provider transitions', () => {
  const changes = detectEnergyBillingChanges([
    document({
      id: 'grid-jan',
      document_kind: 'grid',
      provider_key: 'ellevio',
      provider_name: 'Ellevio',
      parser_id: 'ellevio_peak_demand',
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      lineItems: [{
        category: 'fixed_fee',
        label: 'Fast avgift',
        unit_price_sek: 900,
        period_start: null,
      }],
    }),
    document({
      id: 'grid-feb',
      document_kind: 'grid',
      provider_key: 'ellevio',
      provider_name: 'Ellevio',
      parser_id: 'ellevio_flat_transfer',
      period_start: '2026-02-01',
      period_end: '2026-02-28',
      lineItems: [{
        category: 'fixed_fee',
        label: 'Fast avgift',
        unit_price_sek: 990,
        period_start: null,
      }],
    }),
    document({
      id: 'grid-mar',
      document_kind: 'grid',
      provider_key: 'ellevio',
      provider_name: 'Ellevio',
      parser_id: 'ellevio_peak_demand',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
      lineItems: [{
        category: 'fixed_fee',
        label: 'Fast avgift',
        unit_price_sek: 990,
        period_start: null,
      }],
    }),
    document({
      id: 'electricity-jan',
      document_kind: 'electricity',
      provider_key: 'karlstad',
      provider_name: 'Karlstads Energi',
      parser_id: 'karlstads_energi_detailed',
      period_start: '2026-01-01',
      period_end: '2026-01-31',
    }),
    document({
      id: 'electricity-feb',
      document_kind: 'electricity',
      provider_key: 'karlstad',
      provider_name: 'Karlstads Energi',
      parser_id: 'karlstads_energi_consolidated',
      period_start: '2026-02-01',
      period_end: '2026-02-28',
    }),
    document({
      id: 'electricity-mar',
      document_kind: 'electricity',
      provider_key: 'tibber',
      provider_name: 'Tibber',
      parser_id: 'tibber_quarterly',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    }),
  ]);

  assert(changes.some((change) => (
    change.type === 'price'
    && change.date === '2026-02-01'
    && change.detailSv.includes('900')
    && change.detailSv.includes('990')
  )), 'fixed-fee price change missing');
  assert(changes.some((change) => (
    change.type === 'model'
    && change.titleSv === 'Ellevio ändrade nätmodell'
  )), 'Ellevio model change missing');
  assert(
    changes.filter((change) => (
      change.type === 'model'
      && change.titleSv === 'Ellevio införde effektavgift'
    )).length === 1,
    'returning to a previous Ellevio model must be retained',
  );
  assert(changes.some((change) => (
    change.type === 'model'
    && change.titleSv === 'Karlstads Energi ändrade prismodell'
  )), 'electricity model change missing');
  assert(changes.some((change) => (
    change.type === 'provider'
    && change.detailSv === 'Karlstads Energi → Tibber'
  )), 'provider change missing');
});

Deno.test('monthly spot prices do not create condition-change noise', () => {
  const changes = detectEnergyBillingChanges([
    document({
      id: 'jan',
      document_kind: 'electricity',
      provider_key: 'supplier',
      provider_name: 'Supplier',
      parser_id: 'supplier',
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      lineItems: [{
        category: 'spot_energy',
        label: 'Spotpris',
        unit_price_sek: 0.5,
        period_start: null,
      }],
    }),
    document({
      id: 'feb',
      document_kind: 'electricity',
      provider_key: 'supplier',
      provider_name: 'Supplier',
      parser_id: 'supplier',
      period_start: '2026-02-01',
      period_end: '2026-02-28',
      lineItems: [{
        category: 'spot_energy',
        label: 'Spotpris',
        unit_price_sek: 1.25,
        period_start: null,
      }],
    }),
  ]);

  assert(!changes.some((change) => change.type === 'price'), 'spot-price noise detected');
});
