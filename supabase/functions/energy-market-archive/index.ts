import { svkFlowRequest, parseSvkFlowResponse, type SvkFlowDataset } from "../_shared/svk-physical-flows.ts";
import { readMarketProvider } from "../_shared/market-provider-response.ts";
import { entsoeParameters, parseEntsoeResponse, neighbourEntsoeParameters, EntsoeProviderError, type EntsoeResponse } from "../_shared/entsoe-market-data.ts";
import { parseCollectionRequest, collectionPlan, type MarketBatch, type MarketZone, type NeighbourZone, type ArchiveDataset } from "../_shared/market-collection-plan.ts";
import { jaoRequest, parseJaoResponse, type JaoDocument, type JaoDataset } from "../_shared/jao-nordic-market-data.ts";
import { assessMarketObservation, type MarketAssessment } from "../_shared/market-evidence-assessment.ts";
export type { ArchiveDataset } from "../_shared/market-collection-plan.ts";
import { captureNucsEvidence, type NucsArchiveDataset } from '../_shared/nucs-market-data.ts';
import { smhiObservationRequest, parseSmhiObservations, type SmhiDocument, type SmhiDataset } from '../_shared/smhi-observations.ts';

import { acquireSwedishHydrology, type HydroAcquisition } from "../_shared/reservoir-hydrology.ts";
import { captureCapacityEvidence, type CapacityDataset, type CapacityDocuments, type CapacityEvidence } from "../_shared/entsoe-capacity-evidence.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
type EntsoeArchiveDataset = "spot_price" | "wind_day_ahead" | "load_day_ahead" | "load_week_ahead" | "generation_actual" | "load_actual" | "neighbour_load_day_ahead" | "neighbour_wind_day_ahead";
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
type JaoArchiveResult = Omit<ResultEvidence, "raw_xml"> & { raw_body: string | null } &
  ({ status: "data"; document: JaoDocument } | { status: "no_data" | "provider_error" | "transport_error" | "parse_error" });
type SvkArchiveResult = Omit<ResultEvidence, "raw_xml"> & { raw_body: string | null } &
  ({ status: "data"; document: ReturnType<typeof parseSvkFlowResponse> } | { status: "no_data" | "provider_error" | "transport_error" | "parse_error" });
type SmhiArchiveResult = Omit<ResultEvidence, 'raw_xml'> & { raw_body: string | null; request: { station_id: string; dataset: SmhiDataset } } &
  ({ status: 'data'; document: SmhiDocument } | { status: 'provider_error' | 'transport_error' | 'parse_error' });
