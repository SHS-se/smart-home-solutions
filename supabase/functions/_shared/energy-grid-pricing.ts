// Marginal grid price per quarter: transfer + energy tax, plus VAT.
//
// A deliberate second implementation of `current_grid_prices` from the
// integration's tariff.py, ported so the portal can price history without Home
// Assistant (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.6). Two implementations
// of a price is a real risk and the reason this was avoided at first, so the
// mitigation is structural: `energy-grid-pricing.test.ts` runs a catalogue
// fixture through this module and asserts values captured from the Python, and
// the integration's own tests assert the same fixture. A divergence fails a
// build rather than quietly mispricing a customer's history.
//
// Only the *marginal* per-kWh path is ported. Monthly invoicing — fixed fees,
// demand charges, component breakdowns — stays in the integration alone,
// because nothing here needs it.

export const GRID_CALCULATION_MODEL = "se_grid_v1";
export const EXPORT_SCHEDULE = "swedish_winter_weekday_06_22_v1";

export class GridTariffError extends Error {}

export interface GridPriceConfiguration {
  profile_id: string;
  connection_type: "three_phase" | "single_phase" | "apartment";
  fuse_a?: number | null;
  apartment_band?: string | null;
  grid_area?: string | null;
  production_enabled?: boolean | null;
  energy_tax_reduced?: boolean | null;
  include_vat?: boolean | null;
  export_vat_registered?: boolean | null;
}

export interface GridTariffCatalogue {
  timezone?: string;
  configuration: GridPriceConfiguration | null;
  missing_inputs?: string[];
  profiles: Array<{
    id: string;
    versions: Array<{
      revision: string;
      valid_from: string;
      valid_to: string | null;
      calculation_model: string;
      definition: Record<string, unknown>;
    }>;
  }>;
}

export interface GridPrices {
  import_price_sek_per_kwh: number;
  export_price_sek_per_kwh: number;
  load_period: "high" | "low" | null;
  tariff_revision: string;
}

const asDict = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GridTariffError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GridTariffError(`${label} must be a number`);
  }
  return value;
};

const round = (value: number, decimals: number) => {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

/** Anonymous Gregorian algorithm, matching `_easter_sunday` in tariff.py. */
export const easterSunday = (year: number): { month: number; day: number } => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const ell = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * ell) / 451);
  const month = Math.floor((h + ell - 7 * m + 114) / 31);
  const day = ((h + ell - 7 * m + 114) % 31) + 1;
  return { month, day };
};

const dayKey = (year: number, month: number, day: number) =>
  year * 10_000 + month * 100 + day;

const shiftDay = (year: number, month: number, day: number, delta: number) => {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return dayKey(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
};

/** Swedish public holidays that suspend the high-load band. */
const excludedHighLoadDates = (year: number): Set<number> => {
  const easter = easterSunday(year);
  return new Set([
    dayKey(year, 1, 1),
    dayKey(year, 1, 6),
    shiftDay(year, easter.month, easter.day, -3), // Maundy Thursday
    shiftDay(year, easter.month, easter.day, -2), // Good Friday
    shiftDay(year, easter.month, easter.day, 1), // Easter Monday
    dayKey(year, 12, 24),
    dayKey(year, 12, 25),
    dayKey(year, 12, 26),
    dayKey(year, 12, 31),
  ]);
};

/** Local wall-clock parts of an instant in the tariff's timezone. */
export interface LocalMoment {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number; // 0 = Monday, matching Python's date.weekday()
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export const localMoment = (when: Date, timeZone: string): LocalMoment => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(when);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[value("weekday")];
  if (weekday === undefined) {
    throw new GridTariffError(`unsupported tariff timezone ${timeZone}`);
  }
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    // Intl renders midnight as 24 in some locales; normalise to 0.
    hour: Number(value("hour")) % 24,
    weekday,
  };
};

export const isHighLoadHour = (local: LocalMoment, schedule: unknown) => {
  if (schedule !== EXPORT_SCHEDULE) {
    throw new GridTariffError(`unsupported export schedule ${String(schedule)}`);
  }
  return [11, 12, 1, 2, 3].includes(local.month) &&
    local.weekday < 5 &&
    local.hour >= 6 && local.hour < 22 &&
    !excludedHighLoadDates(local.year).has(
      dayKey(local.year, local.month, local.day),
    );
};

interface ResolvedTariff {
  revision: string;
  definition: Record<string, unknown>;
}

/**
 * The single version covering a local date, or null outside the catalogue.
 *
 * Mirrors `_TariffCatalog.resolve_optional`: more than one active version is an
 * error rather than a choice, because two overlapping rates mean the catalogue
 * is wrong and picking one would hide it.
 */
export const resolveTariff = (
  catalogue: GridTariffCatalogue,
  localDate: string,
): ResolvedTariff | null => {
  const configuration = catalogue.configuration;
  if (configuration === null) {
    throw new GridTariffError(
      `customer tariff inputs missing: ${(catalogue.missing_inputs ?? []).join(", ")}`,
    );
  }
  const profile = catalogue.profiles.find(
    (candidate) => candidate.id === configuration.profile_id,
  );
  if (!profile) {
    throw new GridTariffError(
      `configured tariff profile ${configuration.profile_id} is missing`,
    );
  }
  const active = profile.versions.filter((version) =>
    version.valid_from <= localDate &&
    (version.valid_to === null || version.valid_to >= localDate)
  );
  if (active.length === 0) return null;
  if (active.length > 1) {
    throw new GridTariffError(
      `expected one tariff rate version on ${localDate}, found ${active.length}`,
    );
  }
  const version = active[0];
  if (version.calculation_model !== GRID_CALCULATION_MODEL) {
    throw new GridTariffError(
      `unsupported calculation model ${version.calculation_model}`,
    );
  }
  const definition = asDict(version.definition, "tariff definition");
  if (definition.schema_version !== 1) {
    throw new GridTariffError(
      `unsupported definition schema ${String(definition.schema_version)}`,
    );
  }
  return { revision: version.revision, definition };
};

