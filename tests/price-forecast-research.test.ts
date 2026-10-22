import { comparePriceForecasts, type ResearchBundle } from "../supabase/functions/_shared/price-forecast-research.ts";

const DAY = 86_400_000, QUARTER = 900_000;
const START = Date.parse("2026-06-01T00:00:00Z");
const day = (offset: number) => new Date(START + offset * DAY).toISOString().slice(0, 10);
const speed = (offset: number) => 2 + offset % 5;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function close(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
}
function fixture(): ResearchBundle {
  return {
    prices: Array.from({ length: 36 * 96 }, (_, index) => ({
      start_ts: new Date(START + index * QUARTER).toISOString(),
      import_price_sek_per_kwh: 2.5 - 0.25 * speed(Math.floor(index / 96)),
    })),
    observedWind: Array.from({ length: 36 }, (_, index) => ({ day: day(index), mean_speed_m_s: speed(index) })),
    windForecasts: Array.from({ length: 16 }, (_, issue) => Array.from({ length: 5 }, (_, ahead) => ({
      day: day(issue + 20 + ahead), mean_speed_m_s: speed(issue + 20 + ahead) * 0.8,
      issued_on: day(issue + 20), issued_at: new Date(START + (issue + 20) * DAY + 18 * 3_600_000).toISOString(),
    }))).flat(),
    market: [],
  };
}

Deno.test("forecast research compares real estimators on paired quarters and reproduces live wind calibration", () => {
  const report = comparePriceForecasts(fixture());
  assert(report.origins.length > 0, "rolling origins are selected after archive warm-up");
  assert(report.paired.quarters > 0, "saved as-of issues supply paired quarters");
  const [plain, wind] = report.paired.models;
  assert(plain.metrics && wind.metrics, "both paired models have metrics");
  close(plain.metrics.quarters, wind.metrics.quarters, "same number of quarters");
  close(plain.metrics.origins, wind.metrics.origins, "same number of origins");
  close(report.origins[0].calibrationScale, 1.25, "training-day forecasts are calibrated against completed-day observations");
  assert(report.origins[0].windModelUsed, "the real wind-level model is active for a negative fitted relationship");
  assert(Object.hasOwn(plain.byHorizon, "D+2") && Object.hasOwn(plain.byHorizon, "D+3"), "lead days are reported separately");
  assert(report.assumptions.some(text => text.includes("publication vintages")), "price publication reconstruction is disclosed");
});

Deno.test("future wind issues and incomplete future observations cannot leak into reconstructed origins", () => {
  const bundle = fixture();
  const expected = comparePriceForecasts(bundle);
  const contaminated = structuredClone(bundle);
  contaminated.windForecasts.push(...bundle.windForecasts.map(row => ({ ...row,
    issued_at: "2099-01-01T00:00:00Z", mean_speed_m_s: 100 })));
  contaminated.observedWind = contaminated.observedWind.map(row => row.day >= day(35)
    ? { ...row, mean_speed_m_s: 100 } : row);
  const actual = comparePriceForecasts(contaminated);
  assert(JSON.stringify(actual) === JSON.stringify(expected), "post-origin issues and unfinished-day observations must have no effect");
});

Deno.test("unpublished target prices are scored but never added to the origin's training data", () => {
  const bundle = fixture();
  const first = comparePriceForecasts(bundle).origins[0];
  const changed = structuredClone(bundle);
  const target = Date.parse(first.publishedUntil);
  const row = changed.prices.find(row => Date.parse(row.start_ts) === target)!;
  row.import_price_sek_per_kwh += 100;
  const after = comparePriceForecasts(changed).origins[0];
  close(after.metrics.no_wind.bias - first.metrics.no_wind.bias, -100 / first.quarters,
    "changing one unpublished outcome changes error alone, not the forecast");
});

Deno.test("missing target quarters and absent saved wind remain explicit gaps", () => {
  const bundle = fixture();
  const complete = comparePriceForecasts(bundle);
  const first = complete.origins[0];
  const gapped = structuredClone(bundle);
  gapped.prices = gapped.prices.filter(row => Date.parse(row.start_ts) !== Date.parse(first.publishedUntil));
  const result = comparePriceForecasts(gapped);
  close(result.origins[0].quarters, first.quarters - 1, "a missing quarter is not filled");
  close(result.origins[0].pairedQuarters, first.pairedQuarters - 1, "both paired models lose the same quarter");
  const noSavedIssues = comparePriceForecasts({ ...bundle, windForecasts: [] });
  close(noSavedIssues.paired.quarters, 0, "actual future wind cannot replace a missing saved forecast");
  assert(noSavedIssues.models.find(model => model.id === "wind")?.status === "unavailable", "missing forecasts are reported");
  assert(noSavedIssues.models.find(model => model.id === "no_wind")?.status === "available", "plain estimator is still evaluated");
  assert(noSavedIssues.retrospective.status === "unavailable", "missing market factors cannot become zeros");
});