export type MarketArchiveResult = Awaited<ReturnType<typeof captureNucsEvidence>> | SmhiArchiveResult | SvkArchiveResult | EntsoeArchiveResult | JaoArchiveResult | HydroAcquisition | CapacityEvidence<CapacityDocuments[CapacityDataset]>;
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
  | { dataset: "sweden_hydrology"; result: HydroAcquisition }
  | { dataset: NucsArchiveDataset; result: Awaited<ReturnType<typeof captureNucsEvidence>> }
  | { dataset: SmhiDataset; result: SmhiArchiveResult }
  | { dataset: JaoDataset; result: JaoArchiveResult }
  | { dataset: SvkFlowDataset; result: SvkArchiveResult }
  | CapacityObservation
);
export interface MarketArchiveStore {
  verifyToken(token: string): Promise<boolean>;
  saveBatch(batch: MarketBatch): Promise<void>;
  saveObservation(row: MarketArchiveObservation, assessment: MarketAssessment): Promise<void>;
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
    : entsoeParameters({ dataset: dataset === "spot_price" ? "price" : dataset, from, to })).toString();
  url.searchParams.set("securityToken", token);
  const held = await providerResponse(url, token, fetchProvider);
  const evidence: ResultEvidence = { http_status: held.http_status, body_sha256: held.body_sha256,
    raw_xml: held.body, error_code: null };
  if (held.body === null) return { ...evidence, status: "transport_error", error_code: "entsoe_transport_failed" };
  if (held.http_status! < 200 || held.http_status! >= 300) return { ...evidence, status: "provider_error", error_code: `http_${held.http_status}` };
  try {
    const document = parseEntsoeResponse(held.body);
    if (dataset === "spot_price" && document.status === "data" &&
      document.intervals.some(interval => interval.currency !== "EUR" || interval.unit !== "MWH")) throw new Error("Unexpected spot price unit");
    return document.status === "data" ? { ...evidence, status: "data", document }
      : { ...evidence, status: "no_data", error_code: "no_matching_data" };
  } catch (error) {
    return error instanceof EntsoeProviderError
      ? { ...evidence, status: "provider_error", error_code: "provider_acknowledgement" }
      : { ...evidence, status: "parse_error", error_code: "unsupported_or_invalid_entsoe_document" };
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

async function svkResult(dataset: SvkFlowDataset, from: string, to: string, fetchProvider: typeof fetch): Promise<SvkArchiveResult> {
  const held = await providerResponse(svkFlowRequest(dataset, from, to), "", fetchProvider);
  const evidence = { http_status: held.http_status, body_sha256: held.body_sha256, raw_body: held.body, error_code: null };
  if (held.body === null) return { ...evidence, status: "transport_error", error_code: "svk_transport_failed" };
  if (held.http_status! < 200 || held.http_status! >= 300) return { ...evidence, status: "provider_error", error_code: `http_${held.http_status}` };
  try {
    const document = parseSvkFlowResponse(dataset, JSON.parse(held.body), from, to);
    return { ...evidence, status: "data", document };
  } catch { return { ...evidence, status: "parse_error", error_code: "unsupported_or_invalid_svk_document" }; }
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
    let batch: MarketBatch;
    try {
      const { kind, day, flowHistoryDataset } = parseCollectionRequest(await request.text());
      const now = clock();
      batch = { id: crypto.randomUUID(), kind, requested_at: now.toISOString(), plan: collectionPlan(kind, now, day, flowHistoryDataset) };
    } catch { return Response.json({ error: "invalid_archive_request" }, { status: 400 }); }
    try { await store.saveBatch(batch); }
    catch { return Response.json({ error: "archive_batch_storage_failed" }, { status: 500 }); }
    const outcomes = await Promise.allSettled(batch.plan.map(async ({ dataset, zone, from, to, key, station_id, neighbour, direction }) => {
      const identity = { id: crypto.randomUUID(), batch_id: batch.id, request_key: key, zone,
        requested_from: from, requested_to: to, requested_at: clock().toISOString() };
      const row: MarketArchiveObservation = dataset === 'nucs_week_ahead_ntc' || dataset === 'nucs_transmission_outages'
        ? { ...identity, dataset, result: await captureNucsEvidence({ dataset, neighbour: neighbour!, direction: direction!, from, to }, config.nucsToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === 'smhi_wind_10m_observed' || dataset === 'smhi_temperature_2m_observed'
        ? { ...identity, dataset, result: await smhiResult(dataset, station_id!, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "sweden_hydrology"
        ? { ...identity, dataset, result: await acquireHydro(fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "production_outages"
        ? { ...identity, dataset, result: await captureCapacityEvidence(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "generation_outages"
        ? { ...identity, dataset, result: await captureCapacityEvidence(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "installed_generation_units"
        ? { ...identity, dataset, result: await captureCapacityEvidence(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "svk_physical_imports" || dataset === "svk_physical_exports"
        ? { ...identity, dataset, result: await svkResult(dataset, from, to, fetchProvider), resolved_at: clock().toISOString() }
        : dataset === "jao_max_net_positions" || dataset === "jao_max_exchanges" || dataset === "jao_day_ahead_border_flows" || dataset === "jao_day_ahead_net_position"
        ? { ...identity, dataset, result: await jaoResult(dataset, from, to, config.entsoeToken, fetchProvider), resolved_at: clock().toISOString() }
        : { ...identity, dataset, result: await entsoeResult(dataset, from, to, config.entsoeToken, fetchProvider, zone), resolved_at: clock().toISOString() };
      await store.saveObservation(row, assessMarketObservation(row));
      return row;
    }));
    const rows = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    const observations = rows.map(row => ({ id: row.id, dataset: row.dataset, status: row.result.status }));
    if (rows.length !== batch.plan.length) return Response.json({ error: "archive_storage_failed", observations }, { status: 500 });
    return Response.json({ batch_id: batch.id, observations });
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

  }));
}
