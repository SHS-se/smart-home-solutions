import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { meritOrderCurve, quarterOffers, type SupplyOffer } from "./merit-order.ts";
import { marginalValue, validateCurve } from "./store-value.ts";

/** Four quarters each able to supply one unit, at 1, 2, 3 and 4 SEK per unit. */
const offers: SupplyOffer[] = [3, 1, 4, 2].map(price => ({ kwh: 2, sek_per_kwh: price * 0.5, units_per_kwh: 0.5 }));
const base = { unit: "celsius", target: 30, state: 30, upkeep: 2, step: 1, offers, scale: 1 };

Deno.test("at the target a unit is worth the last unit needed to hold it", () => {
  // Holding 30 °C costs 2 units of upkeep: the cheapest two offers, so the clearing price is 2.
  const { curve, evidence } = meritOrderCurve(base);
  assertEquals(validateCurve(curve), null);
  assertEquals([evidence.need, evidence.clearing_sek_per_unit, evidence.supply], [2, 2, 4]);
  assertAlmostEquals(marginalValue(curve, 30), 2);
  // One below target, the third offer is needed; two below, the fourth, which is also all there is.
  assertAlmostEquals(marginalValue(curve, 29), 3);
  assertAlmostEquals(marginalValue(curve, 28), 4);
  assertAlmostEquals(marginalValue(curve, 22), 4);
  // Above target only the cheaper offers are displaced, and past what it needs more is worth nothing.
  assertAlmostEquals(marginalValue(curve, 31), 1);
  assertEquals(marginalValue(curve, 32), 0);
});

Deno.test("a store that starts short is priced on what it takes to end on target", () => {
  // One degree short plus two of upkeep: three units, clearing at 3. Bidding with this curve buys exactly those three.
  const { curve, evidence } = meritOrderCurve({ ...base, state: 29 });
  assertEquals([evidence.need, evidence.clearing_sek_per_unit], [3, 3]);
  assertAlmostEquals(marginalValue(curve, 30), 3);
  assertEquals(validateCurve(curve), null);
});

Deno.test("a store holding more than it needs bids nothing", () => {
  const { curve, evidence } = meritOrderCurve({ ...base, state: 33 });
  assertEquals(evidence.need, 0);
  assertEquals(marginalValue(curve, 33), 0);
  assertEquals(marginalValue(curve, 30), 0);
  // It still knows what a unit would be worth if it fell below target.
  assert(marginalValue(curve, 29) > 0);
  assertEquals(validateCurve(curve), null);
});

Deno.test("the scale multiplies every value and moves no level", () => {
  const nominal = meritOrderCurve(base).curve, high = meritOrderCurve({ ...base, scale: 1.5 }).curve;
  assertEquals(high.points.map(p => p.at), nominal.points.map(p => p.at));
  high.points.forEach((point, i) => assertAlmostEquals(point.sek_per_unit, nominal.points[i].sek_per_unit * 1.5, 1e-6));
});

Deno.test("quantity matters: one cheap quarter does not make every unit cheap", () => {
  const scarce: SupplyOffer[] = [{ kwh: 1, sek_per_kwh: 0.1, units_per_kwh: 1 }, { kwh: 10, sek_per_kwh: 2, units_per_kwh: 1 }];
  assertEquals(meritOrderCurve({ ...base, offers: scarce, upkeep: 3 }).evidence.clearing_sek_per_unit, 2);
  assertEquals(meritOrderCurve({ ...base, offers: scarce, upkeep: 1 }).evidence.clearing_sek_per_unit, 0.1);
});

Deno.test("a quarter offers its surplus at the export price and the rest at the import price", () => {
  const [surplus, grid] = quarterOffers({ hours: 0.25, surplus_w: 1000, import_sek_per_kwh: 2, export_sek_per_kwh: 0.5, max_w: 3000, units_per_kwh: 0.05 });
  assertEquals([surplus.kwh, surplus.sek_per_kwh], [0.25, 0.5]);
  assertEquals([grid.kwh, grid.sek_per_kwh], [0.5, 2]);
  // A colder quarter buys less heat per kWh, so the same electricity price is a dearer degree.
  const warm = meritOrderCurve({ ...base, offers: [{ kwh: 100, sek_per_kwh: 1, units_per_kwh: 0.08 }] }).evidence.clearing_sek_per_unit;
  const cold = meritOrderCurve({ ...base, offers: [{ kwh: 100, sek_per_kwh: 1, units_per_kwh: 0.05 }] }).evidence.clearing_sek_per_unit;
  assert(cold > warm);
});
