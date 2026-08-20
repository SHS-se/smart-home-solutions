import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  batteryValueCurve,
  marginalValue,
  rankStores,
  type StoreState,
  totalUtility,
  type UtilityCurve,
  validateCurve,
  valueOfMove,
  worthBuying,
  worthExporting,
} from "./store-value.ts";

const ROUND_TRIP = 0.85;
const DEGRADATION = 0.5;

const battery = (
  futureSurplusKwh: number,
  prices: number[],
): UtilityCurve =>
  batteryValueCurve({
    futureImportSekPerKwh: prices,
    futureImportKwh: prices.map(() => 2),
    futureSurplusKwh,
    usableKwh: 10,
    roundTrip: ROUND_TRIP,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });

Deno.test("a rising marginal value is rejected as non-concave", () => {
  const rejection = validateCurve({
    unit: "kwh",
    points: [{ at: 5, sek_per_unit: 0.2 }, { at: 10, sek_per_unit: 0.9 }],
  });

  assertEquals(rejection?.reason, "not_concave");
});

Deno.test("utility integrates the marginal value, and a move is its difference", () => {
  const curve: UtilityCurve = {
    unit: "kwh",
    points: [{ at: 4, sek_per_unit: 2 }, { at: 10, sek_per_unit: 0.5 }],
  };

  // Flat below the first breakpoint, then a straight decline to the next.
  assertEquals(marginalValue(curve, 0), 2);
  assertEquals(marginalValue(curve, 4), 2);
  assertEquals(marginalValue(curve, 7), 1.25, "halfway down the 4→10 segment");
  assertEquals(marginalValue(curve, 10), 0.5);
  assertEquals(marginalValue(curve, 12), 0, "past the top it is worth nothing");
  // Rectangle below the first point, trapezoid above it.
  assertEquals(totalUtility(curve, 4), 8);
  assertEquals(totalUtility(curve, 10), 8 + 6 * (2 + 0.5) / 2);
  // A large move must use the integral, not marginal × step, or the curvature
  // that motivated having a curve is thrown away.
  assertEquals(valueOfMove(curve, 0, 10), 8 + 7.5);
  assertEquals(valueOfMove(curve, 10, 4), -7.5);
});

Deno.test("§8.12 #1 — a sunny tomorrow makes exporting correct", () => {
  // Tomorrow's forecast surplus more than refills the battery, so holding
  // charge displaces nothing: the energy would have been free anyway.
  const curve = battery(20, [0.4, 1.1, 2.0]);
  const store: StoreState = {
    key: "battery",
    curve,
    at: 8,
    unitsPerKwh: 1,
  };

  assertEquals(marginalValue(curve, 8), 0);
  assert(worthExporting(store, 0.9), "sell into a high price before a sunny day");
});

Deno.test("§8.12 #1 — a dark week makes the same price worth refusing", () => {
  // Same battery, same 0.9 SEK export price, no surplus ahead. Nothing about
  // the settings changed; only the forecast did.
  const curve = battery(0, [0.4, 1.1, 2.0]);
  const store: StoreState = { key: "battery", curve, at: 1, unitsPerKwh: 1 };

  assert(marginalValue(curve, store.at) > 0.9);
  assertEquals(
    worthExporting(store, 0.9),
    false,
    "a fixed export floor cannot tell these two days apart",
  );
  assert(worthExporting(store, 2.5), "a big enough spike is still worth it");
});

Deno.test("§8.12 #1 — the last kWh is worth less than the first", () => {
  const curve = battery(0, [0.4, 1.1, 2.0]);

  assertEquals(validateCurve(curve), null);
  assert(
    marginalValue(curve, 1) > marginalValue(curve, 8),
    "covering tonight's draw outranks topping up beyond it",
  );
  // "10-12 kWh carries a summer night" must never be entered as a number: it
  // is where the curve falls away, computed from the forecast draw.
  assert(marginalValue(curve, 11) === 0);
});

