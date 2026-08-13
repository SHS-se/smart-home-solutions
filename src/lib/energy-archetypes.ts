// Cold-start archetype priors for Swedish småhus.
//
// Why this exists: most customers will never have per-category metering. Many
// will have, at best, a whole-home total — often from a solar inverter's load
// meter rather than the utility meter. A prospective customer has nothing at
// all. We still need a defensible expected energy breakdown so the portal can
// show a modelled energy performance and a modelled ROI, clearly badged as
// modelled, and so a partial-year measurement has something to be blended
// against instead of being naively extrapolated (see ENERGY_OPTIMISATION_
// ARCHITECTURE.md §1.3.1 and §1.3.2).
//
// Provenance is tracked per number. `published` values come from named public
// statistics; `interpolated` values are fitted between published anchors;
// `modelled` values are our own physical assumptions. Nothing here is allowed
// to be an unattributed guess.
//
// PRIMARY SOURCE — Energimyndigheten, "Energistatistik för småhus 2024",
// table workbook `smh_2024_tabellverk_v2.xlsx` (published 2025-06-10):
//   - Table 2.14, temperature-corrected, kWh/m² by build year
//   - Table 2.15, temperature-corrected, kWh/m² by heating system
// https://www.energimyndigheten.se/statistik/officiell-energistatistik/tillforsel-och-anvandning/energistatistik-for-smahus/
//
// Both are *heating and hot water only*, excluding household electricity, and
// excluding heat absorbed from the ground or air by heat pumps. That is exactly
// the delivered ("köpt") energy the BBR primary-energy number is built from.
// The temperature-corrected series is used throughout because a prior should
// describe a normal year, which is the same basis the degree-day normalization
// in `energiprestanda.ts` targets.
//
// TWO ASSUMPTIONS WERE WRONG BEFORE THE REAL TABLE ARRIVED, and both are worth
// remembering because they were confident and plausible:
//
//  1. **Energy use does not fall monotonically with build year.** It drops to
//     81.1 kWh/m² for 1971–1980, then rises again to 94.7 and 98.4 for
//     1981–1990 and 1991–2000, before falling away after 2010. Interpolating a
//     smooth decline put 1991–2000 at 72 against a published 98.4 — a 26
//     kWh/m² error, more than a whole class boundary for a large house.
//  2. **Direct electric heating is below the stock average, not above it.**
//     The modelled factor here was 1.35 on the reasoning that a resistive house
//     buys every kWh of heat it uses. Published: 74.0 against 93.3, a factor of
//     0.79. The stock average is dragged *up* by oil (176.7) and biomass
//     (167.9) houses, and electrically heated houses skew newer and better
//     insulated. The physical reasoning was sound and the baseline was wrong.
//
// Note on area basis: Energimyndigheten's kWh/m² uses heated area including
// biarea, which is the same basis the portal uses to estimate Atemp. The two
// are consistent with each other, and both differ from a surveyed Atemp. That
// caveat belongs in the UI, not in a fudge factor here.

export type ArchetypeProvenance = 'published' | 'interpolated' | 'modelled';

export type DwellingArchetype =
  | 'detached'
  | 'semi_detached'
  | 'terraced'
  | 'apartment';

export type HeatingArchetype =
  | 'resistive'
  | 'air_air_heat_pump'
  | 'air_water_heat_pump'
  | 'ground_source_heat_pump'
  | 'exhaust_air_heat_pump'
  | 'district_heating'
  | 'biomass'
  | 'unknown';

export interface ProvenancedValue {
  kwhPerM2: number;
  provenance: ArchetypeProvenance;
  source: string;
}

export interface BuildYearBand {
  key: string;
  /** Inclusive lower bound; null means open-ended. */
  minYear: number | null;
  /** Inclusive upper bound; null means open-ended. */
  maxYear: number | null;
  /** Delivered heating + hot water, excluding household electricity. */
  heatingAndHotWater: ProvenancedValue;
}

const T214 =
  'Energimyndigheten, Energistatistik för småhus 2024, table 2.14 (temperature-corrected)';
