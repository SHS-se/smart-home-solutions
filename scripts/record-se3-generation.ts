/** Materialize one regional generation forecast in TEST. Both issue paths freeze their inputs. */
import {
  forecastRegionalGeneration,
  REGIONAL_GENERATION_ALGORITHM,
} from "../supabase/functions/_shared/generation-mix.ts";
import { marketDate, marketDaySpan } from "../supabase/functions/_shared/demand-forecast-quality.ts";
import type { EntsoeInterval } from "../supabase/functions/_shared/entsoe-market-data.ts";
import type { RegionalWeatherHour } from "../supabase/functions/_shared/price-weather.ts";

const TEST = "vxqpgbzseckgceopitpm";
const HOUR = 3_600_000;
const iso = (time: number) => new Date(time).toISOString();
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const json = (value: unknown) => literal(JSON.stringify(value)) + "::jsonb";

async function query<T>(sql: string): Promise<T[]> {
  const result = await new Deno.Command("supabase", {
    args: ["db", "query", "--linked", "--project-ref", TEST, "--output-format", "json", sql],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("TEST database query failed");
  return JSON.parse(new TextDecoder().decode(result.stdout)).rows;
}

interface Weather {
  forecast_cycle: string;
  history: RegionalWeatherHour[];
  forecast: RegionalWeatherHour[];
}
function validHours(rows: unknown): rows is RegionalWeatherHour[] {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row =>
    Array.isArray(row) && row.length === 4 && row.every(Number.isFinite) && row[0] % HOUR === 0);
}

const [source, command, date, path] = Deno.args;
const reconstructed = command === "--reconstruct";
if (!(source === "ecmwf" || source === "gfs") ||
  !(Deno.args.length === 1 || (reconstructed && Deno.args.length === 4 && /^\d{4}-\d{2}-\d{2}$/.test(date)))) {
  throw new Error("Usage: record-se3-generation.ts ecmwf|gfs [--reconstruct YYYY-MM-DD WEATHER_JSON]");
}

const now = Date.now();
const day = reconstructed ? date : marketDate(now);
if (reconstructed && (day >= marketDate(now) || day < "2026-10-19")) throw new Error("Expected a past issue day from 19 October 2026");
const [, nextMidnight] = marketDaySpan(day);
const issueTime = nextMidnight - 9 * HOUR;
if (!reconstructed && now < issueTime) Deno.exit();
const origin = reconstructed ? issueTime : now;

const daySql = literal(day) + "::date";
const sourceSql = literal(source);
const issuedSql = literal(iso(origin)) + "::timestamptz";
const [status] = await query<{ enabled: boolean; saved: boolean }>(`
  SELECT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) AS enabled,
    EXISTS(SELECT 1 FROM private.test_se3_generation_forecasts WHERE source=${sourceSql} AND origin_day=${daySql}) AS saved;
`);
if (!status?.enabled) throw new Error("TEST market archive is disabled");
if (status.saved) Deno.exit();

const [actuals] = await query<{ id: string; intervals: EntsoeInterval[] }>(`
  SELECT id,result->'document'->'intervals' AS intervals FROM public.energy_market_forecast_observations
  WHERE dataset='generation_actual' AND zone='SE3' AND result->>'status'='data'
    AND requested_to-requested_from=interval '28 days'
    AND requested_from<${issuedSql} AND requested_to>${issuedSql}-interval '2 days'
    AND (${reconstructed} OR recorded_at<=${issuedSql})
    AND jsonb_array_length(result->'document'->'intervals')>0
  ORDER BY (recorded_at<=${issuedSql}) DESC,
    CASE WHEN recorded_at<=${issuedSql} THEN sequence ELSE -sequence END DESC LIMIT 1;
`);
if (!actuals?.intervals.length) throw new Error("No archived SE3 production history for this issue");

const [live] = reconstructed ? [] : await query<Weather & { collected_at: string }>(`
  SELECT forecast_cycle,collected_at,history,forecast FROM public.energy_price_weather_feeds
  WHERE source=${sourceSql} AND collected_at<=${issuedSql};
`);
if (!reconstructed && !live) throw new Error("No live regional weather available");
const weather: Weather = live ?? JSON.parse(await Deno.readTextFile(path));
const cycle = Date.parse(weather.forecast_cycle);
if (!Number.isFinite(cycle) || marketDate(cycle) !== day || cycle > origin ||
  (reconstructed && cycle !== Date.parse(day + "T00:00:00Z")) ||
  !validHours(weather.history) || !validHours(weather.forecast) ||
  weather.forecast.some(row => row[0] < cycle)) throw new Error("Regional weather does not match the requested issue day");

const history = weather.history.filter(([at]) => at >= origin - 28 * 24 * HOUR && at <= origin);
const forecast = weather.forecast;
const hours = forecastRegionalGeneration({ origin, actuals: actuals.intervals, weather: { history, forecast } });
if (hours.some(({ mw }) => mw.B19 === null || mw.B16 === null)) throw new Error("Wind and solar weather must cover both delivery dates");
const series = Object.fromEntries(hours.map(({ at, mw }) => [at / 1000, mw]));
await query(`
  WITH saved AS (
    INSERT INTO private.test_se3_generation_forecasts
      (source,origin_day,issued_at,algorithm,reconstructed,weather_cycle,weather_collected_at,actuals_id,weather,hours)
    SELECT ${sourceSql},${daySql},${issuedSql},${literal(REGIONAL_GENERATION_ALGORITHM)},${reconstructed},
      ${literal(iso(cycle))},${live ? literal(live.collected_at) : "NULL"},${literal(actuals.id)},
      ${json({ history, forecast })},${json(series)}
    WHERE EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton)
    ON CONFLICT(source,origin_day) DO NOTHING RETURNING 1
  ) SELECT count(*) AS inserted FROM saved;
`);
console.log(`TEST ${source} SE3 ${day}: ${hours.length} delivery hours (${reconstructed ? "reconstructed" : "live"})`);
