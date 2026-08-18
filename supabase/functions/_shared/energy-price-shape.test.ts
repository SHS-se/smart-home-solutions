import {
  buildPriceOutlook,
  buildPriceShape,
  localSlot,
  MIN_SHAPE_COVERAGE_DAYS,
  QUARTERS_PER_DAY,
  type StoredPriceRow,
} from "./energy-price-shape.ts";

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
  const summer = localSlot(Date.parse("2026-06-15T10:30:00+02:00"), "Europe/Stockholm");
  assert(summer.quarter === 42, `expected 10:30 to be quarter 42, got ${summer.quarter}`);
  assert(summer.dayType === "weekday", "15 June 2026 is a Monday");
  const weekend = localSlot(Date.parse("2026-06-13T00:00:00+02:00"), "Europe/Stockholm");
  assert(weekend.dayType === "weekend", "13 June 2026 is a Saturday");
});

Deno.test("a young archive falls back to the last few days, never to flat", () => {
  // This used to return nothing below the coverage floor, and the planner then
  // priced two thirds of every horizon flat. Flat is not the absence of a
  // claim: it asserts a kWh at 03:00 is worth exactly what one at 18:00 is
  // worth, which the archive reliably shows to be false. A three-day mean is a
  // weaker claim than a fortnight's median and a far better one than that.
  const shape = buildPriceShape(archive(MIN_SHAPE_COVERAGE_DAYS - 1));
  assert(shape !== null, "a young archive must still produce a shape");
  assert(shape!.basis === "recent", `expected the recent tier, got ${shape!.basis}`);
  const weekday = shape!.byDayType.weekday;
  // The fixture spikes 07:00 and 19:00; the fallback has to find them too.
  assert(
    weekday[7 * 4] > weekday[3 * 4] * 2,
    `07:00 should stay dearer than 03:00, got ${weekday[7 * 4]} vs ${weekday[3 * 4]}`,
  );
  assert(
    weekday[19 * 4] > weekday[3 * 4] * 2,
    `19:00 should stay dearer than 03:00, got ${weekday[19 * 4]} vs ${weekday[3 * 4]}`,
  );
});

Deno.test("a full archive still uses the median tier", () => {
  // Coverage is counted per day type, so a fortnight of calendar days is not a
  // fortnight of weekdays: four weeks is what clears the floor on both.
  const shape = buildPriceShape(archive(28));
  assert(shape !== null, "a full archive must produce a shape");
  assert(shape!.basis === "median", `expected the median tier, got ${shape!.basis}`);
});

Deno.test("the fallback follows the days just gone, not the oldest ones", () => {
  // Ordering matters for a young archive: a shape built from whatever happened
  // to be collected first would lag the market by a week.
  const old = [
    day("2026-06-01", 1, { hours: [3], price: 9 }),
    day("2026-06-02", 1, { hours: [3], price: 9 }),
    day("2026-06-03", 1, { hours: [3], price: 9 }),
  ].flat();
  const recent = [
    day("2026-06-10", 1, { hours: [19], price: 9 }),
    day("2026-06-11", 1, { hours: [19], price: 9 }),
    day("2026-06-12", 1, { hours: [19], price: 9 }),
  ].flat();
  const shape = buildPriceShape([...old, ...recent])!;
  assert(shape.basis === "recent", "six days is still the fallback tier");
  assert(
    shape.byDayType.weekday[19 * 4] > shape.byDayType.weekday[3 * 4],
    "the recent evening spike should outweigh the older small-hours one",
  );
});

Deno.test("an empty archive is the one case with no shape at all", () => {
  // Refusing to invent something from nothing is still right; the fallback only
  // ever averages prices that were actually recorded.
  assert(buildPriceShape([]) === null, "no archive means no shape");
});

Deno.test("a measured shape finds the peaks it was given", () => {
  const shape = buildPriceShape(archive(28));
  assert(shape !== null, "28 days should publish a shape");
  const weekday = shape!.byDayType.weekday;
  // 07:00 and 19:00 were tripled; 03:00 was not.
  assert(
    weekday[7 * 4] > weekday[3 * 4] * 2,
    `morning peak should stand above the night: ${weekday[7 * 4]} vs ${weekday[3 * 4]}`,
  );
  assert(
    weekday[19 * 4] > weekday[3 * 4] * 2,
    `evening peak should stand above the night: ${weekday[19 * 4]} vs ${weekday[3 * 4]}`,
  );
});

