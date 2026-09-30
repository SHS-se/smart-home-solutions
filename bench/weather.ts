// Archived weather for test cases whose replay carries none.
//
// A replay stores the snapshot before the server adds weather, so most carry
// no outdoor temperature, and the pool cannot be planned against the weather
// the home had. Open-Meteo keeps the forecasts it issued (its Previous Runs
// API), so each quarter gets roughly the forecast available when the case was
// captured: a quarter a day ahead of the capture reads the forecast issued a
// day before it, and so on. Fetched once per case and stored with it
// (bench_scenarios.weather), so every run of a case sees the same weather.
//
// Open-Meteo's free API is for non-commercial use. Set OPEN_METEO_API_KEY to
// use the commercial one.

import type { BenchWeather } from "./household.ts";

const HOUR_MS = 3_600_000;
const SLOT_MS = 15 * 60_000;
/** Previous Runs offers forecasts issued up to seven days ahead; a 72-hour plan needs three. */
const MAX_LEAD_DAYS = 3;

interface Hourly {
  time: string[];
  [variable: string]: (number | null)[] | string[];
}

const leadVariable = (base: string, days: number) => days === 0 ? base : `${base}_previous_day${days}`;

export async function archivedWeather(
  location: { latitude: number; longitude: number },
  slotStarts: readonly string[],
  capturedAt: string,
): Promise<BenchWeather> {
  const first = Date.parse(slotStarts[0]);
  const last = Date.parse(slotStarts.at(-1)!) + SLOT_MS;
  const bases = ["temperature_2m", "shortwave_radiation"];
  const variables = bases.flatMap(base => Array.from({ length: MAX_LEAD_DAYS + 1 }, (_, d) => leadVariable(base, d)));
  const key = Deno.env.get("OPEN_METEO_API_KEY");
  const url = new URL(`https://${key ? "customer-" : ""}previous-runs-api.open-meteo.com/v1/forecast`);
  url.search = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude),
    start_date: new Date(first - HOUR_MS).toISOString().slice(0, 10),
    end_date: new Date(last + HOUR_MS).toISOString().slice(0, 10),
    hourly: variables.join(","), timezone: "GMT",
    ...(key ? { apikey: key } : {}),
  }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const hourly = (await response.json()).hourly as Hourly;
  const hours = hourly.time.map(t => Date.parse(`${t}Z`));
  const captured = Date.parse(capturedAt);

  /** The forecast for instant `ms` issued about `lead` days before it, falling back to nearer leads. */
  const at = (base: string, index: number, ms: number) => {
    const lead = Math.min(MAX_LEAD_DAYS, Math.max(0, Math.round((ms - captured) / (24 * HOUR_MS))));
    for (let days = lead; days >= 0; days--) {
      const value = (hourly[leadVariable(base, days)] as (number | null)[])[index];
      if (typeof value === "number") return value;
    }
    throw new Error(`Open-Meteo has no ${base} for ${new Date(ms).toISOString()}`);
  };
  const hourIndex = (ms: number) => {
    const index = hours.findIndex(h => h >= ms);
    if (index < 0) throw new Error(`Open-Meteo stops before ${new Date(ms).toISOString()}`);
    return index;
  };

  const temperature: number[] = [];
  const irradiance: number[] = [];
  for (const start of slotStarts) {
    const mid = Date.parse(start) + SLOT_MS / 2;
    // Temperature is an instant: interpolate between the hours either side.
    const after = hourIndex(mid);
    const before = Math.max(0, after - 1);
    const span = hours[after] - hours[before];
    const weight = span ? (mid - hours[before]) / span : 0;
    const t = at("temperature_2m", before, mid) * (1 - weight) + at("temperature_2m", after, mid) * weight;
    temperature.push(Math.round(t * 100) / 100);
    // Radiation is the mean of the hour ending at its timestamp.
    irradiance.push(Math.max(0, at("shortwave_radiation", after, mid)));
  }
  return {
    source: `open-meteo previous runs${key ? " (commercial)" : ""}`,
    fetched_at: new Date().toISOString(),
    outdoor_temperature_c: temperature,
    solar_irradiance_w_per_m2: irradiance,
  };
}
