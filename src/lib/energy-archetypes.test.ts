import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert';
import {
  ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2,
  archetypePrior,
  BEN_HOUSEHOLD_ELECTRICITY_KWH_M2,
  BUILD_YEAR_BANDS,
  bandForYear,
  disaggregateWholeHome,
  HEATING_SYSTEM_FACTORS,
  normalizeDwelling,
  normalizeHeating,
} from './energy-archetypes.ts';

/**
 * Energimyndigheten table 2.14, temperature-corrected, kWh/m². Transcribed from
 * `smh_2024_tabellverk_v2.xlsx` so a silent edit to the constants fails here.
 */
const PUBLISHED_BY_BAND: Record<string, number> = {
  '<=1940': 113.6,
  '1941-1960': 93.9,
  '1961-1970': 89.4,
  '1971-1980': 81.1,
  '1981-1990': 94.7,
  '1991-2000': 98.4,
  '2001-2010': 82.3,
  '2011-2020': 55.5,
  '2021-': 40.2,
};

Deno.test('every band matches the published table', () => {
  for (const band of BUILD_YEAR_BANDS) {
    assertEquals(
      band.heatingAndHotWater.kwhPerM2,
      PUBLISHED_BY_BAND[band.key],
      `${band.key} must match table 2.14`,
    );
    assertEquals(band.heatingAndHotWater.provenance, 'published', `${band.key} provenance`);
  }
  assertEquals(BUILD_YEAR_BANDS.length, Object.keys(PUBLISHED_BY_BAND).length, 'band count');
});

Deno.test('the all-stock fallback is the published SAMTLIGA figure', () => {
  assertEquals(ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2, 93.3);
});

Deno.test('energy use does NOT fall monotonically with build year', () => {
  // This was assumed before the official workbook was available, and it is
  // false: the 1980s and 1990s bands sit above 1971-1980. The test is kept
  // pointing the right way so nobody "tidies" the table into a smooth curve.
  const eighties = bandForYear(1985)!.heatingAndHotWater.kwhPerM2;
  const seventies = bandForYear(1975)!.heatingAndHotWater.kwhPerM2;
  const nineties = bandForYear(1995)!.heatingAndHotWater.kwhPerM2;
  assert(eighties > seventies, '1981-1990 uses more per m² than 1971-1980');
  assert(nineties > eighties, '1991-2000 uses more per m² than 1981-1990');
  // The long-run direction still holds at the ends.
  assert(bandForYear(2024)!.heatingAndHotWater.kwhPerM2 < bandForYear(1920)!.heatingAndHotWater.kwhPerM2);
});

Deno.test('direct electric heating sits below the stock average, not above', () => {
  // Also assumed wrong before the workbook: a resistive house buys every kWh of
  // heat, but the stock average is dragged up by oil and biomass homes.
  assert(
    HEATING_SYSTEM_FACTORS.resistive.kwhPerM2 < 1,
    `resistive factor should be below 1, got ${HEATING_SYSTEM_FACTORS.resistive.kwhPerM2}`,
  );
  assertAlmostEquals(HEATING_SYSTEM_FACTORS.resistive.kwhPerM2, 74.0 / 93.3, 1e-9);
  assertAlmostEquals(HEATING_SYSTEM_FACTORS.ground_source_heat_pump.kwhPerM2, 50.2 / 93.3, 1e-9);
  assertAlmostEquals(HEATING_SYSTEM_FACTORS.district_heating.kwhPerM2, 122.4 / 93.3, 1e-9);
  assertAlmostEquals(HEATING_SYSTEM_FACTORS.biomass.kwhPerM2, 167.9 / 93.3, 1e-9);
  assertEquals(HEATING_SYSTEM_FACTORS.unknown.kwhPerM2, 1);
});

Deno.test('biomass and district heating use more than the average, and pumps less', () => {
  const f = HEATING_SYSTEM_FACTORS;
  assert(f.biomass.kwhPerM2 > f.district_heating.kwhPerM2);
  assert(f.district_heating.kwhPerM2 > 1);
  assert(f.resistive.kwhPerM2 > f.air_water_heat_pump.kwhPerM2);
  assert(f.air_water_heat_pump.kwhPerM2 > f.ground_source_heat_pump.kwhPerM2);
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
  // 93.3 total, of which 20 kWh/m² is hot water, ×1.0 factors, plus property.
  assertAlmostEquals(prior.heatingKwh, (93.3 - 20) * 100, 0.01);
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