const T215 =
  'Energimyndigheten, Energistatistik för småhus 2024, table 2.15 (temperature-corrected)';

const band = (
  key: string,
  minYear: number | null,
  maxYear: number | null,
  kwhPerM2: number,
): BuildYearBand => ({
  key,
  minYear,
  maxYear,
  heatingAndHotWater: { kwhPerM2, provenance: 'published', source: T214 },
});

/**
 * Delivered heating + hot water by build year, kWh per m² heated area,
 * temperature-corrected to a normal year. Every row is published.
 *
 * Not monotonic: the 1980s and 1990s bands sit above 1971–1980. See the note
 * at the top of this file.
 */
export const BUILD_YEAR_BANDS: readonly BuildYearBand[] = [
  band('<=1940', null, 1940, 113.6),
  band('1941-1960', 1941, 1960, 93.9),
  band('1961-1970', 1961, 1970, 89.4),
  band('1971-1980', 1971, 1980, 81.1),
  band('1981-1990', 1981, 1990, 94.7),
  band('1991-2000', 1991, 2000, 98.4),
  band('2001-2010', 2001, 2010, 82.3),
  band('2011-2020', 2011, 2020, 55.5),
  band('2021-', 2021, null, 40.2),
];

/**
 * Published all-stock mean (SAMTLIGA, temperature-corrected), used when the
 * build year is unknown.
 *
 * Energimyndigheten publishes a separate "uppgift saknas" row at 108.8, i.e.
 * homes with no recorded build year use materially more than average — they
 * skew old. We deliberately do not use it: a missing answer in our
 * questionnaire is not the same population as a missing entry in the property
 * register, and assuming the worst about a prospect's house is not a neutral
 * default.
 */
export const ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2 = 93.3;

/**
 * BEN (BFS 2016:12 with BFS 2017:6) normalised hot-water use for småhus:
 * 20 kWh per m² Atemp divided by the production efficiency. Applied as-is for
 * electric production (efficiency 1.0).
 *
 * This is a *normalised* figure by design — it deliberately does not reflect
 * how much hot water a particular household uses, so that buildings are
 * comparable. It is also why it dominates the primary-energy number for a
 * large house: 20 kWh/m² over 424 m² is 8,480 kWh, far more than such a house
 * typically measures. That is BEN behaving as specified, not an error.
 */
export const BEN_HOT_WATER_KWH_M2 = 20;

/**
 * BEN normal-year household electricity for småhus, kWh per m² Atemp.
 * Excluded from the primary-energy number, but needed to split a whole-home
 * total into building energy and household electricity.
 */
export const BEN_HOUSEHOLD_ELECTRICITY_KWH_M2 = 30;

/**
 * Property energy (fastighetsenergi) for a småhus — circulation pumps, fans,
 * outdoor and common lighting. Small and rarely separately metered.
 * Modelled, not published: Phil's measured house annualises to ~2.8 kWh/m².
 */
export const PROPERTY_ENERGY_KWH_M2: ProvenancedValue = {
  kwhPerM2: 3,
  provenance: 'modelled',
  source: 'SHS assumption, consistent with ~2.8 kWh/m² measured at the reference home',
};

/**
 * Published kWh/m² by heating system, temperature-corrected (table 2.15),
 * against the SAMTLIGA average of 93.3. Used as a ratio, so the build-year and
 * heating-system marginals combine multiplicatively.
 *
 * That combination assumes the two are independent, which they are not exactly
 * — newer houses are more likely to have heat pumps, so some of the effect is
 * counted in both marginals. It is a standard marginal-adjustment assumption
 * and it is stated here rather than hidden. The published joint tables (2.18
 * to 2.20) cover only bergvärme and the two electric categories, and are
 * "inklusive hushållsel", so they are not a drop-in replacement.
 */
