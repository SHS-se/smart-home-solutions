import { readMarketProvider } from "../_shared/market-provider-response.ts";
import { entsoeParameters, parseEntsoeResponse, neighbourEntsoeParameters, EntsoeProviderError, type EntsoeResponse } from "../_shared/entsoe-market-data.ts";
import { GENERATION_DATASETS, collectionKind, collectionPlan, type MarketBatch, type MarketZone, type NeighbourZone, type ArchiveDataset } from "../_shared/market-collection-plan.ts";
import { jaoRequest, parseJaoResponse, type JaoDocument, type JaoDataset } from "../_shared/jao-nordic-market-data.ts";
import { assessMarketObservation, type MarketAssessment } from "../_shared/market-evidence-assessment.ts";
export type { ArchiveDataset } from "../_shared/market-collection-plan.ts";
import { captureNucsEvidence, type NucsArchiveDataset } from '../_shared/nucs-market-data.ts';
import { smhiObservationRequest, parseSmhiObservations, type SmhiDocument, type SmhiDataset } from '../_shared/smhi-observations.ts';
import { mediumRangeWeatherRequest, parseMediumRangeWeather, type MediumRangeWeatherDocument } from "../_shared/medium-range-weather.ts";

import { forecastGenerationMixV2 } from "../_shared/generation-mix-v2.ts";
import { acquireSwedishHydrology, type HydroAcquisition } from "../_shared/reservoir-hydrology.ts";
import { captureCapacityEvidence, type CapacityDataset, type CapacityDocuments, type CapacityEvidence } from "../_shared/entsoe-capacity-evidence.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
type EntsoeArchiveDataset = "wind_day_ahead" | "load_day_ahead" | "load_week_ahead" | "generation_actual" | "load_actual" | "neighbour_load_day_ahead" | "neighbour_wind_day_ahead";
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
type JaoArchiveResult = Omit<ResultEvidence, "raw_xml"> & { raw_body: string | null } &
  ({ status: "data"; document: JaoDocument } | { status: "no_data" | "provider_error" | "transport_error" | "parse_error" });
type SmhiArchiveResult = Omit<ResultEvidence, 'raw_xml'> & { raw_body: string | null; request: { station_id: string; dataset: SmhiDataset } } &
  ({ status: 'data'; document: SmhiDocument } | { status: 'provider_error' | 'transport_error' | 'parse_error' });
export type MarketArchiveResult = Awaited<ReturnType<typeof captureNucsEvidence>> | SmhiArchiveResult | EntsoeArchiveResult | WeatherArchiveResult | JaoArchiveResult | HydroAcquisition | CapacityEvidence<CapacityDocuments[CapacityDataset]>;
interface ObservationIdentity {
  id: string;
  batch_id: string;
  request_key: string;
  zone: MarketZone;
  requested_from: string;
  requested_to: string;
  requested_at: string;
  resolved_at: string;
}
type CapacityObservation = { [K in CapacityDataset]: { dataset: K; result: CapacityEvidence<CapacityDocuments[K]> } }[CapacityDataset];
export type MarketArchiveObservation = ObservationIdentity & (
  | { dataset: EntsoeArchiveDataset; result: EntsoeArchiveResult }
  | { dataset: "weather_medium_range"; result: WeatherArchiveResult }
  | { dataset: "sweden_hydrology"; result: HydroAcquisition }
  | { dataset: NucsArchiveDataset; result: Awaited<ReturnType<typeof captureNucsEvidence>> }
  | { dataset: SmhiDataset; result: SmhiArchiveResult }
  | { dataset: JaoDataset; result: JaoArchiveResult }
  | CapacityObservation
);
export interface GenerationForecastRun {
  id: string;
  zone: "SE3";
  origin: string;
  algorithm: string;
  source_refs: Partial<Record<ArchiveDataset, string>>;
  forecast: ReturnType<typeof forecastGenerationMixV2>;
}
export interface MarketArchiveStore {
  verifyToken(token: string): Promise<boolean>;
  saveBatch(batch: MarketBatch): Promise<void>;
  saveObservation(row: MarketArchiveObservation, assessment: MarketAssessment): Promise<void>;
  saveGenerationRun(row: GenerationForecastRun): Promise<void>;
}

/** Capture a bounded provider body; the shared reader owns redaction, size and transport policy. */
async function providerResponse(url: URL, token: string, fetchProvider: typeof fetch) {
  const held = await readMarketProvider(url, token, fetchProvider);
  return held ? { body: new TextDecoder().decode(held.bytes), http_status: held.http_status, body_sha256: held.body_sha256 }
    : { body: null, http_status: null, body_sha256: null };
}