const planFor = (
  definition: Record<string, unknown>,
  configuration: GridPriceConfiguration,
): { plan: Record<string, unknown>; selectorValue: string } => {
  const connectionType = configuration.connection_type;
  if (!["three_phase", "single_phase", "apartment"].includes(connectionType)) {
    throw new GridTariffError(`unsupported connection type ${connectionType}`);
  }
  const plans = asDict(definition.plans, "plans");
  const plan = asDict(plans[connectionType], `plan ${connectionType}`);
  const selector = plan.selector;
  if (selector !== "fuse_a" && selector !== "apartment_band") {
    throw new GridTariffError(`unsupported plan selector ${String(selector)}`);
  }
  const raw = configuration[selector as "fuse_a" | "apartment_band"];
  if (
    raw === null || raw === undefined || typeof raw === "boolean" ||
    (typeof raw !== "string" && typeof raw !== "number")
  ) {
    throw new GridTariffError(`tariff selector ${selector} is missing`);
  }
  return { plan, selectorValue: String(raw) };
};

const transferRate = (
  plan: Record<string, unknown>,
  selectorValue: string,
): number => {
  const transfer = asDict(plan.transfer, "transfer rule");
  const mode = transfer.mode;
  if (mode === "flat") {
    return asNumber(transfer.ore_per_kwh_ex_vat, "transfer rate") / 100;
  }
  if (mode === "flat_by_selector") {
    const rates = asDict(transfer.ore_per_kwh_ex_vat, "selector transfer rates");
    if (!(selectorValue in rates)) {
      throw new GridTariffError(
        `transfer rate missing for selector ${selectorValue}`,
      );
    }
    return asNumber(rates[selectorValue], "selector transfer rate") / 100;
  }
  throw new GridTariffError(`unsupported transfer mode ${String(mode)}`);
};

const energyTaxRate = (
  definition: Record<string, unknown>,
  configuration: GridPriceConfiguration,
): number => {
  const energyTax = asDict(definition.energy_tax, "energy tax");
  let ore = asNumber(energyTax.ore_per_kwh_ex_vat, "energy tax rate");
  const reduced = configuration.energy_tax_reduced;
  if (reduced === true) {
    ore -= asNumber(
      energyTax.reduction_ore_per_kwh,
      "energy tax reduction",
    );
  } else if (reduced !== false) {
    throw new GridTariffError("energy_tax_reduced must be boolean");
  }
  return Math.max(0, ore / 100);
};

/**
 * Marginal grid prices for one instant, or null outside the catalogue.
 *
 * Port of `current_grid_prices`. Export credit is zero unless the home is
 * flagged as producing, and micro-production sits outside VAT unless the
 * customer registered for it.
 */
export function currentGridPrices(
  catalogue: GridTariffCatalogue,
  when: Date,
): GridPrices | null {
  const timeZone = catalogue.timezone ?? "Europe/Stockholm";
  const local = localMoment(when, timeZone);
  const localDate = `${local.year}-${String(local.month).padStart(2, "0")}-${
    String(local.day).padStart(2, "0")
  }`;
  const resolved = resolveTariff(catalogue, localDate);
  if (resolved === null) return null;
  const configuration = catalogue.configuration as GridPriceConfiguration;

  const { plan, selectorValue } = planFor(resolved.definition, configuration);
  const transfer = transferRate(plan, selectorValue);
  const tax = energyTaxRate(resolved.definition, configuration);

  const includeVat = configuration.include_vat;
  if (typeof includeVat !== "boolean") {
    throw new GridTariffError("include_vat must be boolean");
  }
  const vatRate = includeVat
    ? asNumber(resolved.definition.vat_rate, "VAT rate")
    : 0;

  const importExVat = transfer + tax;
  const importPrice = importExVat * (1 + vatRate);

  let exportPrice = 0;
  let band: "high" | "low" | null = null;
  if (configuration.production_enabled === true) {
    const exportRule = asDict(resolved.definition.export_credit, "export credit");
    const areaRates = asDict(
      exportRule.ore_per_kwh_ex_vat_by_area,
      "export area rates",
    );
    const area = configuration.grid_area ?? "";
    const rates = asDict(areaRates[area], `export rates for ${area}`);
    band = isHighLoadHour(local, exportRule.schedule) ? "high" : "low";
    const exportExVat = asNumber(rates[band], `export ${band} rate`) / 100;
    const exportVatRegistered = configuration.export_vat_registered;
    if (typeof exportVatRegistered !== "boolean") {
      throw new GridTariffError("export_vat_registered must be boolean");
    }
    exportPrice = exportExVat * (exportVatRegistered ? 1 + vatRate : 1);
  }

  return {
    import_price_sek_per_kwh: round(importPrice, 5),
    export_price_sek_per_kwh: round(exportPrice, 5),
    load_period: band,
    tariff_revision: resolved.revision,
  };
}