Deno.test("the shape is normalised, so level does not leak into it", () => {
  // The same curve at ten times the price must produce the same multipliers,
  // or a summer archive would price a winter slot at summer money.
  const cheap = buildPriceShape(archive(28, 1))!;
  const dear = buildPriceShape(archive(28, 10))!;
  for (let quarter = 0; quarter < QUARTERS_PER_DAY; quarter += 1) {
    assertClose(
      cheap.byDayType.weekday[quarter],
      dear.byDayType.weekday[quarter],
      `quarter ${quarter} multiplier must not depend on level`,
      1e-9,
    );
  }
});

Deno.test("published prices are always preferred to the prior", () => {
  const shape = buildPriceShape(archive(28));
  const slots = [
    { start: "2026-06-29T00:00:00+02:00", import_price_sek_per_kwh: 5 },
    { start: "2026-06-29T00:15:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, shape);
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
  const shape = buildPriceShape(archive(28));
  const slots = [
    // One published slot sets the level.
    { start: "2026-06-29T12:00:00+02:00", import_price_sek_per_kwh: 1 },
    { start: "2026-06-30T03:00:00+02:00", import_price_sek_per_kwh: null },
    { start: "2026-06-30T19:00:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, shape);
  assert(outlook.shaped, "a shape was available");
  assert(
    outlook.shadowImportSekPerKwh[2] > outlook.shadowImportSekPerKwh[1] * 2,
    `19:00 should shadow-price above 03:00: ${outlook.shadowImportSekPerKwh[2]} vs ${outlook.shadowImportSekPerKwh[1]}`,
  );
});

Deno.test("with no shape the tail is flat at the published level", () => {
  const slots = [
    { start: "2026-06-29T12:00:00+02:00", import_price_sek_per_kwh: 2 },
    { start: "2026-06-30T03:00:00+02:00", import_price_sek_per_kwh: null },
    { start: "2026-06-30T19:00:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, null);
  assert(!outlook.shaped, "no shape was available");
  assertClose(outlook.shadowImportSekPerKwh[1], 2, "flat at the level");
  assertClose(outlook.shadowImportSekPerKwh[2], 2, "flat at the level");
});

Deno.test("a plan with no published price at all yields no outlook", () => {
  const outlook = buildPriceOutlook(
    [{ start: "2026-06-29T12:00:00+02:00", import_price_sek_per_kwh: null }],
    buildPriceShape(archive(28)),
  );
  assert(outlook.levelSekPerKwh === null, "nothing sets the level");
  assertClose(outlook.shadowImportSekPerKwh[0], 0, "and no price is invented");
});

Deno.test("a cheap published window does not drag the whole tail down", () => {
  // The day-ahead window here is entirely overnight, where the shape multiplier
  // is below 1. Without normalising that out, every daytime slot in the tail
  // would inherit a night-time level and look far too cheap.
  const shape = buildPriceShape(archive(28));
  const slots = [
    { start: "2026-06-29T02:00:00+02:00", import_price_sek_per_kwh: 0.5 },
    { start: "2026-06-29T02:15:00+02:00", import_price_sek_per_kwh: 0.5 },
    { start: "2026-06-30T02:00:00+02:00", import_price_sek_per_kwh: null },
  ];
  const outlook = buildPriceOutlook(slots, shape);
  assertClose(
    outlook.shadowImportSekPerKwh[2],
    0.5,
    "the same clock hour a day later prices the same",
    0.02,
  );
});

Deno.test("weekend borrows the weekday shape rather than inventing one", () => {
  // Four weeks of weekdays and a single weekend day: the weekend is below the
  // floor, so it takes the weekday curve instead of a three-sample fit.
  const rows = archive(28).filter((row) => {
    const local = localSlot(Date.parse(row.start_ts), "Europe/Stockholm");
    return local.dayType === "weekday" || local.dayKey === "2026-06-06";
  });
  const shape = buildPriceShape(rows)!;
  assert(shape !== null, "weekdays alone should publish a shape");
  assertClose(
    shape.byDayType.weekend[19 * 4],
    shape.byDayType.weekday[19 * 4],
    "the weekend falls back to the weekday curve",
  );
});