const SYSTEM_KWH_M2: Record<string, number> = {
  el_direct: 74.0, // Enbart elvärme (d)
  el_hydronic: 64.8, // Enbart elvärme (v)
  ground_source: 50.2, // Enbart berg/jord/sjövärmepump
  district: 122.4, // Enbart fjärrvärme
  biomass: 167.9, // Enbart biobränsle
};

const systemFactor = (kwhM2: number): number =>
  kwhM2 / ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2;

/**
 * Delivered-energy multiplier by heating system, relative to the whole småhus
 * stock. Applies to the *heating* term only — hot water is normalised
 * separately by BEN.
 *
 * Air-air and exhaust-air heat pumps are not separate categories in table 2.15:
 * they are electric heating and sit inside the "enbart elvärme" rows, which
 * therefore already blend homes with and without them. Assigning them the
 * electric figure is our decision, not a published one, so those entries are
 * marked `modelled` even though the number underneath is published.
 */
export const HEATING_SYSTEM_FACTORS: Readonly<Record<HeatingArchetype, ProvenancedValue>> = {
  resistive: {
    kwhPerM2: systemFactor(SYSTEM_KWH_M2.el_direct),
    provenance: 'published',
    source: `${T215}: enbart elvärme (d) 74.0 vs 93.3`,
  },
  air_air_heat_pump: {
    kwhPerM2: systemFactor(SYSTEM_KWH_M2.el_direct),
    provenance: 'modelled',
    source: `${T215}: not a separate category; assigned enbart elvärme (d), which already includes homes with air-air pumps`,
  },
  exhaust_air_heat_pump: {
    kwhPerM2: systemFactor(SYSTEM_KWH_M2.el_hydronic),
    provenance: 'modelled',
    source: `${T215}: not a separate category; assigned enbart elvärme (v)`,
  },
  air_water_heat_pump: {
    kwhPerM2: (systemFactor(SYSTEM_KWH_M2.el_hydronic) + systemFactor(SYSTEM_KWH_M2.ground_source)) / 2,
    provenance: 'modelled',
    source: `${T215}: not a separate category; midpoint of enbart elvärme (v) and berg/jord/sjövärmepump`,
  },
  ground_source_heat_pump: {
    kwhPerM2: systemFactor(SYSTEM_KWH_M2.ground_source),
    provenance: 'published',
    source: `${T215}: enbart berg/jord/sjövärmepump 50.2 vs 93.3`,
  },
  district_heating: {
    kwhPerM2: systemFactor(SYSTEM_KWH_M2.district),
    provenance: 'published',
    source: `${T215}: enbart fjärrvärme 122.4 vs 93.3`,
  },
  biomass: {
    kwhPerM2: systemFactor(SYSTEM_KWH_M2.biomass),
    provenance: 'published',
    source: `${T215}: enbart biobränsle 167.9 vs 93.3`,
  },
  unknown: {
    kwhPerM2: 1,
    provenance: 'published',
    source: `${T215}: SAMTLIGA, no system information`,
  },
};

/**
 * Dwelling-form multiplier. Attached forms lose less through the envelope per
 * m² than a freestanding house. Modelled, not published.
 */
export const DWELLING_FACTORS: Readonly<Record<DwellingArchetype, number>> = {
  detached: 1.0,
  semi_detached: 0.9,
  terraced: 0.82,
  apartment: 0.7,
};

/**
 * BBR 31 (BFS 2024:14) geographic adjustment factor, applied to the heating
 * term of the primary-energy number so the same building scores the same
 * anywhere in Sweden.
 *
 * The per-municipality table is BBR 31 Table 9:2c and is NOT reproduced here —
 * inventing values would be worse than admitting we do not have it. Callers
 * pass a known factor or `null`; `null` means "assume 1.0 and say so in the
 * UI", which is correct for Stockholm County and wrong further north.
 */
export const DEFAULT_GEOGRAPHIC_ADJUSTMENT_FACTOR = 1.0;

export interface ArchetypeInput {
  yearBuilt: number | null;
  dwelling: DwellingArchetype | null;
  heating: HeatingArchetype | null;
  heatedAreaM2: number;
}

