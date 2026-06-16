/**
 * Pure helpers for BOM fulfillment tracking (premises/group level).
 *
 * A BOM is the full equipment list for a premises. Quotes and invoices draw down against it:
 * each BOM item (identified by sku within the bom group) has a target quantity, an invoiced
 * quantity (finalized invoices only) and a quoted quantity (active quotes). These helpers turn
 * those raw numbers into the status/remaining/over-invoice signals the UI and guards rely on.
 *
 * Kept free of React/runtime deps so it can be unit-tested under Deno.
 */

export type FulfillmentStatus = 'not_invoiced' | 'partial' | 'full' | 'over';

export interface SkuFulfillment {
  bom_quantity: number;
  quoted_quantity: number;
  invoiced_quantity: number;
  remaining_quantity: number;
}

/** Classify a BOM item by how much of its target has been invoiced. */
export function getFulfillmentStatus(invoiced: number, target: number): FulfillmentStatus {
  if (invoiced <= 0) return 'not_invoiced';
  if (invoiced < target) return 'partial';
  if (invoiced === target) return 'full';
  return 'over';
}

/** Units of a BOM item that may still be invoiced (never negative). */
export function remainingToInvoice(target: number, invoiced: number): number {
  return Math.max(target - invoiced, 0);
}

/**
 * Given the hardware quantities requested on a draft invoice (summed per sku) and the premises
 * fulfillment, return the skus that would bill more than what is left to invoice. An empty map
 * means the draft is safe to finalize; the server enforces the same rule authoritatively.
 */
export function findOverInvoicedSkus(
  requestedBySku: Map<string, number>,
  fulfillmentBySku: Map<string, SkuFulfillment>
): Map<string, { requested: number; remaining: number }> {
  const result = new Map<string, { requested: number; remaining: number }>();
  for (const [skuId, requested] of requestedBySku) {
    const f = fulfillmentBySku.get(skuId);
    if (f && requested > f.remaining_quantity) {
      result.set(skuId, { requested, remaining: f.remaining_quantity });
    }
  }
  return result;
}
