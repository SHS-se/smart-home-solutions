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
// PRIMARY SOURCE — Energimyndigheten, "Energistatistik för småhus 2024"
// (published 2025-06-10). Averages for *heating and hot water only*, excluding
// household electricity, and excluding heat absorbed from the ground/air by
// heat pumps. That basis is exactly the delivered ("köpt") energy the BBR
// primary-energy number is built from, which is why it is usable here.
//   - all småhus:            90.5 kWh/m²
//   - built 1940 or earlier: 110  kWh/m²
//   - built 2011 or later:    53.4 kWh/m²
//   - built 2021 or later:    39  kWh/m²
// https://www.energimyndigheten.se/nyhetsarkiv/2025/ny-energistatistik-for-smahus/
//
// The intermediate bands below are interpolated monotonically between those
// anchors and constrained so that the stock-weighted mean reproduces the
// published 90.5 and the published 53.4 for 2011+. The full official table
// (`smh_2024_tabellverk_v2.xlsx`, linked from the statistics page) breaks this
// down further by build year and heating system; replacing the interpolated
// rows with it is a known follow-up and the only change needed here.
//
// Note on area basis: Energimyndigheten's kWh/m² uses heated area, which is
// the same boarea + biarea basis the portal uses to estimate Atemp. The two
// are therefore consistent with each other, and both differ from a surveyed
// Atemp. That caveat belongs in the UI, not in a fudge factor here.

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

const ENERGIMYNDIGHETEN_2024 =
  'Energimyndigheten, Energistatistik för småhus 2024 (2025-06-10)';
const INTERPOLATED =
  'Interpolated between Energimyndigheten 2024 anchors; stock-weighted mean reproduces the published 90.5 kWh/m²';

/**
 * Delivered heating + hot water by build year, kWh per m² heated area.
 * Monotonically decreasing, as the published series is.
 */
export const BUILD_YEAR_BANDS: readonly BuildYearBand[] = [
  {
    key: '<=1940',
    minYear: null,
    maxYear: 1940,
    heatingAndHotWater: { kwhPerM2: 110, provenance: 'published', source: ENERGIMYNDIGHETEN_2024 },
  },
  {
    key: '1941-1960',
    minYear: 1941,
    maxYear: 1960,
    heatingAndHotWater: { kwhPerM2: 105, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '1961-1970',
    minYear: 1961,
    maxYear: 1970,
    heatingAndHotWater: { kwhPerM2: 99, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '1971-1980',
    minYear: 1971,
    maxYear: 1980,
    heatingAndHotWater: { kwhPerM2: 92, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '1981-1990',
    minYear: 1981,
    maxYear: 1990,
    heatingAndHotWater: { kwhPerM2: 82, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '1991-2000',
    minYear: 1991,
    maxYear: 2000,
    heatingAndHotWater: { kwhPerM2: 72, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '2001-2010',
    minYear: 2001,
    maxYear: 2010,
    heatingAndHotWater: { kwhPerM2: 62, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '2011-2020',
    minYear: 2011,
    maxYear: 2020,
    heatingAndHotWater: { kwhPerM2: 58.2, provenance: 'interpolated', source: INTERPOLATED },
  },
  {
    key: '2021-',
    minYear: 2021,
    maxYear: null,
    heatingAndHotWater: { kwhPerM2: 39, provenance: 'published', source: ENERGIMYNDIGHETEN_2024 },
  },
];

/** Published all-stock mean, used as the fallback when build year is unknown. */
export const ALL_STOCK_HEATING_AND_HOT_WATER_KWH_M2 = 90.5;

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
 * Delivered-energy multiplier by heating system, relative to the mixed stock
 * the published averages describe.
 *
 * Modelled, not published. The published averages are a blend of resistive,
 * heat-pump, biomass and district-heated homes, so a home with a known system
 * should not sit on the blended average. These factors are seasonal-performance
 * ratios: a resistive house buys every kWh of heat it uses, a ground-source
 * heat pump buys roughly a third of it. They apply to the *heating* term only —
 * hot water is normalised separately by BEN.
 *
 * Replace with the per-system rows of the official tabellverk when parsed.
 */
export const HEATING_SYSTEM_FACTORS: Readonly<Record<HeatingArchetype, ProvenancedValue>> = {
  resistive: { kwhPerM2: 1.35, provenance: 'modelled', source: 'SPF 1.0 against a stock blend that includes heat pumps' },
  air_air_heat_pump: { kwhPerM2: 0.75, provenance: 'modelled', source: 'Seasonal COP ~2.5 over the heated fraction of the house' },
  exhaust_air_heat_pump: { kwhPerM2: 0.8, provenance: 'modelled', source: 'Seasonal COP ~2.3, limited capacity' },
  air_water_heat_pump: { kwhPerM2: 0.6, provenance: 'modelled', source: 'Seasonal COP ~2.9, whole-house hydronic' },
  ground_source_heat_pump: { kwhPerM2: 0.5, provenance: 'modelled', source: 'Seasonal COP ~3.3, whole-house hydronic' },
  district_heating: { kwhPerM2: 1.0, provenance: 'modelled', source: 'Delivered heat, close to the stock blend' },
  biomass: { kwhPerM2: 1.1, provenance: 'modelled', source: 'Boiler/stove losses above the stock blend' },
  unknown: { kwhPerM2: 1.0, provenance: 'modelled', source: 'Stock blend, no system information' },
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