Deno.test("§8.12 #7 — grid charging needs the spread to beat losses and wear", () => {
  // An 18% spread: exactly the round-trip break-even on energy alone, so wear
  // has to make it a refusal.
  const tight = batteryValueCurve({
    futureImportSekPerKwh: [0.85, 0.92, 1.0],
    futureImportKwh: [2, 2, 2],
    futureSurplusKwh: 0,
    usableKwh: 10,
    roundTrip: ROUND_TRIP,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });
  const tightStore: StoreState = {
    key: "battery",
    curve: tight,
    at: 1,
    unitsPerKwh: 1,
  };
  assertEquals(
    worthBuying(tightStore, 0.85),
    false,
    "a narrow spread must not buy a cycle",
  );

  const wide = battery(0, [0.4, 1.1, 2.0]);
  const wideStore: StoreState = {
    key: "battery",
    curve: wide,
    at: 1,
    unitsPerKwh: 1,
  };
  assert(worthBuying(wideStore, 0.4), "a cold winter day's spread does");
});

Deno.test("§8.12 #4 — the car outranks the pool, then stops outranking it", () => {
  // Ranking is in SEK per kWh of *electricity*, which is where the vehicle's
  // kWh/km and the pool heat pump's COP enter and make the two comparable.
  const evCurve: UtilityCurve = {
    unit: "km",
    points: [{ at: 100, sek_per_unit: 0.5 }, { at: 300, sek_per_unit: 0.05 }],
  };
  const poolCurve: UtilityCurve = {
    unit: "celsius",
    points: [{ at: 26, sek_per_unit: 3.0 }, { at: 30, sek_per_unit: 0.2 }],
  };
  // 0.16 kWh/km at 90% charging efficiency; 40 m³ of water at COP 5.
  const evUnitsPerKwh = 0.9 / 0.16;
  const poolUnitsPerKwh = 5 / (40 * 1.163);

  const nearlyEmpty = rankStores([
    { key: "ev", curve: evCurve, at: 50, unitsPerKwh: evUnitsPerKwh },
    { key: "pool", curve: poolCurve, at: 24, unitsPerKwh: poolUnitsPerKwh },
  ]);
  assertEquals(nearlyEmpty[0].key, "ev");

  const nearlyFull = rankStores([
    // Interpolation makes the ordering depend on where in a band a store sits,
    // which is the point of it: at 299 km the car is almost at the top of its
    // curve rather than anywhere inside a flat step.
    { key: "ev", curve: evCurve, at: 299, unitsPerKwh: evUnitsPerKwh },
    { key: "pool", curve: poolCurve, at: 24, unitsPerKwh: poolUnitsPerKwh },
  ]);
  assertEquals(
    nearlyFull[0].key,
    "pool",
    "a static priority stack cannot express this reversal",
  );
});

Deno.test("§8.12 #4 — a warmer afternoon raises the pool's standing", () => {
  const poolCurve: UtilityCurve = {
    unit: "celsius",
    points: [{ at: 26, sek_per_unit: 3.0 }, { at: 30, sek_per_unit: 0.2 }],
  };
  const cold = { key: "pool", curve: poolCurve, at: 24, unitsPerKwh: 2.5 / 46.52 };
  const warm = { key: "pool", curve: poolCurve, at: 24, unitsPerKwh: 5.0 / 46.52 };

  assert(
    rankStores([warm])[0].sekPerKwh > rankStores([cold])[0].sekPerKwh,
    "COP is what makes air temperature outrank price in spring",
  );
});

Deno.test("a full store never outbids anything", () => {
  const curve: UtilityCurve = {
    unit: "celsius",
    points: [{ at: 28, sek_per_unit: 1.0 }],
  };
  const store: StoreState = { key: "pool", curve, at: 29, unitsPerKwh: 0.1 };

  assertEquals(worthBuying(store, 0.01), false);
  assertAlmostEquals(rankStores([store])[0].sekPerKwh, 0, 1e-12);
});

