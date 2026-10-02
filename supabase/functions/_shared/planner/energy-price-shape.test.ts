import {
  buildPriceOutlook,
  estimatePriceShape,
  localSlot,
  QUARTERS_PER_DAY,
  RECENCY_HALF_LIFE_DAYS,
  type StoredPriceRow,
} from "./energy-price-shape.ts";

const TZ = "Europe/Stockholm";
/** Noon on 2026-06-30, after every fixture day below. */
const AS_OF = Date.parse("2026-06-30T12:00:00+02:00");

const shapeOf = (rows: StoredPriceRow[], asOf = AS_OF) =>
  estimatePriceShape({ observations: rows, timeZone: TZ, asOf });

/** Peak-to-trough ratio, the thing a flat shape destroys. */
const spread = (multipliers: number[]) =>
  Math.max(...multipliers) / Math.min(...multipliers);

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const assertClose = (
  actual: number,
  expected: number,
  message: string,
  tolerance = 1e-6,
) => {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: ${actual} !== ${expected}`);
  }
};

/** A day whose price is `base`, with a spike over the given local hours. */
const day = (
  isoDate: string,
  base: number,
  spike: { hours: number[]; price: number },
): StoredPriceRow[] => {
  const rows: StoredPriceRow[] = [];
  for (let quarter = 0; quarter < QUARTERS_PER_DAY; quarter += 1) {
    const hour = Math.floor(quarter / 4);
    const minute = (quarter % 4) * 15;
    rows.push({
      // Stockholm is UTC+2 in summer; building the row in local time and
      // converting keeps the fixture readable.
      start_ts: new Date(
        Date.parse(
          `${isoDate}T${String(hour).padStart(2, "0")}:${
            String(minute).padStart(2, "0")
          }:00+02:00`,
        ),
      ).toISOString(),
      import_price_sek_per_kwh: spike.hours.includes(hour) ? spike.price : base,
    });
  }
  return rows;
};

const archive = (days: number, base = 1, spikeHours = [7, 8, 19, 20]) => {
  const rows: StoredPriceRow[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.UTC(2026, 5, 1) + offset * 86_400_000);
    rows.push(...day(
      date.toISOString().slice(0, 10),
      base,
      { hours: spikeHours, price: base * 3 },
    ));
  }
  return rows;
};

Deno.test("quarter index comes from local wall clock", () => {
  const summer = localSlot(Date.parse("2026-06-15T10:30:00+02:00"), TZ);
  assert(summer.quarter === 42, `expected 10:30 to be quarter 42, got ${summer.quarter}`);
  assert(summer.dayType === "weekday", "15 June 2026 is a Monday");
  const weekend = localSlot(Date.parse("2026-06-13T00:00:00+02:00"), TZ);
  assert(weekend.dayType === "weekend", "13 June 2026 is a Saturday");
});

Deno.test("one day of prices already gives a shape, never a flat line", () => {
  // The whole point of the rewrite. A young installation used to fall through
  // every tier to a flat tail, which asserts that 03:00 and 19:00 are worth
  // the same — the one thing any real price day disproves.
  const shape = shapeOf(day("2026-06-29", 1, { hours: [19], price: 4 }))!;
  assert(shape !== null, "a single day must still produce a shape");
  assert(
    spread(shape.byDayType.weekday) > 1.5,
    `a shape from a real day cannot be flat, spread was ${spread(shape.byDayType.weekday)}`,
  );
  assert(
    shape.byDayType.weekday[19 * 4] > shape.byDayType.weekday[3 * 4],
    "the evening spike has to survive into the estimate",
  );
});

Deno.test("more evidence sharpens the same estimate rather than switching mode", () => {
  // There is no tier to cross: the shrinkage simply loosens as weight
  // accumulates, so the curve gets more confident continuously.
  // Same spike either side: `archive` builds its days at three times base, so
  // the single day has to as well or this compares spike sizes rather than
  // evidence. It used to pass at four times only because the shrinkage held
  // the sharper day back harder than it held back ten milder ones.
  const oneDay = shapeOf(day("2026-06-29", 1, { hours: [19], price: 3 }))!;
  const tenDays = shapeOf(archive(10, 1, [19]))!;
  assert(
    spread(tenDays.byDayType.weekday) > spread(oneDay.byDayType.weekday),
    "ten days should assert the peak more strongly than one",
  );
  assert(
    tenDays.observedDays > oneDay.observedDays,
    "ten days must record more observed days",
  );
  assert(
    tenDays.effectiveDays > oneDay.effectiveDays,
    "and more weighted evidence",
  );
});

Deno.test("recent days count for more than old ones", () => {
  // No cut-off, just decay: a day older than the half-life still counts, and
  // counts less.
  const recentSpike = shapeOf([
    ...day("2026-06-29", 1, { hours: [19], price: 4 }),
    ...day("2026-04-01", 1, { hours: [6], price: 4 }),
  ])!;
  assert(
    recentSpike.byDayType.weekday[19 * 4] > recentSpike.byDayType.weekday[6 * 4],
    "yesterday's evening peak should outweigh a spring morning one",
  );
  // And the old day is not discarded: it still lifts its own quarter above the
  // quiet hours around it.
  assert(
    recentSpike.byDayType.weekday[6 * 4] > recentSpike.byDayType.weekday[3 * 4],
    "an old observation must still count for something",
  );
});

Deno.test("a weekend with no weekend history borrows rather than flattening", () => {
  // Weighted, not partitioned: the old design partitioned and left the weekend
  // with nothing until it had a fortnight of its own.
  const weekdaysOnly = [
    ...day("2026-06-29", 1, { hours: [19], price: 4 }),
    ...day("2026-06-30", 1, { hours: [19], price: 4 }),
  ];
  const shape = shapeOf(weekdaysOnly)!;
  assert(
    spread(shape.byDayType.weekend) > 1.3,
    `the weekend shape must not be flat, spread was ${spread(shape.byDayType.weekend)}`,
  );
  // Borrowed evidence is discounted, so the weekend asserts the peak less.
  assert(
    shape.byDayType.weekday[19 * 4] > shape.byDayType.weekend[19 * 4],
    "a borrowed weekend peak should be softer than the measured weekday one",
  );
});

Deno.test("weekend history overrides the borrowed weekday shape", () => {
  const rows = [
    ...day("2026-06-29", 1, { hours: [19], price: 4 }),  // Monday
    ...day("2026-06-27", 1, { hours: [11], price: 4 }),  // Saturday
    ...day("2026-06-28", 1, { hours: [11], price: 4 }),  // Sunday
  ];
  const shape = shapeOf(rows)!;
  assert(
    shape.byDayType.weekend[11 * 4] > shape.byDayType.weekend[19 * 4],
    "measured weekend samples must outweigh borrowed weekday ones",
  );
  assert(
    shape.byDayType.weekday[19 * 4] > shape.byDayType.weekday[11 * 4],
    "and the weekday shape must keep its own peak",
  );
});

Deno.test("the season nearest today carries the most weight", () => {
  // Inert on a young archive and decisive on an old one, with no mode switch:
  // a year-old June informs this June more than last December does.
  const rows = [
    ...day("2025-06-25", 1, { hours: [19], price: 4 }),
    ...day("2025-06-26", 1, { hours: [19], price: 4 }),
    ...day("2025-12-20", 1, { hours: [6], price: 4 }),
    ...day("2025-12-21", 1, { hours: [6], price: 4 }),
  ];
  const shape = shapeOf(rows)!;
  assert(
    shape.byDayType.weekday[19 * 4] > shape.byDayType.weekday[6 * 4],
    "last June should describe this June better than last December does",
  );
});

Deno.test("the estimate keeps the depth of a real day, not the average of days", () => {
  // Averaging is what flattens: a trough that moves between days lands in
  // different quarters and partly cancels, and the shrinkage pulls every
  // quarter further toward 1. The result keeps the timing and loses the depth.
  // A deployed plan showed it plainly — the modelled days spanned 1.49 to 2.57
  // SEK/kWh where the published day spanned 0.905 to 2.705, a floor 0.6 above
  // anything real, so the last published quarters always looked like the
  // bargain of the week and the battery bought against a forecast.
  const rows: StoredPriceRow[] = [];
  const perDay: number[] = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const date = new Date(Date.UTC(2026, 5, 1) + offset * 86_400_000);
    // The evening peak wanders by up to an hour, as real prices do.
    const shift = (offset % 5) - 2;
    const rowsToday = day(
      date.toISOString().slice(0, 10),
      1,
      { hours: [19 + shift, 20 + shift], price: 3 },
    );
    rows.push(...rowsToday);
    const mean = rowsToday.reduce((t, r) => t + r.import_price_sek_per_kwh, 0) /
      rowsToday.length;
    const ratios = rowsToday.map((r) => r.import_price_sek_per_kwh / mean);
    perDay.push(Math.max(...ratios) - Math.min(...ratios));
  }
  const typical = perDay.reduce((t, v) => t + v, 0) / perDay.length;

  const shape = shapeOf(rows, Date.parse("2026-06-14T12:00:00+02:00"))!;
  const multipliers = shape.byDayType.weekday;

  // Dispersion is the honest measure. Peak-to-trough would demand the estimate
  // put the full height back at every hour the peak was ever seen, which is a
  // claim about timing the observations do not support — the smearing is real
  // uncertainty about when, not lost depth.
  const rms = (values: number[]) =>
    Math.sqrt(
      values.reduce((total, value) => total + (value - 1) ** 2, 0) /
        values.length,
    );
  const observedRms = rows.reduce((total, _row, index) => {
    if (index % QUARTERS_PER_DAY !== 0) return total;
    const today = rows.slice(index, index + QUARTERS_PER_DAY);
    const mean = today.reduce((t, r) => t + r.import_price_sek_per_kwh, 0) /
      today.length;
    return total + rms(today.map((r) => r.import_price_sek_per_kwh / mean));
  }, 0) / 12;

  assert(
    rms(multipliers) > observedRms * 0.75,
    `the modelled day must depart from its mean about as far as a real one: ${
      rms(multipliers).toFixed(3)
    } against ${observedRms.toFixed(3)}`,
  );
  const estimated = Math.max(...multipliers) - Math.min(...multipliers);
  assert(
    estimated > typical * 0.6,
    `and keep most of the peak-to-trough: kept ${
      (estimated / typical * 100).toFixed(0)
    }% of a ${typical.toFixed(3)} spread`,
  );
  // And never so deep that a quarter implies energy is free.
  assert(
    Math.min(...shape.byDayType.weekday) > 0,
    "no quarter may be scaled to a non-positive multiplier",
  );
});

Deno.test("shape is independent of level", () => {
  // A cheap day and a dear day with the same profile are the same evidence,
  // which is what lets a summer archive price a winter slot.
  const cheap = shapeOf(archive(5, 0.4, [19]))!;
  const dear = shapeOf(archive(5, 4, [19]))!;
  for (let quarter = 0; quarter < QUARTERS_PER_DAY; quarter += 1) {
    assertClose(
      cheap.byDayType.weekday[quarter],
      dear.byDayType.weekday[quarter],
      `quarter ${quarter} should not depend on the price level`,
      1e-6,
    );
  }
});

Deno.test("a part-archived day is not evidence about a whole day", () => {
  const partial = day("2026-06-30", 1, { hours: [3], price: 9 })
    .filter(row => Date.parse(row.start_ts) < Date.parse("2026-06-30T06:00:00+02:00"));
  const shape = shapeOf([...archive(3, 1, [19]), ...partial])!;
  assert(
    shape.byDayType.weekday[19 * 4] > shape.byDayType.weekday[3 * 4],
    "the whole days should decide the shape, not a few hours of a part-day",
  );
});

Deno.test("no observations at all is the only case with no shape", () => {
  assert(shapeOf([]) === null, "nothing to estimate from means no estimate");
});

Deno.test("the half-life is the documented one", () => {
  // Pinned because the decay is the only thing standing between "three days of
  // history" and "three years" behaving the same way.
  assert(RECENCY_HALF_LIFE_DAYS === 21, "half-life changed without a decision");
});

Deno.test("published prices are always preferred to the estimate", () => {
  const slots = [
    { start: "2026-06-29T00:00:00+02:00", import_price_sek_per_kwh: 5 },
    { start: "2026-06-29T00:15:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, archive(28), { timeZone: TZ, asOf: AS_OF });
  assertClose(
    outlook.shadowImportSekPerKwh[0],
    5,
    "a published slot keeps its own price",
  );
  assert(
    outlook.shadowImportSekPerKwh[1] > 0,
    "an unpriced slot still gets a shadow price",
  );
});

Deno.test("the unpriced tail is dearer at a peak than overnight", () => {
  const slots = [
    { start: "2026-06-29T12:00:00+02:00", import_price_sek_per_kwh: 1 },
    { start: "2026-06-30T03:00:00+02:00", import_price_sek_per_kwh: null },
    { start: "2026-06-30T19:00:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, archive(28), { timeZone: TZ, asOf: AS_OF });
  assert(outlook.shaped, "a shape was available");
  assert(
    outlook.shadowImportSekPerKwh[2] > outlook.shadowImportSekPerKwh[1] * 2,
    `19:00 should shadow-price above 03:00: ${outlook.shadowImportSekPerKwh[2]} vs ${outlook.shadowImportSekPerKwh[1]}`,
  );
});

Deno.test("an empty archive still shapes the tail from the published window", () => {
  // The case the old design gave up on. A brand-new installation has no
  // archive at all, but it does have a day of real prices in front of it, and
  // that is enough to say when energy is dear.
  const slots: Array<{ start: string; import_price_sek_per_kwh: number | null }> =
    day("2026-06-29", 1, { hours: [19], price: 4 }).map((row) => ({
      start: row.start_ts,
      import_price_sek_per_kwh: row.import_price_sek_per_kwh,
    }));
  slots.push(
    { start: "2026-06-30T03:00:00+02:00", import_price_sek_per_kwh: null },
    { start: "2026-06-30T19:00:00+02:00", import_price_sek_per_kwh: null },
  );
  const outlook = buildPriceOutlook(slots, [], { timeZone: TZ, asOf: AS_OF });
  assert(outlook.shaped, "an empty archive must still produce a shaped tail");
  assertClose(outlook.observedDays, 1, "the published day is the evidence", 0);
  assert(
    outlook.shadowImportSekPerKwh.at(-1)! >
      outlook.shadowImportSekPerKwh.at(-2)! * 1.5,
    "the tail must carry the peak the published day showed",
  );
});

Deno.test("a plan with no published price at all yields no outlook", () => {
  const outlook = buildPriceOutlook(
    [{ start: "2026-06-29T12:00:00+02:00", import_price_sek_per_kwh: null }],
    archive(28),
    { timeZone: TZ, asOf: AS_OF },
  );
  assert(outlook.levelSekPerKwh === null, "nothing sets the level");
  assert(!outlook.shaped, "a broken price source is the one unshaped case");
  assertClose(outlook.shadowImportSekPerKwh[0], 0, "and no price is invented");
});

Deno.test("no slot in any plan is ever priced flat when prices exist", () => {
  // The guarantee the whole rewrite is for, stated directly.
  for (const days of [0, 1, 3, 10, 28]) {
    const slots: Array<{ start: string; import_price_sek_per_kwh: number | null }> =
      day("2026-06-29", 1, { hours: [7, 19], price: 3 }).map((row) => ({
        start: row.start_ts,
        import_price_sek_per_kwh: row.import_price_sek_per_kwh,
      }));
    for (let quarter = 0; quarter < QUARTERS_PER_DAY; quarter += 1) {
      slots.push({
        start: new Date(
          Date.parse("2026-06-30T00:00:00+02:00") + quarter * 900_000,
        ).toISOString(),
        import_price_sek_per_kwh: null,
      });
    }
    const outlook = buildPriceOutlook(slots, archive(days), { timeZone: TZ, asOf: AS_OF });
    const tail = outlook.shadowImportSekPerKwh.slice(-QUARTERS_PER_DAY);
    assert(
      Math.max(...tail) / Math.min(...tail) > 1.5,
      `with ${days} days of archive the tail was flat (spread ${
        (Math.max(...tail) / Math.min(...tail)).toFixed(3)
      })`,
    );
  }
});

Deno.test("a cheap published window does not drag the whole tail down", () => {
  // The day-ahead window here is entirely overnight, where the shape multiplier
  // is below 1. Without normalising that out, every daytime slot in the tail
  // would inherit a night-time level and look far too cheap. The night price
  // matches the archive's, so the level has nowhere to revert to.
  const slots = [
    { start: "2026-06-29T02:00:00+02:00", import_price_sek_per_kwh: 1 },
    { start: "2026-06-29T02:15:00+02:00", import_price_sek_per_kwh: 1 },
    { start: "2026-06-30T02:00:00+02:00", import_price_sek_per_kwh: null },
    { start: "2026-06-30T08:00:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, archive(28), { timeZone: TZ, asOf: AS_OF });
  assertClose(outlook.shadowImportSekPerKwh[2], 1, "the same clock hour a day later prices the same", 0.05);
  assertClose(outlook.shadowImportSekPerKwh[3], 3, "and the morning peak is priced as a peak", 0.15);
});

Deno.test("an unpublished day's level leaves the published one for the recent norm as it gets further out", () => {
  // A fortnight at 1 SEK through the night, then a published window at 3: a dear day, not a new normal.
  const night = (date: string, price: number | null) => ({ start: `${date}T02:00:00+02:00`, import_price_sek_per_kwh: price });
  const slots = [night("2026-06-30", 3), night("2026-07-01", null), night("2026-07-02", null), night("2026-07-03", null)];
  const asOf = Date.parse("2026-06-30T02:00:00+02:00");
  const outlook = buildPriceOutlook(slots, archive(29), { timeZone: TZ, asOf });
  const [, one, two, three] = outlook.shadowImportSekPerKwh;
  assert(one < 3 && one > two && two > three, `the level should fall back day by day: ${one}, ${two}, ${three}`);
  // A day out it has moved about half way (0.35 per day, counted from mid-day); three days out it is the norm.
  assertClose(one, 3 - 0.525 * 2, "one day out", 0.1);
  assertClose(three, 1, "three days out", 0.05);
  // With too little history to call anything a norm, the published level is carried forward as before.
  const young = buildPriceOutlook(slots, archive(29).slice(-96 * 3), { timeZone: TZ, asOf });
  assertClose(young.shadowImportSekPerKwh[3], 3, "no norm, no reversion", 0.05);
});

Deno.test("with wind, an unpublished day is priced by the wind forecast for it rather than by the recent norm", () => {
  // Thirty flat days whose level fell 0.25 SEK for every m/s of wind: 2 SEK at 2 m/s, 1 SEK at 6.
  const asOf = Date.parse("2026-07-01T00:00:00Z");
  const speedOn = (daysBack: number) => 2 + (daysBack * 7) % 5;
  const dayOf = (offset: number) => new Date(asOf + offset * 86_400_000).toISOString().slice(0, 10);
  const history: StoredPriceRow[] = [];
  const wind = [];
  for (let daysBack = 30; daysBack >= 1; daysBack -= 1) {
    wind.push({ day: dayOf(-daysBack), mean_speed_m_s: speedOn(daysBack) });
    for (let hour = 0; hour < 24; hour += 1) {
      history.push({
        start_ts: new Date(asOf - daysBack * 86_400_000 + hour * 3_600_000).toISOString(),
        import_price_sek_per_kwh: 2.5 - 0.25 * speedOn(daysBack),
      });
    }
  }
  // Today is published at 4 m/s and priced as its wind says; a calm day and a gale follow.
  wind.push({ day: dayOf(0), mean_speed_m_s: 4 }, { day: dayOf(1), mean_speed_m_s: 2 }, { day: dayOf(2), mean_speed_m_s: 6 });
  const noon = (offset: number, price: number | null) => ({ start: new Date(asOf + offset * 86_400_000 + 12 * 3_600_000).toISOString(), import_price_sek_per_kwh: price });
  const slots = [noon(0, 1.5), noon(1, null), noon(2, null), noon(3, null)];

  const outlook = buildPriceOutlook(slots, history, { timeZone: "UTC", asOf, wind });
  assert(outlook.levelBasis === "wind", `the level should stand on wind, not ${outlook.levelBasis}`);
  assertClose(outlook.shadowImportSekPerKwh[1], 2, "a calm day is dear", 0.05);
  assertClose(outlook.shadowImportSekPerKwh[2], 1, "a windy day is cheap", 0.05);
  // A day the forecast does not reach falls back on the recent norm.
  assertClose(outlook.shadowImportSekPerKwh[3], 1.5, "past the forecast", 0.3);

  // A published day dearer than its wind explains carries part of that into the days after.
  const dear = buildPriceOutlook([noon(0, 2.5), ...slots.slice(1)], history, { timeZone: "UTC", asOf, wind });
  assert(dear.shadowImportSekPerKwh[1] > 2.3 && dear.shadowImportSekPerKwh[2] > 1 && dear.shadowImportSekPerKwh[2] < 1.5,
    `the surprise should fade: ${dear.shadowImportSekPerKwh[1]}, ${dear.shadowImportSekPerKwh[2]}`);

  // Too few days of wind, or prices that rose with it, are no evidence: the norm is used as before.
  const few = buildPriceOutlook(slots, history, { timeZone: "UTC", asOf, wind: wind.slice(-10) });
  assert(few.levelBasis === "recent_norm", `ten days should not make a fit: ${few.levelBasis}`);
  const backwards = buildPriceOutlook(slots, history, { timeZone: "UTC", asOf, wind: wind.map((entry) => ({ ...entry, mean_speed_m_s: 10 - entry.mean_speed_m_s })) });
  assert(backwards.levelBasis === "recent_norm", `prices rising with wind should not be used: ${backwards.levelBasis}`);
});

Deno.test("the unpublished tail starts where the published prices ended and relaxes into the modelled day", () => {
  // A fortnight of ordinary days, then a published day whose last two hours collapse to 0.1.
  const published = day("2026-06-29", 1, { hours: [7, 8, 19, 20], price: 3 })
    .map((row, quarter) => ({ start: row.start_ts, import_price_sek_per_kwh: quarter >= 88 ? 0.1 : row.import_price_sek_per_kwh }));
  const tail = [...day("2026-06-30", 0, { hours: [], price: 0 }), ...day("2026-07-01", 0, { hours: [], price: 0 })]
    .map((row) => ({ start: row.start_ts, import_price_sek_per_kwh: null }));
  const asOf = Date.parse("2026-06-29T00:00:00+02:00");
  const outlook = buildPriceOutlook([...published, ...tail], archive(28), { timeZone: TZ, asOf });
  const at = (quarter: number) => outlook.shadowImportSekPerKwh[96 + quarter];
  assertClose(at(0), 0.1, "midnight continues from the last published price", 0.01);
  // The night is cheaper than the evening in the model; ending below it must not price the night at nothing.
  assert(outlook.shadowImportSekPerKwh.slice(96).every((price) => price >= 0.09), "no quarter after a low ending is priced below it");
  assert(at(0) < at(12) && at(12) < at(24), `the night should climb back gradually: ${at(0)}, ${at(12)}, ${at(24)}`);
  // Six hours on, half the gap is left; a day and a half on, nothing to speak of.
  const modelled = outlook.shadowImportSekPerKwh[96 + 96 + 48];
  assertClose(at(24), (at(0) + modelled) / 2, "half way after six hours", 0.1);
  assertClose(at(96 + 48), modelled, "the modelled day by the second noon", 0.02);
});

Deno.test("no quarter is estimated under the cheapest price on record", () => {
  // A month whose nights sit on a fee floor of 0.8 with days at 2.4, then a
  // published day three times cheaper on the market than any of them: scaling
  // the whole price by the shape would put its nights far under the fees.
  const history = archive(28, 0.8, [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const published = day("2026-06-29", 0.8, { hours: [12], price: 0.85 })
    .map((row) => ({ start: row.start_ts, import_price_sek_per_kwh: row.import_price_sek_per_kwh }));
  const tail = day("2026-06-30", 0, { hours: [], price: 0 }).map((row) => ({ start: row.start_ts, import_price_sek_per_kwh: null }));
  const outlook = buildPriceOutlook([...published, ...tail], history, { timeZone: TZ, asOf: Date.parse("2026-06-29T00:00:00+02:00") });
  const estimates = outlook.shadowImportSekPerKwh.slice(96);
  assert(estimates.every((price) => price >= 0.8 - 1e-9), `lowest estimate ${Math.min(...estimates)}`);
  assert(Math.max(...estimates) > 0.8, "and the day keeps its shape above the floor");
});
