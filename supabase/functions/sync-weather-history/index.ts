import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const DATASET_KEY = "stockholm-taby";
const ARCHIVE_URL =
  "https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/2/station/98230/period/corrected-archive/data.csv";
const RECENT_URL =
  "https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/2/station/98230/period/latest-months/data.csv";
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
    headers: { "Content-Type": "application/json" },
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

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase service configuration is missing" }, 500);
  }
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const syncToken = request.headers.get("x-weather-sync-token");
  if (!syncToken) {
    return jsonResponse({ error: "Scheduled sync authorization is required" }, 401);
  }
  const { data: authorized, error: authorizationError } = await serviceClient.rpc(
    "verify_energy_weather_sync_token",
    { p_token: syncToken },
  );
  if (authorizationError) {
    console.error("Weather sync authorization failed:", authorizationError);
    return jsonResponse({ error: "Scheduled sync authorization failed" }, 500);
  }
  if (!authorized) {
    return jsonResponse({ error: "Scheduled sync authorization is invalid" }, 403);
  }

  let claimed = false;
  try {
    const { data: claimResult, error: claimError } = await serviceClient.rpc(
      "claim_energy_weather_sync",
      { p_dataset_key: DATASET_KEY },
    );
    if (claimError) throw claimError;
    if (!claimResult) {
      return jsonResponse({ synced: false, reason: "fresh_or_in_progress" });
    }
    claimed = true;

    const { count: existingObservationCount, error: countError } =
      await serviceClient
        .from("energy_weather_observations")
        .select("id", { count: "exact", head: true })
        .eq("dataset_key", DATASET_KEY);
    if (countError) throw countError;
    if (existingObservationCount === null) {
      throw new Error("Weather observation count was not returned");
    }

    const sourceUrls = existingObservationCount === 0
      ? [ARCHIVE_URL, RECENT_URL]
      : [RECENT_URL];
    const csvFiles = await Promise.all(sourceUrls.map(fetchCsv));
    const observationsByDate = new Map<string, WeatherObservation>();
    for (const csvFile of csvFiles) {
      for (const observation of parseSmhiDailyMeanCsv(csvFile)) {
        observationsByDate.set(observation.observed_on, observation);
      }
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
      upserted_observation_count: observations.length,
      last_observation_date: lastObservationDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claimed) {
      // Keep the claim timestamp as a retry cooldown after failures.
      await serviceClient
        .from("energy_weather_datasets")
        .update({ sync_error: message })
        .eq("dataset_key", DATASET_KEY);
    }
    console.error("Shared weather history sync failed:", error);
    return jsonResponse({ error: message }, 500);
  }
});
