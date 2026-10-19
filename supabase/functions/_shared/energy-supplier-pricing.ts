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

const QUARTER_MS = 15 * 60_000;
const HOUR_MS = 4 * QUARTER_MS;
// Nord Pool moved the day-ahead market to quarter-hour quotes on 2025-10-01;
// before that the feed publishes one quote per hour (00:00 Europe/Stockholm).
const QUARTER_MARKET_FROM = Date.parse("2025-10-01T00:00:00+02:00");

/** Render an instant on the same UTC offset as the feed label it came from. */
const atOffsetOf = (label: string, instant: number) => {
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(label)?.[1];
  if (!offset) throw new Error(`spot time has no UTC offset: ${label}`);
  const minutes = offset === "Z" ? 0 : (offset[0] === "-" ? -1 : 1) *
    (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return new Date(instant + minutes * 60_000).toISOString().slice(0, 19) +
    offset;
};

export function parseSpotPriceIntervals(value: unknown): SpotPriceInterval[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("spot source returned no intervals");
  }
  const intervals = value.flatMap((row, index) => {
    const interval = row as SpotPriceInterval;
    const start = Date.parse(interval?.time_start);
    // The feed publishes one quote per quarter. Adjacent quote starts own the
    // boundary: local-clock end labels can be wrong over the repeated DST hour
    // (2025-10-26 SE3 labels 02:45 +02:00 -> 03:00 +01:00).
    const next = value[index + 1] as SpotPriceInterval | undefined;
    const boundary = next?.time_start ?? interval?.time_end;
    const end = Date.parse(boundary);
    const hourly = end - start === HOUR_MS && start < QUARTER_MARKET_FROM;
    if (
      !finite(interval?.SEK_per_kWh) || !Number.isFinite(start) ||
      !Number.isFinite(end) || end <= start ||
      (end - start !== QUARTER_MS && !hourly)
    ) {
      throw new Error(`invalid spot interval at index ${index}`);
    }
    if (!hourly) return [{ ...interval, time_end: boundary }];
    // An hourly quote held for each of its quarters, so history before the
    // market change prices on the same quarter grid as everything after it.
    return [0, 1, 2, 3].map((quarter) => ({
      ...interval,
      time_start: quarter === 0
        ? interval.time_start
        : atOffsetOf(interval.time_start, start + quarter * QUARTER_MS),
      time_end: quarter === 3
        ? boundary
        : atOffsetOf(interval.time_start, start + (quarter + 1) * QUARTER_MS),
    }));
  });
  for (let index = 1; index < intervals.length; index += 1) {
    if (Date.parse(intervals[index - 1].time_end) !== Date.parse(intervals[index].time_start)) {
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
