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

// A 95%-in / 92%-out pack. The curve converts a *stored* kWh into the energy it
// will deliver, so only the discharge side enters it; the charge side is applied
// by the dispatch on the flow (`units_per_kwh`).
const DISCHARGE_EFFICIENCY = 0.92;
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
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    reserveKwh: 0,
    worstImportSekPerKwh: 0,
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
  // A 15% spread. What a stored kWh is worth is the import it displaces after
  // the discharge loss, and 1.0 × 0.92 leaves less than the 0.5 SEK of wear a
  // cycle costs, so the whole band is worth nothing and the cheapest hour in it
  // still does not justify buying.
  const tight = batteryValueCurve({
    futureImportSekPerKwh: [0.85, 0.92, 1.0],
    futureImportKwh: [2, 2, 2],
    futureSurplusKwh: 0,
    usableKwh: 10,
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    reserveKwh: 0,
    worstImportSekPerKwh: 0,
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
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    reserveKwh: 0,
    worstImportSekPerKwh: 0,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });
  const dear = 2.4 * DISCHARGE_EFFICIENCY - DEGRADATION;

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
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    reserveKwh: 0,
    worstImportSekPerKwh: 0,
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
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    reserveKwh: 0,
    worstImportSekPerKwh: 0,
    degradationSekPerKwh: DEGRADATION,
    expectedDrawKwh: 6,
  });
  const dear = 2.4 * DISCHARGE_EFFICIENCY - DEGRADATION;
  const cheap = Math.max(0, 0.5 * DISCHARGE_EFFICIENCY - DEGRADATION);

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
        dischargeEfficiency: DISCHARGE_EFFICIENCY,
        reserveKwh: 0,
        worstImportSekPerKwh: 0,
        degradationSekPerKwh: DEGRADATION,
        expectedDrawKwh: 6,
      }),
    Error,
    "one residual-load value per import price",
  );
});

Deno.test("§8.4 — a stored kWh is never worth more than the import it displaces", () => {
  // The invariant the round-trip division broke. A kWh in the battery buys back
  // `dischargeEfficiency` kWh at the house, so its value is strictly below the
  // price it displaces, before wear is even subtracted. Dividing by the round
  // trip put it *above* that price, and since the dispatch then applies the
  // discharge loss again on the flow, discharging required the present hour to
  // beat the hour the curve was priced against by about 17% — which, the curve
  // having taken the dearest hours first, no hour can.
  for (const dearest of [0.8, 1.6, 2.4, 3.2]) {
    const curve = batteryValueCurve({
      futureImportSekPerKwh: [dearest, dearest / 2],
      futureImportKwh: [3, 3],
      futureSurplusKwh: 0,
      usableKwh: 10,
      dischargeEfficiency: DISCHARGE_EFFICIENCY,
    reserveKwh: 0,
    worstImportSekPerKwh: 0,
      degradationSekPerKwh: 0,
      expectedDrawKwh: 6,
    });
    assertEquals(validateCurve(curve), null);
    assert(
      marginalValue(curve, 0.1) < dearest,
      `a stored kWh priced at ${
        marginalValue(curve, 0.1)
      } cannot beat the ${dearest} it displaces`,
    );
    // And it is worth exactly the delivered energy, which is what makes
    // discharging into that same hour break even rather than impossible.
    assertAlmostEquals(
      marginalValue(curve, 0.1),
      dearest * DISCHARGE_EFFICIENCY,
      1e-6,
    );
  }
});

Deno.test("§8.4 — a reserve is priced at the worst hour, not at the expected one", () => {
  // What a reserve insures against is the plan being wrong, so what it is worth
  // is not what the forecast path costs — the merit order already prices that —
  // but what the dearest hour on the board costs. That figure the plan already
  // has, which is why the reserve needs no number from the customer.
  const covering = [1.0, 0.6];
  const worst = 4.0;
  const withReserve = batteryValueCurve({
    futureImportSekPerKwh: covering,
    futureImportKwh: [3, 3],
    futureSurplusKwh: 0,
    usableKwh: 10,
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    degradationSekPerKwh: 0,
    expectedDrawKwh: 6,
    reserveKwh: 2,
    worstImportSekPerKwh: worst,
  });

  assertEquals(validateCurve(withReserve), null);
  // The bottom of the pack is worth the worst hour...
  assertAlmostEquals(
    marginalValue(withReserve, 1),
    worst * DISCHARGE_EFFICIENCY,
    1e-6,
  );
  // ...and immediately above the reserve the merit order takes over unchanged:
  // the dearest covering hour, then the next, exactly as with no reserve at all.
  assertAlmostEquals(
    marginalValue(withReserve, 2.5),
    covering[0] * DISCHARGE_EFFICIENCY,
    1e-6,
  );
  assertAlmostEquals(
    marginalValue(withReserve, 4.5),
    covering[1] * DISCHARGE_EFFICIENCY,
    1e-6,
  );

  // Which is what makes it a preference and not the hard target §8.4 deleted:
  // an ordinary dear hour cannot reach it, and an hour at the horizon's worst
  // can — that being the event it was kept for.
  const store: StoreState = {
    key: "battery",
    curve: withReserve,
    at: 1,
    unitsPerKwh: 1,
  };
  assertEquals(
    worthExporting(store, 2.0),
    false,
    "an ordinary spike does not spend the reserve",
  );
  assert(
    worthExporting(store, worst),
    "the hour it was kept for does spend it",
  );
});

Deno.test("§8.4 — no reserve leaves the merit order exactly as it was", () => {
  const input = {
    futureImportSekPerKwh: [1.0, 0.6],
    futureImportKwh: [3, 3],
    futureSurplusKwh: 0,
    usableKwh: 10,
    dischargeEfficiency: DISCHARGE_EFFICIENCY,
    degradationSekPerKwh: 0,
    expectedDrawKwh: 6,
    worstImportSekPerKwh: 4.0,
  };
  assertEquals(
    batteryValueCurve({ ...input, reserveKwh: 0 }),
    batteryValueCurve({ ...input, reserveKwh: 0, worstImportSekPerKwh: 99 }),
    "a home that asked for nothing is unaffected by what the worst hour is",
  );
});
