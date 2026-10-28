/** Invoice settlement evidence and the charges incurred in its service period are different amounts. */
export interface BillingCostEvidence {
  parserId: string;
  settlementSek: number;
  exportedKwh: number | null;
  lineItems: readonly { category: string; amountSek: number }[];
}
export type BillingCost =
  | { kind: 'period_total' | 'itemised_period'; periodCostSek: number; settlementSek: number }
  | { kind: 'unavailable'; periodCostSek: null; settlementSek: number; reason: string };

/** Tibber's balance includes earlier credits. Its retained charges include VAT once,
 * but exclude payment rounding, which the importer deliberately does not retain. */
export function energyBillingCost(evidence: BillingCostEvidence): BillingCost {
  const unavailable = (reason: string): BillingCost => ({ kind: 'unavailable', periodCostSek: null, settlementSek: evidence.settlementSek, reason });
  if (!Number.isFinite(evidence.settlementSek)) return unavailable('Invoice amount is invalid');
  if (evidence.parserId !== 'tibber_quarterly') return { kind: 'period_total', periodCostSek: evidence.settlementSek, settlementSek: evidence.settlementSek };
  const required = ['spot_energy', 'markup', 'variable_fee', 'fixed_fee', 'vat'];
  if ((evidence.exportedKwh ?? 0) > 0) required.push('export_credit');
  const missing = required.filter(category => !evidence.lineItems.some(line => line.category === category));
  if (missing.length) return unavailable(`Tibber period charges are incomplete: ${missing.join(', ')}`);
  if (evidence.lineItems.some(line => !Number.isFinite(line.amountSek))) return unavailable('Tibber period charge is invalid');
  const cents = evidence.lineItems.reduce((sum, line) => sum + Math.round(line.amountSek * 100), 0);
  return { kind: 'itemised_period', periodCostSek: cents / 100, settlementSek: evidence.settlementSek };
}

/** Adapt the retained invoice record at the shared read boundary. */
export function recordedBillingCost(record: {
  parser_id: string; total_amount_sek: number; exported_kwh: number | null;
  lineItems: readonly { category: string; amount_sek: number }[];
}): BillingCost {
  return energyBillingCost({ parserId: record.parser_id, settlementSek: record.total_amount_sek, exportedKwh: record.exported_kwh,
    lineItems: record.lineItems.map(line => ({ category: line.category, amountSek: line.amount_sek })) });
}
