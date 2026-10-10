/** Published server forecasts. Admission only aligns this product; it never fits or fetches. */
import { z } from "zod";
import type {
  OptimisationPlan,
  OptimisationSnapshot,
} from "./planner/energy-optimisation.ts";

export const PREPARED_FORECAST_TABLE = "energy_prepared_forecasts";
const finite = z.number().finite();
const timestamp = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Invalid timestamp",
);
const zone = z.object({
  key: z.string(),
  name: z.string(),
  device_keys: z.string().array(),
  model: z.object({
    gain_c_per_wh: finite,
    cooling_constant_per_h: finite,
    background_gain_c_per_h: finite,
    solar_gain_c_per_h_per_wm2: finite.nullable().optional(),
    solar_mean_w_per_m2: finite.nullable().optional(),
    thermal_capacity_wh_per_c: finite,
    heat_loss_w_per_c: finite,
    time_constant_h: finite,
    heating_rate_c_per_h: finite.nullable(),
    r2: finite,
    sample_count: finite,
    residual_std_c: finite,
  }),
  start_temperature_c: finite,
  rated_power_w: finite,
  comfort_min_c: finite.array(),
  target_c: finite.array(),
  comfort_max_c: finite.array(),
  maximum_power_w_by_slot: finite.array(),
  unplanned_power_w: finite.array(),
});
const forecastSchema = z.object({
  slot_starts: timestamp.array().nonempty(),
  price_outlook: z.object({
    level_basis: z.enum(["wind", "recent_norm", "published"]).optional(),
    shaped: z.boolean(),
    observed_days: finite,
    effective_days: finite,
    level_sek_per_kwh: finite.nullable(),
    shadow_import_sek_per_kwh: finite.array(),
  }),
  outdoor_temperature_c: finite.nullable().array().nullable(),
  solar_irradiance_w_per_m2: finite.nullable().array().nullable(),
  thermal_zones: zone.array(),
});
export type PreparedEnergyForecast = z.infer<typeof forecastSchema>;
interface StoredForecast {
  home_id: string;
  issued_at: string;
  forecast: PreparedEnergyForecast;
}
interface DatabaseError {
  message: string;
}
/** Minimal service-store capability, also implemented by the Supabase client. */
export interface PreparedForecastDatabase {
  from(table: typeof PREPARED_FORECAST_TABLE): {
    select(columns: "issued_at,forecast"): {
      eq(column: "home_id", value: string): {
        maybeSingle(): PromiseLike<
          { data: unknown; error: DatabaseError | null }
        >;
      };
    };
    upsert(
      row: StoredForecast,
      options: { onConflict: "home_id" },
    ): PromiseLike<{ error: DatabaseError | null }>;
  };
}
export class PreparedForecastError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = "PreparedForecastError";
  }
}
function invalid(detail: string): never {
  throw new PreparedForecastError("prepared_forecast_invalid", detail);
}
const ZONE_SERIES = [
  "comfort_min_c",
  "target_c",
  "comfort_max_c",
  "maximum_power_w_by_slot",
  "unplanned_power_w",
] as const;

function parseForecast(raw: unknown): PreparedEnergyForecast {
  const parsed = forecastSchema.safeParse(raw);
  if (!parsed.success) {
    invalid(
      `Prepared forecast has malformed fields: ${
        parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")
      }`,
    );
  }
  const forecast = parsed.data;
  const count = forecast.slot_starts.length;
  if (new Set(forecast.slot_starts.map(Date.parse)).size !== count) {
    invalid("Prepared forecast contains duplicate slot timestamps");
  }
  const coverage = (values: readonly unknown[] | null, name: string) => {
    if (values !== null && values.length !== count) {
      invalid(`Prepared ${name} does not cover its published slots`);
    }
  };
  coverage(forecast.price_outlook.shadow_import_sek_per_kwh, "prices");
  coverage(forecast.outdoor_temperature_c, "outdoor temperature");
  coverage(forecast.solar_irradiance_w_per_m2, "irradiance");
  for (const zone of forecast.thermal_zones) {
    for (const field of ZONE_SERIES) {
      coverage(zone[field], `zone ${zone.key}.${field}`);
    }
  }
  return forecast;
}

