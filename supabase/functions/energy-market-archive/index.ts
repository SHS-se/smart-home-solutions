import { entsoeParameters, parseEntsoeResponse, EntsoeProviderError, type EntsoeResponse } from "../_shared/entsoe-market-data.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const DAY = 86_400_000;
const DATASETS = ["wind_day_ahead", "load_day_ahead", "load_week_ahead"] as const;
export type ArchiveDataset = typeof DATASETS[number];
type DataDocument = Extract<EntsoeResponse, { status: "data" }>;
interface ResultEvidence {
  http_status: number | null;
  /** Digest of the retained, credential-redacted UTF-8 body. */
  body_sha256: string | null;
  raw_xml: string | null;
  error_code: string | null;
}
export type MarketArchiveResult = ResultEvidence & (
  | { status: "data"; document: DataDocument }
  | { status: "no_data" | "provider_error" | "transport_error" | "parse_error" }
);
export interface MarketArchiveObservation {
  id: string;
  dataset: ArchiveDataset;
  zone: "SE3";
  requested_from: string;
  requested_to: string;
  requested_at: string;
  resolved_at: string;
  result: MarketArchiveResult;
}
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
    if (!config.entsoeToken) return Response.json({ error: "entsoe_token_not_configured" }, { status: 503 });
    const today = Date.parse(`${clock().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const outcomes = await Promise.allSettled(DATASETS.map(async dataset => {
      const from = new Date(today).toISOString();
      const to = new Date(today + (dataset === "load_week_ahead" ? 9 : 3) * DAY).toISOString();
      const requestedAt = clock().toISOString();
      const url = new URL("https://web-api.tp.entsoe.eu/api");
      url.search = entsoeParameters({ dataset, from, to }).toString();
      url.searchParams.set("securityToken", config.entsoeToken);
      let result: MarketArchiveResult;
      let response: Response;
      try {
        response = await fetchProvider(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
        const body = redact(await response.text(), config.entsoeToken);
        const evidence: ResultEvidence = { http_status: response.status, body_sha256: await digest(body), raw_xml: body, error_code: null };
        if (!response.ok) result = { ...evidence, status: "provider_error", error_code: `http_${response.status}` };
        else {
          try {
            const document = parseEntsoeResponse(body);
            result = document.status === "data" ? { ...evidence, status: "data", document }
              : { ...evidence, status: "no_data", error_code: "no_matching_data" };
          } catch (error) {
            result = error instanceof EntsoeProviderError
              ? { ...evidence, status: "provider_error", error_code: "provider_acknowledgement" }
              : { ...evidence, status: "parse_error", error_code: "unsupported_or_invalid_entsoe_document" };
          }
        }
      } catch {
        // Error messages can contain the token-bearing URL. Retain a closed error code.
        result = { status: "transport_error", http_status: null, body_sha256: null, raw_xml: null, error_code: "entsoe_transport_failed" };
      }
      const row: MarketArchiveObservation = { id: crypto.randomUUID(), dataset, zone: "SE3",
        requested_from: from, requested_to: to, requested_at: requestedAt, resolved_at: clock().toISOString(), result };
      await store.saveObservation(row);
      return { id: row.id, dataset, status: result.status };
    }));
    const saved = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    if (saved.length !== DATASETS.length) return Response.json({ error: "archive_storage_failed", observations: saved }, { status: 500 });
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