Deno.test("a sunny forecast must not zero the charge that covers tonight", () => {
  // The defect this guards: subtracting forecast surplus from the whole pack
  // collapsed the curve to zero, so the battery refused to charge at all before
  // a sunny day. Tomorrow's sun cannot power tonight.
  const curve = battery(40, [0.4, 1.1, 2.0]);

  assert(
    marginalValue(curve, 1) > 1,
    "the charge covering tonight's draw keeps its value",
  );
  assertEquals(
    marginalValue(curve, 9),
    0,
    "while the room the sun will refill is still worth nothing to hold",
  );
});

Deno.test("§8.4 — covering follows the merit order of displaced imports", () => {
  // The two-level step priced the whole 6 kWh covering band at 2.4 SEK, so a
  // 0.6 SEK night looked like a bargain for every kWh of tonight's draw. Only
  // the first 2 kWh actually displace the spike.
  const curve = batteryValueCurve({
    futureImportSekPerKwh: [0.5, 1.0, 2.4],
    futureImportKwh: [2, 2, 2],
    futureSurplusKwh: 0,
    usableKwh: 10,
    roundTrip: ROUND_TRIP,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });
  const dear = 2.4 / ROUND_TRIP - DEGRADATION;

  assertEquals(validateCurve(curve), null);
  assertAlmostEquals(marginalValue(curve, 0.5), dear, 0.05);
  assert(
    marginalValue(curve, 0.5) - marginalValue(curve, 5.5) > 1,
    "the last covering kWh is not worth the dearest hour",
  );
  assert(
    marginalValue(curve, 5.5) < 0.5,
    "cheap-hour covering energy is not worth a mid-price cycle",
  );
});

Deno.test("§8.4 — a modest overnight spread only buys the expensive tail", () => {
  const curve = batteryValueCurve({
    futureImportSekPerKwh: [0.5, 1.0, 2.4],
    futureImportKwh: [2, 2, 2],
    futureSurplusKwh: 20,
    usableKwh: 10,
    roundTrip: ROUND_TRIP,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });
  const storeAt = (at: number): StoreState => ({
    key: "battery",
    curve,
    at,
    unitsPerKwh: 1,
  });
  const nightPrice = 0.6;

  assert(
    worthBuying(storeAt(0.5), nightPrice),
    "the kWh that displaces the 2.4 SEK hour is worth buying at 0.6",
  );
  assertEquals(
    worthBuying(storeAt(5.5), nightPrice),
    false,
    "the kWh that displaces a 0.5 SEK hour is not worth a cycle at 0.6",
  );
  assertEquals(
    worthBuying(storeAt(8), nightPrice),
    false,
    "and the room the sun will refill is still worth nothing to buy",
  );
});

Deno.test("§8.4 — covering takes the dearest kWh first when weights are given", () => {
  // A 1 kWh spike and a 5 kWh cheap night. Equal-share would have split the
  // covering band in half; merit order keeps the spike as a one-kWh nose.
  const curve = batteryValueCurve({
    futureImportSekPerKwh: [2.4, 0.5],
    futureImportKwh: [1, 5],
    futureSurplusKwh: 0,
    usableKwh: 10,
    roundTrip: ROUND_TRIP,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });
  const dear = 2.4 / ROUND_TRIP - DEGRADATION;
  const cheap = Math.max(0, 0.5 / ROUND_TRIP - DEGRADATION);

  assertEquals(validateCurve(curve), null);
  assertAlmostEquals(marginalValue(curve, 0.5), dear, 0.05);
  assertAlmostEquals(marginalValue(curve, 4), cheap, 0.05);
});

Deno.test("§8.4 — every covering price requires an explicit kWh weight", () => {
  assertThrows(
    () =>
      batteryValueCurve({
        futureImportSekPerKwh: [2.4, 0.5],
        futureImportKwh: [6],
        futureSurplusKwh: 0,
        usableKwh: 10,
        roundTrip: ROUND_TRIP,
        degradationSekPerKwh: DEGRADATION,
        expectedDrawKwh: 6,
      }),
    Error,
    "one residual-load value per import price",
  );
});
