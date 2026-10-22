import { entsoeParameters, parseEntsoeResponse, EntsoeProviderError, type EntsoeResponse } from "../_shared/entsoe-market-data.ts";
import { ARCHIVED_MARKET_DATASETS } from "../_shared/price-estimate-evidence.ts";
import { mediumRangeWeatherRequest, parseMediumRangeWeather, type MediumRangeWeatherDocument } from "../_shared/medium-range-weather.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const DAY = 86_400_000;
export type ArchiveDataset = typeof ARCHIVED_MARKET_DATASETS[number];
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
export interface MarketArchiveStore {
  verifyToken(token: string): Promise<boolean>;
  saveObservation(row: MarketArchiveObservation): Promise<void>;
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

async function weatherResult(requestedAt: string, token: string, fetchProvider: typeof fetch): Promise<WeatherArchiveResult> {
  const request = mediumRangeWeatherRequest();
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
    const today = Date.parse(`${clock().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const outcomes = await Promise.allSettled(ARCHIVED_MARKET_DATASETS.map(async dataset => {
      const from = new Date(today).toISOString();
      const to = new Date(today + (dataset === "load_week_ahead" ? 9 : dataset === "weather_medium_range" ? 7 : 3) * DAY).toISOString();
      const requestedAt = clock().toISOString();
      const identity = { id: crypto.randomUUID(), zone: "SE3" as const,
        requested_from: from, requested_to: to, requested_at: requestedAt };
      const row: MarketArchiveObservation = dataset === "weather_medium_range"
        ? { ...identity, dataset, result: await weatherResult(requestedAt, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : { ...identity, dataset, result: await entsoeResult(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() };
      await store.saveObservation(row);
      return { id: row.id, dataset, status: row.result.status };
    }));
    const saved = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    if (saved.length !== ARCHIVED_MARKET_DATASETS.length) return Response.json({ error: "archive_storage_failed", observations: saved }, { status: 500 });
    return Response.json({ observations: saved });
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
  }));
}