async function entsoeResult(dataset: EntsoeArchiveDataset, from: string, to: string,
  token: string, fetchProvider: typeof fetch, zone: MarketZone): Promise<EntsoeArchiveResult> {
  if (!token) return { status: "transport_error", http_status: null, body_sha256: null,
    raw_xml: null, error_code: "entsoe_token_not_configured" };
  const url = new URL("https://web-api.tp.entsoe.eu/api");
  url.search = (dataset === "neighbour_load_day_ahead" || dataset === "neighbour_wind_day_ahead"
    ? neighbourEntsoeParameters({ dataset, zone: zone as NeighbourZone, from, to })
    : entsoeParameters({ dataset, from, to })).toString();
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

async function jaoResult(dataset: JaoDataset, from: string, to: string, token: string, fetchProvider: typeof fetch): Promise<JaoArchiveResult> {
  const held = await providerResponse(jaoRequest(dataset, from, to), token, fetchProvider);
  const evidence = { http_status: held.http_status, body_sha256: held.body_sha256, raw_body: held.body, error_code: null };
  if (held.body === null) return { ...evidence, status: "transport_error", error_code: "jao_transport_failed" };
  if (held.http_status! < 200 || held.http_status! >= 300) return { ...evidence, status: "provider_error", error_code: `http_${held.http_status}` };
  try {
    const document = parseJaoResponse(dataset, JSON.parse(held.body));
    if (document.rejected) return { ...evidence, status: "provider_error", error_code: "jao_rejected" };
    return document.records.length ? { ...evidence, status: "data", document }
      : { ...evidence, status: "no_data", error_code: "no_matching_data" };
  } catch { return { ...evidence, status: "parse_error", error_code: "unsupported_or_invalid_jao_document" }; }
}

async function smhiResult(dataset: SmhiDataset, station_id: string, from: string, to: string, token: string, fetchProvider: typeof fetch): Promise<SmhiArchiveResult> {
  const request = { dataset, station_id, from, to };
  const held = await providerResponse(smhiObservationRequest(request), token, fetchProvider);
  const evidence = { http_status: held.http_status, body_sha256: held.body_sha256, raw_body: held.body,
    request: { dataset, station_id }, error_code: null };
  if (held.body === null) return { ...evidence, status: 'transport_error', error_code: 'smhi_transport_failed' };
  if (held.http_status! < 200 || held.http_status! >= 300) return { ...evidence, status: 'provider_error', error_code: `http_${held.http_status}` };
  try { return { ...evidence, status: 'data', document: parseSmhiObservations(JSON.parse(held.body), request) }; }
  catch { return { ...evidence, status: 'parse_error', error_code: 'unsupported_or_invalid_smhi_document' }; }
}

/** Day-ahead acquisition is hourly; longer-range inputs join six-hour generation research. */
export function createMarketArchiveHandler(
  config: { projectUrl: string; entsoeToken: string; nucsToken: string },
  store: MarketArchiveStore,
  fetchProvider: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
  acquireHydro: typeof acquireSwedishHydrology = acquireSwedishHydrology,
) {
  return async (request: Request): Promise<Response> => {
    if (config.projectUrl !== TEST) return Response.json({ error: "test_lane_only" }, { status: 403 });
    if (request.method !== "POST") return Response.json({ error: "post_required" }, { status: 405 });
    const token = request.headers.get("x-energy-market-archive-token");
    if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      if (!await store.verifyToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });
    } catch { return Response.json({ error: "archive_auth_failed" }, { status: 500 }); }
    let kind: ReturnType<typeof collectionKind>;
    try { kind = collectionKind(await request.text()); }
    catch { return Response.json({ error: "invalid_archive_request" }, { status: 400 }); }
    const batch: MarketBatch = { id: crypto.randomUUID(), kind, requested_at: clock().toISOString(), plan: collectionPlan(kind, clock()) };
    try { await store.saveBatch(batch); }
    catch { return Response.json({ error: "archive_batch_storage_failed" }, { status: 500 }); }
    const outcomes = await Promise.allSettled(batch.plan.map(async ({ dataset, zone, from, to, key, station_id, neighbour, direction }) => {
      const identity = { id: crypto.randomUUID(), batch_id: batch.id, request_key: key, zone,
        requested_from: from, requested_to: to, requested_at: clock().toISOString() };
      const row: MarketArchiveObservation = dataset === 'nucs_week_ahead_ntc' || dataset === 'nucs_transmission_outages'
        ? { ...identity, dataset, result: await captureNucsEvidence({ dataset, neighbour: neighbour!, direction: direction!, from, to }, config.nucsToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === 'smhi_wind_10m_observed' || dataset === 'smhi_temperature_2m_observed'
        ? { ...identity, dataset, result: await smhiResult(dataset, station_id!, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "weather_medium_range"
        ? { ...identity, dataset, result: await weatherResult(identity.requested_at, config.entsoeToken, fetchProvider, 28), resolved_at: clock().toISOString() }
        : dataset === "sweden_hydrology"
        ? { ...identity, dataset, result: await acquireHydro(fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "production_outages"
        ? { ...identity, dataset, result: await captureCapacityEvidence(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "generation_outages"
        ? { ...identity, dataset, result: await captureCapacityEvidence(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "installed_generation_units"
        ? { ...identity, dataset, result: await captureCapacityEvidence(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "jao_max_net_positions" || dataset === "jao_max_exchanges"
        ? { ...identity, dataset, result: await jaoResult(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : { ...identity, dataset, result: await entsoeResult(dataset, from, to, config.entsoeToken, fetchProvider, zone), resolved_at: clock().toISOString() };
      await store.saveObservation(row, assessMarketObservation(row));
      return row;
    }));
    const rows = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    const observations = rows.map(row => ({ id: row.id, dataset: row.dataset, status: row.result.status }));
    if (rows.length !== batch.plan.length) return Response.json({ error: "archive_storage_failed", observations }, { status: 500 });
    if (kind !== "generation") return Response.json({ batch_id: batch.id, observations });
    const actual = rows.find(row => row.dataset === "generation_actual");
    const weather = rows.find(row => row.dataset === "weather_medium_range");
    const published = rows.find(row => row.dataset === "wind_day_ahead");
    const hydro = rows.find(row => row.dataset === "sweden_hydrology");
    const roster = rows.find(row => row.dataset === "installed_generation_units");
    const production = rows.find(row => row.dataset === "production_outages");
    const generators = rows.find(row => row.dataset === "generation_outages");
    const forecast = forecastGenerationMixV2({ origin: clock().toISOString(),
      actuals: actual?.dataset === "generation_actual" && actual.result.status === "data" ? actual.result.document.intervals : [],
      weather: weather?.dataset === "weather_medium_range" && weather.result.status === "data" ? weather.result.document : null,
      published: published?.dataset === "wind_day_ahead" && published.result.status === "data" ? published.result.document.intervals : [],
      hydro: hydro?.dataset === "sweden_hydrology" && hydro.result.status === "data" ? hydro.result.document : null,
      nuclear: {
        roster: roster?.dataset === "installed_generation_units" && roster.result.status === "data" ? roster.result.document : null,
        productionOutages: production?.dataset === "production_outages" && production.result.status === "data" ? production.result.document : null,
        generationOutages: generators?.dataset === "generation_outages" && generators.result.status === "data" ? generators.result.document : null,
      },
    });
    const run: GenerationForecastRun = { id: crypto.randomUUID(), zone: forecast.zone,
      origin: forecast.origin, algorithm: forecast.algorithm,
      source_refs: Object.fromEntries(rows.filter(row => GENERATION_DATASETS.includes(row.dataset as typeof GENERATION_DATASETS[number])).map(row => [row.dataset, row.id])), forecast };
    try { await store.saveGenerationRun(run); }
    catch { return Response.json({ error: "generation_run_storage_failed", observations }, { status: 500 }); }
    const predicted: Record<string, number> = {};
    for (const hour of forecast.hours) for (const candidates of Object.values(hour.byPsr)) {
      for (const [model, prediction] of Object.entries(candidates)) if (prediction.status === "predicted") predicted[model] = (predicted[model] ?? 0) + 1;
    }
    return Response.json({ batch_id: batch.id, observations, generation: { id: run.id, origin: run.origin, predicted } });
  };
}

if (import.meta.main) {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.57.2");
  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const client = createClient(projectUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  Deno.serve(createMarketArchiveHandler({ projectUrl, entsoeToken: Deno.env.get("ENTSOE_API_TOKEN") ?? "", nucsToken: Deno.env.get("NUCS_WEB_API_TOKEN") ?? "" }, {
    async verifyToken(token) {
      const { data, error } = await client.rpc("verify_test_market_archive_token", { p_token: token });
      if (error) throw new Error("Archive authentication storage failed");
      return data === true;
    },
    async saveBatch(batch) {
      const { error } = await client.from("energy_market_collection_batches").insert(batch);
      if (error) throw new Error("Archive batch storage failed");
    },
    async saveObservation(row, assessment) {
      const { error } = await client.rpc("record_test_market_observation", { p_observation: row, p_assessment: assessment });
      if (error) throw new Error("Archive observation storage failed");
    },
    async saveGenerationRun(row) {
      const { error } = await client.from("energy_generation_forecast_runs").insert(row);
      if (error) throw new Error("Generation run storage failed");
    },
  }));
}
