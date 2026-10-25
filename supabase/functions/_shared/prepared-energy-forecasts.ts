/** Cached forecast products only. Device evidence is captured separately from the model store. */
import { z } from "zod";
import type { ThermalZoneModel } from "./planner/models/room/thermal.ts";
import { mergePlanningWarnings } from "./planner/planning-warnings.ts";
import type {
  OptimisationPlan,
  OptimisationSnapshot,
} from "./planner/planning-contracts.ts";

export const PREPARED_FORECAST_TABLE = "energy_prepared_forecasts";
const finite = z.number().finite();
const timestamp = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Invalid timestamp",
);
/** Current inventory joined to a captured model; never stored in the forecast product. */
export interface PreparedRoom {
  key: string;
  name: string;
  device_keys: string[];
  model: ThermalZoneModel | null;
  rated_power_w: number;
  maximum_power_w_by_slot: number[];
}
const forecastSchema = z.object({
  schema_version: z.literal(2),
  planner_location: z.object({latitude:finite,longitude:finite}).nullable(),
  planning_warnings: z.object({ code: z.string(), scope: z.string(), severity: z.enum(["warning", "error"]),
    message: z.string(), consequence: z.string(), evidence: z.record(z.union([z.string(), finite, z.null()])).optional(),
    entity_id: z.string().optional() }).array(),
  slot_starts: timestamp.array().nonempty(),
  /** Published inputs, distinct from estimates that happen to have the same value. */
  published_import_sek_per_kwh: finite.nullable().array(),
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
  house_temperature_c: finite.nullable().array().nullable().optional(),
}).strict();
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
  coverage(forecast.published_import_sek_per_kwh, "published price inputs");
  coverage(forecast.outdoor_temperature_c, "outdoor temperature");
  coverage(forecast.solar_irradiance_w_per_m2, "irradiance");
  coverage(forecast.house_temperature_c ?? null, "house temperature");
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
    schema_version: 2,
    planning_warnings: preparedSnapshot.planning_warnings ?? [],
    planner_location: preparedSnapshot.location ?? null,
    slot_starts: preparedSnapshot.slots.map((slot) => slot.start),
    published_import_sek_per_kwh: preparedSnapshot.slots.map((slot) => slot.import_price_sek_per_kwh),
    price_outlook: resolvedOutlook,
    outdoor_temperature_c: preparedSnapshot.outdoor_temperature_c ?? null,
    solar_irradiance_w_per_m2: preparedSnapshot.solar_irradiance_w_per_m2 ??
      null,
    house_temperature_c: preparedSnapshot.house_temperature_c ?? null,
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

/** Align a fresh forecast product without importing its calibration, inventory or measured state. */
export function alignPreparedForecastSnapshot(snapshot: OptimisationSnapshot,
  prepared: OptimisationSnapshot): OptimisationSnapshot {
  const byTime = new Map(prepared.slots.map((slot, index) => [Date.parse(slot.start), index]));
  const indices = snapshot.slots.map(slot => {
    const index = byTime.get(Date.parse(slot.start));
    if (index === undefined) throw new PreparedForecastError("prepared_forecast_coverage_missing",
      `Prepared server forecast does not cover ${slot.start}`);
    return index;
  });
  const align = <T>(values: readonly T[] | null | undefined) =>
    values == null ? values : indices.map(index => values[index]);
  return {
    ...snapshot,
    outdoor_temperature_c: align(prepared.outdoor_temperature_c) ?? undefined,
    solar_irradiance_w_per_m2: align(prepared.solar_irradiance_w_per_m2),
    house_temperature_c: align(prepared.house_temperature_c) ?? null,
    sources: { ...snapshot.sources, outdoor_temperature: prepared.sources.outdoor_temperature },
    planning_warnings: mergePlanningWarnings(snapshot.planning_warnings, prepared.planning_warnings),
  };
}

/**
 * Only exchanges that keep the accepted plan publish a forecast. A home whose
 * exchanges all plan, on a manual request or on prices newer than its plan, has
 * none, and one back from a long silence has one that ends short of the new
 * horizon. A new price release also changes the forecast's boundary and level;
 * it cannot be spliced onto a tail fitted to the previous release. Admission
 * prepares once when coverage or the published price inputs have changed.
 */
export async function readOrPrepareForecasts(
  db: PreparedForecastDatabase,
  homeId: string,
  snapshot: OptimisationSnapshot,
  prepare: () => Promise<void | { snapshot: OptimisationSnapshot; price_outlook: OptimisationPlan["price_outlook"]; issued_at: string }>,
): ReturnType<typeof readPreparedForecasts> {
  try {
    return await readPreparedForecasts(db, homeId, snapshot);
  } catch (error) {
    const needsPreparation = error instanceof PreparedForecastError &&
      (error.code === "prepared_forecast_location_changed" ||
        error.code === "prepared_forecast_read_failed" ||
        error.code === "prepared_forecast_unavailable" ||
        error.code === "prepared_forecast_invalid" ||
        error.code === "prepared_forecast_coverage_missing" ||
        error.code === "prepared_forecast_prices_changed");
    if (!needsPreparation) throw error;
  }
  const fresh = await prepare();
  // A successful fresh preparation is usable even if publication storage is down.
  if (fresh) return {
    issued_at: fresh.issued_at,
    price_outlook: fresh.price_outlook,
    snapshot: alignPreparedForecastSnapshot(snapshot, fresh.snapshot),
  };
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
  if(JSON.stringify(forecast.planner_location)!==JSON.stringify(snapshot.location??null)) {
    throw new PreparedForecastError("prepared_forecast_location_changed","The planner address location changed; refresh the forecast for its new site");
  }
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
  // Compare source values, not publication clocks or a jump-size threshold.
  // Rebuild the complete outlook so its existing boundary carry is applied to
  // the current last published quarter, with the current published-day level.
  if (indices.some((index, i) => forecast.published_import_sek_per_kwh[index] !== snapshot.slots[i].import_price_sek_per_kwh)) {
    throw new PreparedForecastError(
      "prepared_forecast_prices_changed",
      "Prepared price outlook uses different published prices; prepare it from the current release",
    );
  }
  return {
    issued_at: row.data.issued_at,
    price_outlook: {
      ...forecast.price_outlook,
      shadow_import_sek_per_kwh: shadow,
    },
    snapshot: {
      ...snapshot,
      planning_warnings: mergePlanningWarnings(snapshot.planning_warnings, forecast.planning_warnings),
      outdoor_temperature_c: forecast.outdoor_temperature_c === null
        ? undefined
        : align(forecast.outdoor_temperature_c),
      solar_irradiance_w_per_m2: forecast.solar_irradiance_w_per_m2 === null
        ? null
        : align(forecast.solar_irradiance_w_per_m2),
      house_temperature_c: forecast.house_temperature_c ? align(forecast.house_temperature_c) : null,
    },
  };
}