export interface ArchetypePrior {
  /** Expected delivered energy per BEN category, kWh/year. */
  heatingKwh: number;
  hotWaterKwh: number;
  propertyEnergyKwh: number;
  /** Excluded from the primary-energy number, but part of a whole-home total. */
  householdElectricityKwh: number;
  /** Everything the primary-energy number counts. */
  buildingEnergyKwh: number;
  /** Building energy plus household electricity. */
  wholeHomeKwh: number;
  band: BuildYearBand | null;
  /** Weakest provenance among the inputs that materially shaped the result. */
  provenance: ArchetypeProvenance;
  /** Human-readable list of what the number rests on. */
  basis: string[];
}

export function bandForYear(yearBuilt: number | null): BuildYearBand | null {
  if (yearBuilt === null || !Number.isFinite(yearBuilt)) return null;
  return (
    BUILD_YEAR_BANDS.find(
      (band) =>
        (band.minYear === null || yearBuilt >= band.minYear)
        && (band.maxYear === null || yearBuilt <= band.maxYear),
    ) ?? null
  );
}

const PROVENANCE_RANK: Record<ArchetypeProvenance, number> = {
  published: 0,
  interpolated: 1,
  modelled: 2,
};

function weakest(...values: ArchetypeProvenance[]): ArchetypeProvenance {
  return values.reduce((worst, value) =>
    PROVENANCE_RANK[value] > PROVENANCE_RANK[worst] ? value : worst,
  );
}

/**
 * Expected annual energy for a home we have no measurements for.
 *
 * Deliberately returns the *whole* breakdown rather than one number, because
 * both callers need different parts of it: the energy-performance page needs
 * the BEN categories, and the disaggregation of a measured whole-home total
 * needs the ratios between them.
 */
export function archetypePrior(input: ArchetypeInput): ArchetypePrior {
  const { heatedAreaM2 } = input;
  if (!Number.isFinite(heatedAreaM2) || heatedAreaM2 <= 0) {
    throw new Error('Heated area must be a positive number of square metres.');
  }

  const band = bandForYear(input.yearBuilt);
  const basis: string[] = [];

  const baseKwhM2 = band
    ? band.heatingAndHotWater.kwhPerM2
    : ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2;
  basis.push(
    band
      ? `Build year ${band.key}: ${baseKwhM2} kWh/m² heating + hot water (${band.heatingAndHotWater.provenance})`
      : `Build year unknown: all-stock average ${baseKwhM2} kWh/m² (published)`,
  );

  // Hot water is normalised by BEN and is not a function of the envelope, so
  // it is held constant and only the heating remainder is scaled.
  const hotWaterKwhM2 = BEN_HOT_WATER_KWH_M2;
  const baseHeatingKwhM2 = Math.max(0, baseKwhM2 - hotWaterKwhM2);

  const heating = input.heating ?? 'unknown';
  const heatingFactor = HEATING_SYSTEM_FACTORS[heating];
  const dwelling = input.dwelling ?? 'detached';
  const dwellingFactor = DWELLING_FACTORS[dwelling];

  basis.push(`Heating system ${heating}: ×${heatingFactor.kwhPerM2} (${heatingFactor.provenance})`);
  basis.push(`Dwelling form ${dwelling}: ×${dwellingFactor} (modelled)`);
  basis.push(`Hot water: BEN standard ${hotWaterKwhM2} kWh/m² (published)`);

  const heatingKwh = baseHeatingKwhM2 * heatingFactor.kwhPerM2 * dwellingFactor * heatedAreaM2;
  const hotWaterKwh = hotWaterKwhM2 * heatedAreaM2;
  const propertyEnergyKwh = PROPERTY_ENERGY_KWH_M2.kwhPerM2 * heatedAreaM2;
  const householdElectricityKwh = BEN_HOUSEHOLD_ELECTRICITY_KWH_M2 * heatedAreaM2;
  const buildingEnergyKwh = heatingKwh + hotWaterKwh + propertyEnergyKwh;

  return {
    heatingKwh,
    hotWaterKwh,
    propertyEnergyKwh,
    householdElectricityKwh,
    buildingEnergyKwh,
    wholeHomeKwh: buildingEnergyKwh + householdElectricityKwh,
    band,
    provenance: weakest(
      band ? band.heatingAndHotWater.provenance : 'published',
      heatingFactor.provenance,
      PROPERTY_ENERGY_KWH_M2.provenance,
    ),
    basis,
  };
}

