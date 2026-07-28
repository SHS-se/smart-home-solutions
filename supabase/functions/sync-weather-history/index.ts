import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { resolveCaller } from "../_shared/staff-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DATASET_KEY = "stockholm-taby";
const ARCHIVE_URL =
  "https://opendata-download-metobs.smhi.se/api/version/latest/parameter/2/station/98230/period/corrected-archive/data.csv";
const RECENT_URL =
  "https://opendata-download-metobs.smhi.se/api/version/latest/parameter/2/station/98230/period/latest-months/data.csv";
const UPSERT_CHUNK_SIZE = 2000;

interface WeatherObservation {
  dataset_key: string;
  observed_on: string;
  temperature_c: number;
  quality_code: string | null;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fetchCsv(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "text/plain,text/csv" },
  });
  if (!response.ok) {
    throw new Error(`SMHI returned HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function parseSmhiDailyMeanCsv(csvText: string): WeatherObservation[] {
  const lines = csvText.replace(/\r\n?/g, "\n").split("\n");
  const dataHeaderIndex = lines.findIndex((line) =>
    line.replace(/^\uFEFF/, "").startsWith("Från Datum Tid (UTC)")
  );
  if (dataHeaderIndex < 0) {
    throw new Error("SMHI CSV did not contain its daily observation header");
  }

  const observations: WeatherObservation[] = [];
  for (const line of lines.slice(dataHeaderIndex + 1)) {
    const columns = line.split(";");
    const observedOn = columns[2]?.trim() ?? "";
    const temperatureText = columns[3]?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedOn) || temperatureText === "") continue;

    const temperatureC = Number(temperatureText.replace(",", "."));
    if (!Number.isFinite(temperatureC) || temperatureC < -80 || temperatureC > 80) continue;

    observations.push({
      dataset_key: DATASET_KEY,
      observed_on: observedOn,
      temperature_c: temperatureC,
      quality_code: columns[4]?.trim() || null,
    });
  }

  if (observations.length === 0) {
    throw new Error("SMHI CSV did not contain any daily temperature observations");
  }
  return observations;
}

async function callerIsStaff(
  request: Request,
  serviceClient: ReturnType<typeof createClient>,
): Promise<boolean> {
  const caller = await resolveCaller(request);
  if (!caller) return false;
  const { data } = await serviceClient
    .from("staff_users")
    .select("user_id")
    .eq("user_id", caller.userId)
    .maybeSingle();
  return Boolean(data);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase service configuration is missing" }, 500);
  }
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  let force = false;
  if (request.method === "POST") {
    try {
      const body = await request.json();
      force = body?.force === true;
    } catch {
      force = false;
    }
  }

  let claimed = false;
  try {
    if (force && !(await callerIsStaff(request, serviceClient))) {
      return jsonResponse({ error: "Forced weather refresh is staff-only" }, 403);
    }

    const { data: claimResult, error: claimError } = await serviceClient.rpc(
      "claim_energy_weather_sync",
      { p_dataset_key: DATASET_KEY, p_force: force },
    );
    if (claimError) throw claimError;
    if (!claimResult) {
      return jsonResponse({ synced: false, reason: "fresh_or_in_progress" });
    }
    claimed = true;

    const [archiveCsv, recentCsv] = await Promise.all([
      fetchCsv(ARCHIVE_URL),
      fetchCsv(RECENT_URL),
    ]);
    const observationsByDate = new Map<string, WeatherObservation>();
    for (const observation of parseSmhiDailyMeanCsv(archiveCsv)) {
      observationsByDate.set(observation.observed_on, observation);
    }
    for (const observation of parseSmhiDailyMeanCsv(recentCsv)) {
      observationsByDate.set(observation.observed_on, observation);
    }
    const observations = Array.from(observationsByDate.values()).sort((a, b) =>
      a.observed_on.localeCompare(b.observed_on)
    );

    for (let index = 0; index < observations.length; index += UPSERT_CHUNK_SIZE) {
      const chunk = observations.slice(index, index + UPSERT_CHUNK_SIZE);
      const { error: upsertError } = await serviceClient
        .from("energy_weather_observations")
        .upsert(chunk, { onConflict: "dataset_key,observed_on" });
      if (upsertError) throw upsertError;
    }

    const lastObservationDate = observations.at(-1)?.observed_on ?? null;
    const { error: metadataError } = await serviceClient
      .from("energy_weather_datasets")
      .update({
        last_synced_at: new Date().toISOString(),
        last_observation_date: lastObservationDate,
        sync_started_at: null,
        sync_error: null,
      })
      .eq("dataset_key", DATASET_KEY);
    if (metadataError) throw metadataError;

    return jsonResponse({
      synced: true,
      dataset_key: DATASET_KEY,
      observation_count: observations.length,
      last_observation_date: lastObservationDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claimed) {
      await serviceClient
        .from("energy_weather_datasets")
        .update({ sync_started_at: null, sync_error: message })
        .eq("dataset_key", DATASET_KEY);
    }
    console.error("Shared weather history sync failed:", error);
    return jsonResponse({ error: message }, 500);
  }
});
