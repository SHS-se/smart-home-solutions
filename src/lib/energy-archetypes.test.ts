import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert';
import {
  ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2,
  archetypePrior,
  BEN_HOUSEHOLD_ELECTRICITY_KWH_M2,
  BUILD_YEAR_BANDS,
  bandForYear,
  disaggregateWholeHome,
  normalizeDwelling,
  normalizeHeating,
} from './energy-archetypes.ts';

// Approximate Swedish småhus stock shares by build year, used only to check
// that the interpolated bands still reproduce the published averages.
const STOCK_SHARES: Record<string, number> = {
  '<=1940': 0.20,
  '1941-1960': 0.15,
  '1961-1970': 0.13,
  '1971-1980': 0.18,
  '1981-1990': 0.11,
  '1991-2000': 0.07,
  '2001-2010': 0.08,
  '2011-2020': 0.06,
  '2021-': 0.02,
};

Deno.test('the band table reproduces the published all-stock average', () => {
  const mean = BUILD_YEAR_BANDS.reduce(
    (sum, band) => sum + band.heatingAndHotWater.kwhPerM2 * STOCK_SHARES[band.key],
    0,
  );
  assertAlmostEquals(mean, ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2, 0.2);
});

Deno.test('the band table reproduces the published 2011-or-later average', () => {
  const recent = BUILD_YEAR_BANDS.filter((band) => (band.minYear ?? 0) >= 2011);
  const share = recent.reduce((sum, band) => sum + STOCK_SHARES[band.key], 0);
  const mean = recent.reduce(
    (sum, band) => sum + band.heatingAndHotWater.kwhPerM2 * STOCK_SHARES[band.key],
    0,
  ) / share;
  assertAlmostEquals(mean, 53.4, 0.1);
});

Deno.test('published anchors are marked as published, not interpolated', () => {
  assertEquals(bandForYear(1920)?.heatingAndHotWater.provenance, 'published');
  assertEquals(bandForYear(2024)?.heatingAndHotWater.provenance, 'published');
  assertEquals(bandForYear(1975)?.heatingAndHotWater.provenance, 'interpolated');
});

Deno.test('energy use falls monotonically with build year', () => {
  for (let i = 1; i < BUILD_YEAR_BANDS.length; i += 1) {
    const previous = BUILD_YEAR_BANDS[i - 1].heatingAndHotWater.kwhPerM2;
    const current = BUILD_YEAR_BANDS[i].heatingAndHotWater.kwhPerM2;
    assert(current < previous, `${BUILD_YEAR_BANDS[i].key} should use less than the previous band`);
  }
});

Deno.test('a heat pump lowers delivered heating against an identical resistive house', () => {
  const base = { yearBuilt: 1975, dwelling: 'detached' as const, heatedAreaM2: 150 };
  const resistive = archetypePrior({ ...base, heating: 'resistive' });
  const ground = archetypePrior({ ...base, heating: 'ground_source_heat_pump' });
  assert(ground.heatingKwh < resistive.heatingKwh);
  // Hot water is normalised by BEN and must not move with the heating system.
  assertEquals(ground.hotWaterKwh, resistive.hotWaterKwh);
});

Deno.test('an unknown build year falls back to the published all-stock average', () => {
  const prior = archetypePrior({
    yearBuilt: null,
    dwelling: 'detached',
    heating: 'unknown',
    heatedAreaM2: 100,
  });
  assertEquals(prior.band, null);
  // 90.5 total, of which 20 kWh/m² is hot water, ×1.0 factors, plus property.
  assertAlmostEquals(prior.heatingKwh, (90.5 - 20) * 100, 0.01);
});

Deno.test('disaggregation keeps the measured total and the BEN household standard', () => {
  const input = {
    yearBuilt: 1975,
    dwelling: 'detached' as const,
    heating: 'resistive' as const,
    heatedAreaM2: 150,
  };
  const measured = 28_000;
  const split = disaggregateWholeHome(measured, input);

  assertAlmostEquals(split.wholeHomeKwh, measured, 0.01);
  assertAlmostEquals(
    split.householdElectricityKwh,
    BEN_HOUSEHOLD_ELECTRICITY_KWH_M2 * 150,
    0.01,
  );
  assertAlmostEquals(
    split.heatingKwh + split.hotWaterKwh + split.propertyEnergyKwh,
    split.buildingEnergyKwh,
    0.01,
  );
  assertAlmostEquals(
    split.buildingEnergyKwh + split.householdElectricityKwh,
    measured,
    0.01,
  );
});

Deno.test('a whole-home total smaller than household electricity cannot go negative', () => {
  const split = disaggregateWholeHome(1_000, {
    yearBuilt: 2015,
    dwelling: 'detached',
    heating: 'ground_source_heat_pump',
    heatedAreaM2: 150,
  });
  assert(split.buildingEnergyKwh >= 0);
  assert(split.heatingKwh >= 0);
  assertAlmostEquals(split.wholeHomeKwh, 1_000, 0.01);
});

Deno.test('questionnaire answers map onto archetype enums', () => {
  assertEquals(normalizeDwelling('Villa'), 'detached');
  assertEquals(normalizeDwelling('Radhus'), 'terraced');
  assertEquals(normalizeDwelling('Lägenhet'), 'apartment');
  assertEquals(normalizeDwelling(''), null);

  assertEquals(normalizeHeating('Bergvärmepump'), 'ground_source_heat_pump');
  assertEquals(normalizeHeating('Luft-luftvärmepump'), 'air_air_heat_pump');
  assertEquals(normalizeHeating('Fjärrvärme'), 'district_heating');
  assertEquals(normalizeHeating(null), null);
});

Deno.test('the most efficient present system decides the heating archetype', () => {
  // A house with direct electric radiators AND a ground-source pump is heated
  // by the pump; scoring it as resistive would overstate its energy by ~2.7×.
  assertEquals(
    normalizeHeating(['Direktverkande el', 'Bergvärme']),
    'ground_source_heat_pump',
  );
});

Deno.test('a large all-electric 1970s house lands in a believable range', () => {
  // Sanity anchor for the reference home: 424 m², resistive plus air-air.
  const prior = archetypePrior({
    yearBuilt: 1975,
    dwelling: 'detached',
    heating: 'air_air_heat_pump',
    heatedAreaM2: 424,
  });
  // Not the 648 kWh/year of heating the old page claimed.
  assert(prior.heatingKwh > 10_000, `heating was ${prior.heatingKwh}`);
  assert(prior.heatingKwh < 40_000, `heating was ${prior.heatingKwh}`);
});
