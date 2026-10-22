import { entsoeParameters, parseEntsoeResponse, EntsoeProviderError, type EntsoeResponse } from "../_shared/entsoe-market-data.ts";
import { ARCHIVED_MARKET_DATASETS } from "../_shared/price-estimate-evidence.ts";
import { mediumRangeWeatherRequest, parseMediumRangeWeather, type MediumRangeWeatherDocument } from "../_shared/medium-range-weather.ts";

import { forecastGenerationMix } from "../_shared/generation-mix.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const DAY = 86_400_000;
export type ArchiveDataset = typeof ARCHIVED_MARKET_DATASETS[number] | "generation_actual";
type EntsoeArchiveDataset = Exclude<ArchiveDataset, "weather_medium_range">;
type DataDocument = Extract<EntsoeResponse, { status: "data" }>;
interface ResultEvidence {
  http_status: number | null;
  /** Digest of the retained, credential-redacted UTF-8 body. */
  body_sha256: string | null;
  raw_xml: string | null;
  error_code: string | null;
}
type EntsoeArchiveResult = ResultEvidence & (
  | { status: "data"; document: DataDocument }
  | { status: "no_data" | "provider_error" | "transport_error" | "parse_error" }
);
type WeatherArchiveResult = Omit<ResultEvidence, "raw_xml"> & {
  raw_body: string | null;
  request: ReturnType<typeof mediumRangeWeatherRequest>["record"];
} & ({ status: "data"; document: MediumRangeWeatherDocument }
  | { status: "provider_error" | "transport_error" | "parse_error" });
export type MarketArchiveResult = EntsoeArchiveResult | WeatherArchiveResult;
interface ObservationIdentity {
  id: string;
  zone: "SE3";
  requested_from: string;
  requested_to: string;
  requested_at: string;
  resolved_at: string;
}
export type MarketArchiveObservation = ObservationIdentity & (
  | { dataset: EntsoeArchiveDataset; result: EntsoeArchiveResult }
  | { dataset: "weather_medium_range"; result: WeatherArchiveResult }
);
export interface GenerationForecastRun {
  id: string;
  zone: "SE3";
  origin: string;
  algorithm: string;
  source_refs: Partial<Record<ArchiveDataset, string>>;
  forecast: ReturnType<typeof forecastGenerationMix>;
}
export interface MarketArchiveStore {
  verifyToken(token: string): Promise<boolean>;
  saveObservation(row: MarketArchiveObservation): Promise<void>;
  saveGenerationRun(row: GenerationForecastRun): Promise<void>;
}