Deno.test("retrospective actual-factor experiments are chronological and disclose unavailable factors", () => {
  const bundle = fixture();
  bundle.market = [{ signal: "wind_actual", evidence: "retrospective", intervals:
    Array.from({ length: 36 }, (_, index) => ({ startMs: START + index * DAY,
      endMs: START + (index + 1) * DAY, value: speed(index) * 1000 })) }];
  const report = comparePriceForecasts(bundle);
  const wind = report.retrospective.models.find(model => model.id === "calendar_lags_wind")!;
  assert(wind.status === "available" && wind.days > 0 && wind.mae !== null, "held-out factor rows are evaluated");
  assert(report.retrospective.models.find(model => model.id === "calendar_lags_load_solar")?.status === "unavailable", "load and solar are not invented");
  assert(report.assumptions.some(text => text.includes("retrospective/oracle")), "actual factors are not presented as forecast vintages");
});

Deno.test("overlapping market intervals cannot fabricate twenty hours of factor coverage", () => {
  const bundle = fixture();
  bundle.market = [{ signal: "wind_actual", evidence: "retrospective", intervals:
    Array.from({ length: 36 }, (_, index) => {
      const at = START + index * DAY;
      return [
        { startMs: at, endMs: at + 12 * 3_600_000, value: speed(index) * 1000 },
        { startMs: at + 8 * 3_600_000, endMs: at + 16 * 3_600_000, value: speed(index) * 1000 },
      ];
    }).flat() }];
  const result = comparePriceForecasts(bundle).retrospective;
  const wind = result.models.find(model => model.id === "calendar_lags_wind")!;
  assert(wind.status === "unavailable", "overlapping intervals cannot qualify a factor model");
  assert(wind.reason?.includes("Overlapping non-identical intervals in wind_actual"), "invalid signal coverage is explained explicitly");
  close(wind.days, 0, "summed interval lengths are not substituted for genuine coverage");
});

Deno.test("uneven factor coverage is scored on identical held-out target days across ablations", () => {
  const bundle = fixture();
  const series = (signal: string, eligible: (index: number) => boolean) => ({
    signal, evidence: "retrospective" as const,
    intervals: Array.from({ length: 36 }, (_, index) => index).filter(eligible).map(index => ({
      startMs: START + index * DAY, endMs: START + (index + 1) * DAY, value: speed(index) * 1000,
    })),
  });
  bundle.market = [series("wind_actual", () => true),
    series("load_actual", index => index <= 28),
    series("solar_actual", index => index <= 28 && index !== 26),
    series("nuclear_actual", index => index >= 10)];
  const report = comparePriceForecasts(bundle);
  const available = report.retrospective.models.filter(model => model.status === "available");
  close(available.length, 4, "all four specifications have enough chronological training rows");
  const expectedDays = [24, 25, 27, 28].map(day);
  for (const model of available) {
    assert(JSON.stringify(model.targetDays) === JSON.stringify(expectedDays), "all ablations use the held-out-day intersection despite unequal raw coverage");
    close(model.days, expectedDays.length, "sample counts describe the shared comparison set");
    assert(model.baselineMae !== null, "each baseline is paired on those same held-out days");
  }
});

Deno.test("factor ablations with disjoint held-out days are explicitly unavailable", () => {
  const bundle = fixture();
  bundle.market = ["wind_actual", "load_actual", "solar_actual"].map(signal => ({
    signal, evidence: "retrospective",
    intervals: Array.from({ length: 36 }, (_, index) => index)
      .filter(index => signal === "wind_actual" ? index <= 22 : index >= 10)
      .map(index => ({ startMs: START + index * DAY, endMs: START + (index + 1) * DAY,
        value: speed(index) * 1000 })),
  }));
  const report = comparePriceForecasts(bundle);
  assert(report.retrospective.status === "unavailable", "disjoint held-out populations cannot be compared");
  for (const id of ["calendar_lags_wind", "calendar_lags_load_solar"]) {
    const result = report.retrospective.models.find(model => model.id === id)!;
    assert(result.reason?.includes("No common held-out target days"), "the missing common population is explained");
    assert(result.targetDays.length === 0 && result.mae === null, "no misleading MAE is published");
  }
});

Deno.test("empty research input reports unavailable experiments without fabricating forecasts", () => {
  const report = comparePriceForecasts({ prices: [], observedWind: [], windForecasts: [], market: [] });
  close(report.origins.length, 0, "no origins without prices");
  assert(report.models.every(model => model.status === "unavailable"), "all price models are unavailable");
});
