export const SUPPLIER_PRICE_SCHEMA_VERSION = 1;

export interface SpotPriceInterval {
  SEK_per_kWh: number;
  time_start: string;
  time_end: string;
}

export interface SupplierDefinitionV1 {
  schema_version: 1;
  vat_rate: number;
  import: {
    spot_multiplier: number;
    fixed_markup_sek_per_kwh_ex_vat: number;
    variable_cost_sek_per_kwh_ex_vat: number;
  };
  export: {
    spot_multiplier: number;
    adjustment_sek_per_kwh: number;
  };
  monthly_fee_sek_in_vat: number;
}

export interface SupplierPriceInterval {
  start: string;
  end: string;
  spot_price_sek_per_kwh: number;
  supplier_import_price_sek_per_kwh: number;
  supplier_export_price_sek_per_kwh: number;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const round = (value: number, decimals = 6) => {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

export function validateSupplierDefinition(
  value: unknown,
): asserts value is SupplierDefinitionV1 {
  const definition = value as SupplierDefinitionV1;
  if (
    !definition || definition.schema_version !== 1 ||
    !finite(definition.vat_rate) || definition.vat_rate < 0 ||
    !finite(definition.import?.spot_multiplier) ||
    !finite(definition.import?.fixed_markup_sek_per_kwh_ex_vat) ||
    !finite(definition.import?.variable_cost_sek_per_kwh_ex_vat) ||
    !finite(definition.export?.spot_multiplier) ||
    !finite(definition.export?.adjustment_sek_per_kwh) ||
    !finite(definition.monthly_fee_sek_in_vat)
  ) {
    throw new Error("invalid supplier definition");
  }
}

export function parseSpotPriceIntervals(value: unknown): SpotPriceInterval[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("spot source returned no intervals");
  }
  const intervals = value.map((row, index) => {
    const interval = row as SpotPriceInterval;
    const start = Date.parse(interval?.time_start);
    const end = Date.parse(interval?.time_end);
    if (
      !finite(interval?.SEK_per_kWh) || !Number.isFinite(start) ||
      !Number.isFinite(end) || end <= start || end - start !== 15 * 60_000
    ) {
      throw new Error(`invalid spot interval at index ${index}`);
    }
    return interval;
  });
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index - 1].time_end !== intervals[index].time_start) {
      throw new Error(`spot intervals are not contiguous at index ${index}`);
    }
  }
  return intervals;
}

export function calculateSupplierPrice(
  interval: SpotPriceInterval,
  definitionValue: unknown,
): SupplierPriceInterval {
  validateSupplierDefinition(definitionValue);
  const definition = definitionValue;
  const importExVat = interval.SEK_per_kWh * definition.import.spot_multiplier +
    definition.import.fixed_markup_sek_per_kwh_ex_vat +
    definition.import.variable_cost_sek_per_kwh_ex_vat;
  return {
    start: interval.time_start,
    end: interval.time_end,
    spot_price_sek_per_kwh: round(interval.SEK_per_kWh),
    supplier_import_price_sek_per_kwh: round(
      importExVat * (1 + definition.vat_rate),
    ),
    supplier_export_price_sek_per_kwh: round(
      interval.SEK_per_kWh * definition.export.spot_multiplier +
        definition.export.adjustment_sek_per_kwh,
    ),
  };
}