/**
 * Split a measured whole-home total into BEN categories using the archetype as
 * the shape and the measurement as the scale.
 *
 * This is the common customer case: one total, no category breakdown. The
 * archetype supplies the *proportions*; the customer's own total supplies the
 * magnitude. Household electricity is held at the BEN standard rather than
 * scaled, because it is the part the primary-energy number excludes and
 * scaling it would let a big EV or a hot tub inflate the building's rating.
 */
export function disaggregateWholeHome(
  measuredWholeHomeKwh: number,
  input: ArchetypeInput,
): ArchetypePrior {
  const prior = archetypePrior(input);
  if (!Number.isFinite(measuredWholeHomeKwh) || measuredWholeHomeKwh <= 0) {
    return prior;
  }

  const householdElectricityKwh = Math.min(
    prior.householdElectricityKwh,
    measuredWholeHomeKwh,
  );
  const measuredBuildingKwh = Math.max(0, measuredWholeHomeKwh - householdElectricityKwh);
  const priorBuilding = prior.buildingEnergyKwh;
  const scale = priorBuilding > 0 ? measuredBuildingKwh / priorBuilding : 0;

  return {
    ...prior,
    heatingKwh: prior.heatingKwh * scale,
    hotWaterKwh: prior.hotWaterKwh * scale,
    propertyEnergyKwh: prior.propertyEnergyKwh * scale,
    householdElectricityKwh,
    buildingEnergyKwh: measuredBuildingKwh,
    wholeHomeKwh: measuredWholeHomeKwh,
    basis: [
      ...prior.basis,
      `Scaled to a measured whole-home total of ${Math.round(measuredWholeHomeKwh)} kWh (×${scale.toFixed(2)})`,
      `Household electricity held at the BEN standard ${BEN_HOUSEHOLD_ELECTRICITY_KWH_M2} kWh/m²`,
    ],
  };
}

/** Map free-text questionnaire answers onto the archetype enums. */
export function normalizeDwelling(answer: unknown): DwellingArchetype | null {
  const text = String(answer ?? '').toLowerCase();
  if (!text) return null;
  if (/lägenhet|apartment|flat/.test(text)) return 'apartment';
  if (/radhus|terrace/.test(text)) return 'terraced';
  if (/parhus|kedjehus|semi|link/.test(text)) return 'semi_detached';
  if (/villa|fristående|detached|enfamilj|småhus/.test(text)) return 'detached';
  return null;
}

export function normalizeHeating(answer: unknown): HeatingArchetype | null {
  const values = Array.isArray(answer) ? answer : [answer];
  const text = values.map((value) => String(value ?? '').toLowerCase()).join(' ');
  if (!text.trim()) return null;
  // Most efficient present system wins: a house with both direct electric and a
  // ground-source pump is heated by the pump.
  if (/berg|jord|mark|sjö|ground|geo/.test(text)) return 'ground_source_heat_pump';
  if (/luft[-/ ]?vatten|air[-/ ]?water/.test(text)) return 'air_water_heat_pump';
  if (/frånluft|exhaust/.test(text)) return 'exhaust_air_heat_pump';
  if (/luft[-/ ]?luft|air[-/ ]?air|luftvärmepump/.test(text)) return 'air_air_heat_pump';
  if (/fjärrvärme|district/.test(text)) return 'district_heating';
  if (/ved|pellets|biobränsle|biomass|wood/.test(text)) return 'biomass';
  if (/direktverkande|elradiator|vattenburen el|resistive|electric/.test(text)) return 'resistive';
  return null;
}