function redact(body: string, token: string): string {
  const variants = [token, encodeURIComponent(token), new URLSearchParams({ token }).toString().slice(6)];
  for (const value of new Set(variants)) if (value) body = body.replaceAll(value, "[REDACTED]");
  return body;
}
async function digest(body: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

/** Capture one bounded request without exposing token-bearing transport errors. */
async function providerResponse(url: URL, token: string, fetchProvider: typeof fetch) {
  try {
    const response = await fetchProvider(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    const body = redact(await response.text(), token);
    return { body, http_status: response.status, body_sha256: await digest(body) };
  } catch {
    return { body: null, http_status: null, body_sha256: null };
  }
}

async function entsoeResult(dataset: EntsoeArchiveDataset, from: string, to: string,
  token: string, fetchProvider: typeof fetch): Promise<EntsoeArchiveResult> {
  if (!token) return { status: "transport_error", http_status: null, body_sha256: null,
    raw_xml: null, error_code: "entsoe_token_not_configured" };
  const url = new URL("https://web-api.tp.entsoe.eu/api");
  url.search = entsoeParameters({ dataset, from, to }).toString();
  url.searchParams.set("securityToken", token);
  const held = await providerResponse(url, token, fetchProvider);
  const evidence: ResultEvidence = { http_status: held.http_status, body_sha256: held.body_sha256,
    raw_xml: held.body, error_code: null };
  if (held.body === null) return { ...evidence, status: "transport_error", error_code: "entsoe_transport_failed" };
  if (held.http_status! < 200 || held.http_status! >= 300) return { ...evidence, status: "provider_error", error_code: `http_${held.http_status}` };
  try {
    const document = parseEntsoeResponse(held.body);
    return document.status === "data" ? { ...evidence, status: "data", document }
      : { ...evidence, status: "no_data", error_code: "no_matching_data" };
  } catch (error) {
    return error instanceof EntsoeProviderError
      ? { ...evidence, status: "provider_error", error_code: "provider_acknowledgement" }
      : { ...evidence, status: "parse_error", error_code: "unsupported_or_invalid_entsoe_document" };
  }
}

async function weatherResult(requestedAt: string, token: string, fetchProvider: typeof fetch, pastDays: 0 | 28): Promise<WeatherArchiveResult> {
  const request = mediumRangeWeatherRequest(pastDays);
  const held = await providerResponse(request.url, token, fetchProvider);
  const evidence = { http_status: held.http_status, body_sha256: held.body_sha256,
    raw_body: held.body, error_code: null, request: request.record };
  if (held.body === null) return { ...evidence, status: "transport_error", error_code: "weather_transport_failed" };
  if (held.http_status! < 200 || held.http_status! >= 300) return { ...evidence, status: "provider_error", error_code: `http_${held.http_status}` };
  try {
    const body: unknown = JSON.parse(held.body);
    if (body && typeof body === "object" && "error" in body && body.error === true) {
      return { ...evidence, status: "provider_error", error_code: "weather_provider_error" };
    }
    return { ...evidence, status: "data", document: parseMediumRangeWeather(body, requestedAt) };
  } catch {
    return { ...evidence, status: "parse_error", error_code: "unsupported_or_invalid_weather_document" };
  }
}

/** Independent hourly acquisition. Provider failures become evidence, never model inputs. */
export function createMarketArchiveHandler(
  config: { projectUrl: string; entsoeToken: string },
  store: MarketArchiveStore,
  fetchProvider: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
) {
  return async (request: Request): Promise<Response> => {
    if (config.projectUrl !== TEST) return Response.json({ error: "test_lane_only" }, { status: 403 });
    if (request.method !== "POST") return Response.json({ error: "post_required" }, { status: 405 });
    const token = request.headers.get("x-energy-market-archive-token");
    if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      if (!await store.verifyToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });
    } catch { return Response.json({ error: "archive_auth_failed" }, { status: 500 }); }
    let generation = false;
    try {
      const body = await request.text();
      const options: unknown = body.trim() ? JSON.parse(body) : {};
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid archive request");
      const fields = Object.keys(options);
      if (fields.length && (fields.length !== 1 || fields[0] !== "generation" || !("generation" in options) || options.generation !== true)) throw new Error("Invalid archive request");
      generation = "generation" in options;
    } catch { return Response.json({ error: "invalid_archive_request" }, { status: 400 }); }
    const today = Date.parse(`${clock().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const datasets: ArchiveDataset[] = [...ARCHIVED_MARKET_DATASETS, ...(generation ? ["generation_actual" as const] : [])];
    const outcomes = await Promise.allSettled(datasets.map(async dataset => {
      const from = new Date(dataset === "generation_actual" ? Math.floor(clock().getTime() / 60_000) * 60_000 - 28 * DAY
        : today - (generation && dataset === "weather_medium_range" ? 28 * DAY : 0)).toISOString();
      const to = dataset === "generation_actual" ? new Date(Math.floor(clock().getTime() / 60_000) * 60_000).toISOString()
        : new Date(today + (dataset === "load_week_ahead" ? 9 : dataset === "weather_medium_range" ? 7 : 3) * DAY).toISOString();
      const requestedAt = clock().toISOString();
      const identity = { id: crypto.randomUUID(), zone: "SE3" as const,
        requested_from: from, requested_to: to, requested_at: requestedAt };
      const row: MarketArchiveObservation = dataset === "weather_medium_range"
        ? { ...identity, dataset, result: await weatherResult(requestedAt, config.entsoeToken, fetchProvider, generation ? 28 : 0), resolved_at: clock().toISOString() }
        : { ...identity, dataset, result: await entsoeResult(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() };
      await store.saveObservation(row);
      return row;
    }));
    const rows = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    const observations = rows.map(row => ({ id: row.id, dataset: row.dataset, status: row.result.status }));
    if (rows.length !== datasets.length) return Response.json({ error: "archive_storage_failed", observations }, { status: 500 });
    if (!generation) return Response.json({ observations });
    const actual = rows.find(row => row.dataset === "generation_actual");
    const weather = rows.find(row => row.dataset === "weather_medium_range");
    const published = rows.find(row => row.dataset === "wind_day_ahead");
    const forecast = forecastGenerationMix({ origin: clock().toISOString(),
      actuals: actual?.dataset === "generation_actual" && actual.result.status === "data" ? actual.result.document.intervals : [],
      weather: weather?.dataset === "weather_medium_range" && weather.result.status === "data" ? weather.result.document : null,
      published: published?.dataset === "wind_day_ahead" && published.result.status === "data" ? published.result.document.intervals : [],
    });
    const run: GenerationForecastRun = { id: crypto.randomUUID(), zone: forecast.zone,
      origin: forecast.origin, algorithm: forecast.algorithm,
      source_refs: Object.fromEntries(rows.map(row => [row.dataset, row.id])), forecast };
    try { await store.saveGenerationRun(run); }
    catch { return Response.json({ error: "generation_run_storage_failed", observations }, { status: 500 }); }
    const predicted: Record<string, number> = {};
    for (const hour of forecast.hours) for (const candidates of Object.values(hour.byPsr)) {
      for (const [model, prediction] of Object.entries(candidates)) if (prediction.status === "predicted") predicted[model] = (predicted[model] ?? 0) + 1;
    }
    return Response.json({ observations, generation: { id: run.id, origin: run.origin, predicted } });
  };
}

if (import.meta.main) {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.57.2");
  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const client = createClient(projectUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  Deno.serve(createMarketArchiveHandler({ projectUrl, entsoeToken: Deno.env.get("ENTSOE_API_TOKEN") ?? "" }, {
    async verifyToken(token) {
      const { data, error } = await client.rpc("verify_test_market_archive_token", { p_token: token });
      if (error) throw new Error("Archive authentication storage failed");
      return data === true;
    },
    async saveObservation(row) {
      const { error } = await client.from("energy_market_forecast_observations").insert(row);
      if (error) throw new Error("Archive observation storage failed");
    },
    async saveGenerationRun(row) {
      const { error } = await client.from("energy_generation_forecast_runs").insert(row);
      if (error) throw new Error("Generation run storage failed");
    },
  }));
}