/** The producer publishes one complete product after independent forecast preparation. */
export async function storePreparedForecasts(
  db: PreparedForecastDatabase,
  homeId: string,
  preparedSnapshot: OptimisationSnapshot,
  resolvedOutlook: OptimisationPlan["price_outlook"],
): Promise<void> {
  const forecast = parseForecast({
    slot_starts: preparedSnapshot.slots.map((slot) => slot.start),
    price_outlook: resolvedOutlook,
    outdoor_temperature_c: preparedSnapshot.outdoor_temperature_c ?? null,
    solar_irradiance_w_per_m2: preparedSnapshot.solar_irradiance_w_per_m2 ??
      null,
    thermal_zones: preparedSnapshot.thermal_zones ?? [],
  });
  const { error } = await db.from(PREPARED_FORECAST_TABLE).upsert({
    home_id: homeId,
    issued_at: new Date().toISOString(),
    forecast,
  }, { onConflict: "home_id" });
  if (error) {
    throw new PreparedForecastError(
      "prepared_forecast_write_failed",
      error.message,
    );
  }
}

/**
 * Only exchanges that keep the accepted plan publish a forecast. A home whose
 * exchanges all plan, on a manual request or on prices newer than its plan, has
 * none, and one back from a long silence has one that ends short of the new
 * horizon. No later exchange would publish it, so admission prepares it once.
 */
export async function readOrPrepareForecasts(
  db: PreparedForecastDatabase,
  homeId: string,
  snapshot: OptimisationSnapshot,
  prepare: () => Promise<void>,
): ReturnType<typeof readPreparedForecasts> {
  try {
    return await readPreparedForecasts(db, homeId, snapshot);
  } catch (error) {
    const missing = error instanceof PreparedForecastError &&
      (error.code === "prepared_forecast_unavailable" ||
        error.code === "prepared_forecast_coverage_missing");
    if (!missing) throw error;
  }
  await prepare();
  return await readPreparedForecasts(db, homeId, snapshot);
}

/** New measured input stays authoritative; only server-owned forecast fields are replaced. */
export async function readPreparedForecasts(
  db: PreparedForecastDatabase,
  homeId: string,
  snapshot: OptimisationSnapshot,
): Promise<{
  snapshot: OptimisationSnapshot;
  price_outlook: OptimisationPlan["price_outlook"];
  issued_at: string;
}> {
  const { data, error } = await db.from(PREPARED_FORECAST_TABLE).select(
    "issued_at,forecast",
  ).eq("home_id", homeId).maybeSingle();
  if (error) {
    throw new PreparedForecastError(
      "prepared_forecast_read_failed",
      error.message,
    );
  }
  if (data === null) {
    throw new PreparedForecastError(
      "prepared_forecast_unavailable",
      "No prepared server forecast has been published for this home",
    );
  }
  const row = z.object({ issued_at: timestamp, forecast: z.unknown() })
    .safeParse(data);
  if (!row.success) invalid("Prepared forecast publication is malformed");
  const forecast = parseForecast(row.data.forecast);
  const byTime = new Map(
    forecast.slot_starts.map((start, i) => [Date.parse(start), i]),
  );
  const indices = snapshot.slots.map((slot) => {
    const at = Date.parse(slot.start);
    if (!Number.isFinite(at)) {
      invalid("Snapshot contains an invalid slot timestamp");
    }
    const index = byTime.get(at);
    if (index === undefined) {
      throw new PreparedForecastError(
        "prepared_forecast_coverage_missing",
        `Prepared server forecast does not cover ${slot.start}`,
      );
    }
    return index;
  });
  const align = <T>(values: readonly T[]) => indices.map((i) => values[i]);
  const shadow = align(forecast.price_outlook.shadow_import_sek_per_kwh).map(
    (price, i) => {
      const published = snapshot.slots[i].import_price_sek_per_kwh;
      if (published === null) return price;
      if (!Number.isFinite(published)) {
        invalid("Snapshot contains an invalid published import price");
      }
      return published;
    },
  );
  return {
    issued_at: row.data.issued_at,
    price_outlook: {
      ...forecast.price_outlook,
      shadow_import_sek_per_kwh: shadow,
    },
    snapshot: {
      ...snapshot,
      outdoor_temperature_c: forecast.outdoor_temperature_c === null
        ? undefined
        : align(forecast.outdoor_temperature_c),
      solar_irradiance_w_per_m2: forecast.solar_irradiance_w_per_m2 === null
        ? null
        : align(forecast.solar_irradiance_w_per_m2),
      thermal_zones: forecast.thermal_zones.map((zone) => ({
        ...zone,
        comfort_min_c: align(zone.comfort_min_c),
        target_c: align(zone.target_c),
        comfort_max_c: align(zone.comfort_max_c),
        maximum_power_w_by_slot: align(zone.maximum_power_w_by_slot),
        unplanned_power_w: align(zone.unplanned_power_w),
      })),
    },
  };
}
