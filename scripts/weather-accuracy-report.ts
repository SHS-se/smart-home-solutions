/** Reproducible all-retained-weather report. No provider or database writes. */
import {
  marketEvidenceClient,
  newPrivateEvidenceDirectory,
} from "./market-evidence-client.ts";
import {
  type WeatherForecastEvidence,
  type WeatherTruthEvidence,
  weatherValidation,
} from "../supabase/functions/_shared/weather-forecast-quality.ts";
import {
  marketDate,
  marketDaySpan,
} from "../supabase/functions/_shared/demand-forecast-quality.ts";
const out = await newPrivateEvidenceDirectory(
  Deno.args,
  "Usage: deno task research:weather:report --out NEW_PRIVATE_DIRECTORY",
);
const client = await marketEvidenceClient(),
  snapshot = await client.snapshot(),
  index = await client.index(snapshot.observation_ids);
const forecasts = index.filter((r) =>
  r.dataset === "weather_medium_range" && r.zone === "SE3" &&
  r.status === "data"
).sort((a, b) => a.sequence - b.sequence);
const selected = new Map<string, typeof forecasts[number]>();
for (const row of forecasts) {
  selected.set(marketDate(Date.parse(row.recorded_at)), row);
}
const forecastIds = [...selected.values()].map((r) => r.id);
const truthIds = index.filter((r) =>
  r.dataset.startsWith("smhi_") && r.status === "data"
).map((r) => r.id);
const truth = await client.documents<WeatherTruthEvidence>(truthIds);
const from = selected.size
  ? Math.min(...[...selected.keys()].map((day) => marketDaySpan(day)[0]))
  : marketDaySpan(marketDate(Date.parse(snapshot.at)))[0];
const to = marketDaySpan(marketDate(Date.parse(snapshot.at)))[0];
const validation = weatherValidation(truth, {
  from: from === to ? from - 86_400_000 : from,
  to,
});
for (let at = 0; at < forecastIds.length; at += 8) {
  validation.add(
    await client.documents<WeatherForecastEvidence>(
      forecastIds.slice(at, at + 8),
    ),
  );
}
await Deno.writeTextFile(
  `${out}/manifest.json`,
  JSON.stringify(
    { ...snapshot, forecast_ids: forecastIds, truth_ids: truthIds },
    null,
    2,
  ) + "\n",
);
await Deno.writeTextFile(
  `${out}/truth-evidence.json`,
  JSON.stringify(truth) + "\n",
);
const report = validation.result();
await Deno.writeTextFile(
  `${out}/report.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      out,
      forecast_origins: forecastIds.length,
      primary: report.cells.filter((c) => c.quality === "G"),
    },
    null,
    2,
  ),
);
