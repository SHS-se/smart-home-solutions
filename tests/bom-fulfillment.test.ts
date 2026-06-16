import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  findOverInvoicedSkus,
  getFulfillmentStatus,
  remainingToInvoice,
  type SkuFulfillment,
} from "@/lib/bom-fulfillment.ts";

Deno.test("getFulfillmentStatus classifies invoiced vs target", () => {
  assertEquals(getFulfillmentStatus(0, 3), "not_invoiced");
  assertEquals(getFulfillmentStatus(2, 3), "partial");
  assertEquals(getFulfillmentStatus(3, 3), "full");
  assertEquals(getFulfillmentStatus(4, 3), "over");
  // A zero-target item that somehow got invoiced is over-invoiced.
  assertEquals(getFulfillmentStatus(1, 0), "over");
});

Deno.test("remainingToInvoice never goes negative", () => {
  assertEquals(remainingToInvoice(3, 0), 3);
  assertEquals(remainingToInvoice(3, 2), 1);
  assertEquals(remainingToInvoice(3, 3), 0);
  assertEquals(remainingToInvoice(3, 5), 0);
});

const fulfillment = (overrides: Partial<SkuFulfillment>): SkuFulfillment => ({
  bom_quantity: 0,
  quoted_quantity: 0,
  invoiced_quantity: 0,
  remaining_quantity: 0,
  ...overrides,
});

Deno.test("findOverInvoicedSkus flags only skus exceeding their remaining", () => {
  // SKU A: target 3, 2 already finalized => 1 remaining. Requesting 1 is fine, 2 is not.
  // SKU B: target 5, nothing finalized => 5 remaining. Requesting 5 is fine.
  const fulfilmentBySku = new Map<string, SkuFulfillment>([
    ["A", fulfillment({ bom_quantity: 3, invoiced_quantity: 2, remaining_quantity: 1 })],
    ["B", fulfillment({ bom_quantity: 5, invoiced_quantity: 0, remaining_quantity: 5 })],
  ]);

  const safe = findOverInvoicedSkus(new Map([["A", 1], ["B", 5]]), fulfilmentBySku);
  assertEquals(safe.size, 0);

  const over = findOverInvoicedSkus(new Map([["A", 2], ["B", 5]]), fulfilmentBySku);
  assertEquals(over.size, 1);
  assertEquals(over.get("A"), { requested: 2, remaining: 1 });
});

Deno.test("findOverInvoicedSkus ignores skus not tracked by the BOM", () => {
  // An ad-hoc SKU with no BOM fulfillment row is not guarded (extra equipment is allowed).
  const over = findOverInvoicedSkus(new Map([["ADHOC", 10]]), new Map());
  assertEquals(over.size, 0);
});

Deno.test("fully invoiced sku leaves zero remaining and blocks further billing", () => {
  const fulfilmentBySku = new Map<string, SkuFulfillment>([
    ["A", fulfillment({ bom_quantity: 2, invoiced_quantity: 2, remaining_quantity: 0 })],
  ]);
  assertEquals(getFulfillmentStatus(2, 2), "full");
  const over = findOverInvoicedSkus(new Map([["A", 1]]), fulfilmentBySku);
  assertEquals(over.get("A"), { requested: 1, remaining: 0 });
});
