/** Independent weather scoring. Acquisition time, not historical response contents, defines a forecast. */
import type { MeasuredVariable, SmhiDocument } from "./smhi-observations.ts";
import type { MediumRangeWeatherDocument } from "./medium-range-weather.ts";
import { marketDate, marketDaySpan } from "./demand-forecast-quality.ts";
export const WEATHER_SCORER = "weather-accuracy-v1";
const HOUR = 3_600_000, DAY = 24 * HOUR;
export interface WeatherForecastEvidence {
  id: string;
  sequence: number;
  recorded_at: string;
  requested_from: string;
  requested_to: string;
  result: { status: string; document?: MediumRangeWeatherDocument };
}
export interface WeatherTruthEvidence {
  id: string;
  sequence: number;
  requested_from: string;
  requested_to: string;
  result: { status: string; document?: SmhiDocument };
}
export interface WeatherWindow {
  from: number;
  to: number;
}
interface Sum {
  expected: number;
  matched: number;
  absolute: number;
  squared: number;
  signed: number;
  missing_forecast: number;
  missing_truth: number;
  other_quality: number;
  unknown_quality: number;
  conflicts: number;
  site_mismatch: number;
}
interface WeatherDay extends Sum {
  observation_id: string;
  truth_ids: string[];
  variable: MeasuredVariable;
  station_id: string;
  quality: "G" | "Y";
  origin_day: string;
  target_day: string;
  lead_day: number;
}
const empty = (): Sum => ({
  expected: 0,
  matched: 0,
  absolute: 0,
  squared: 0,
  signed: 0,
  missing_forecast: 0,
  missing_truth: 0,
  other_quality: 0,
  unknown_quality: 0,
  conflicts: 0,
  site_mismatch: 0,
});
function metrics(s: Sum) {
  return {
    ...s,
    mae: s.matched ? s.absolute / s.matched : null,
    rmse: s.matched ? Math.sqrt(s.squared / s.matched) : null,
    bias: s.matched ? s.signed / s.matched : null,
  };
}
/** Stream bounded pages of forecasts through one truth timeline; raw documents need not accumulate. */
export function weatherValidation(
  truth: readonly WeatherTruthEvidence[],
  window: WeatherWindow,
) {
  if (window.to <= window.from || window.from % HOUR || window.to % HOUR) {
    throw new Error("Invalid weather evaluation window");
  }
  type Held = {
    id: string;
    document: SmhiDocument;
    point?: SmhiDocument["hours"][number];
  };
  const timeline = new Map<string, Map<number, Held>>();
  for (const row of [...truth].sort((a, b) => a.sequence - b.sequence)) {
    if (row.result.status !== "data" || !row.result.document) continue;
    const doc = row.result.document, key = `${doc.station_id}/${doc.variable}`;
    const hours = timeline.get(key) ?? new Map<number, Held>();
    timeline.set(key, hours);
    const from = Math.max(window.from, Date.parse(row.requested_from)),
      to = Math.min(window.to, Date.parse(row.requested_to));
    for (let at = from; at < to; at += HOUR) {
      hours.set(at, { id: row.id, document: doc });
    }
    for (const point of doc.hours) {
      if (point.at >= from && point.at < to) {
        hours.set(point.at, { id: row.id, document: doc, point });
      }
    }
  }
  const days: WeatherDay[] = [], seenOrigins = new Set<string>();
  const provenance = new Map<
    string,
    {
      requested: object;
      grid: object;
      measurement_height_m: number;
      measurement_semantics: string;
    }
  >();
  return {
    add(forecasts: readonly WeatherForecastEvidence[]) {
      for (const row of forecasts) {
        if (row.result.status !== "data" || !row.result.document) continue;
        const known = Date.parse(row.recorded_at),
          originDay = marketDate(known),
          doc = row.result.document;
        // Selection belongs to the frozen manifest. Reject duplicate origin dates across pages rather than counting correlated downloads twice.
        if (seenOrigins.has(originDay)) {
          throw new Error("Weather manifest has duplicate origin dates");
        }
        seenOrigins.add(originDay);
        for (let lead = 1; lead <= 7; lead++) {
          const day = new Date(Date.parse(originDay) + lead * DAY).toISOString()
              .slice(0, 10),
            [start, end] = marketDaySpan(day);
          if (
            start < known || start < window.from || end > window.to ||
            end > Date.parse(row.requested_to)
          ) continue;
          for (const site of doc.sites) {
            const indexes = new Map(
              site.times.map((time, i) => [Date.parse(time), i]),
            );
            for (
              const variable of ["wind_speed_10m", "temperature_2m"] as const
            ) {
              for (const quality of ["G", "Y"] as const) {
                const sum: WeatherDay = {
                  ...empty(),
                  observation_id: row.id,
                  truth_ids: [],
                  variable,
                  station_id: site.station_id,
                  quality,
                  origin_day: originDay,
                  target_day: day,
                  lead_day: lead,
                };
                const truthIds = new Set<string>();
                for (let at = start; at < end; at += HOUR) {
                  sum.expected++;
                  const i = indexes.get(at),
                    predicted = i === undefined
                      ? null
                      : site.series[variable][i];
                  if (predicted === null || predicted === undefined) {
                    sum.missing_forecast++;
                    continue;
                  }
                  const held = timeline.get(`${site.station_id}/${variable}`)
                    ?.get(at);
                  if (held) truthIds.add(held.id);
                  if (held?.point?.conflict) {
                    sum.conflicts++;
                    continue;
                  }
                  if (
                    held?.point?.value === null ||
                    held?.point?.value === undefined
                  ) {
                    sum.missing_truth++;
                    continue;
                  }
                  const positions = held.document.positions.filter((p) =>
                    p.from <= at && p.to >= at
                  );
                  // Configured sites are published to four coordinate decimals. Do not join a station after relocation to another site.
                  if (
                    !positions.length ||
                    positions.some((p) =>
                      p.latitude.toFixed(4) !==
                        site.requested.latitude.toFixed(4) ||
                      p.longitude.toFixed(4) !==
                        site.requested.longitude.toFixed(4)
                    )
                  ) {
                    sum.site_mismatch++;
                    continue;
                  }
                  if (!["G", "Y"].includes(held.point.quality ?? "")) {
                    sum.unknown_quality++;
                    continue;
                  }
                  if (held.point.quality !== quality) {
                    sum.other_quality++;
                    continue;
                  }
                  const error = predicted - held.point.value;
                  sum.matched++;
                  sum.absolute += Math.abs(error);
                  sum.squared += error * error;
                  sum.signed += error;
                  provenance.set(`${site.station_id}/${variable}`, {
                    requested: site.requested,
                    grid: site.grid,
                    measurement_height_m: held.document.height_m,
                    measurement_semantics: held.document.semantics,
                  });
                }
                sum.truth_ids = [...truthIds].sort();
                days.push(sum);
              }
            }
          }
        }
      }
    },
    result() {
      const groups = new Map<string, WeatherDay[]>();
      for (const day of days) {
        const key =
          `${day.station_id}/${day.variable}/${day.quality}/D+${day.lead_day}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(day);
      }
      const cells = [...groups].map(([key, rows]) => {
        const sum = empty();
        for (const row of rows) {
          for (const name of Object.keys(sum) as (keyof Sum)[]) {
            sum[name] += row[name];
          }
        }
        const matched = rows.filter((r) => r.matched);
        return {
          key,
          station_id: rows[0].station_id,
          variable: rows[0].variable,
          quality: rows[0].quality,
          lead_day: rows[0].lead_day,
          origin_dates: new Set(matched.map((r) => r.origin_day)).size,
          target_dates: new Set(matched.map((r) => r.target_day)).size,
          complete_days: rows.filter((r) => r.matched === r.expected).length,
          ...metrics(sum),
        };
      });
      return {
        scorer_version: WEATHER_SCORER,
        window: {
          from: new Date(window.from).toISOString(),
          to: new Date(window.to).toISOString(),
        },
        policy:
          "Latest committed forecast per origin date; whole target day starts after acquisition. Exact hourly station/variable matches. Newest measurement scope replaces older omissions. G approved truth and Y diagnostics are separate.",
        limitations: [
          "Wind observations average the preceding ten minutes; model values are instantaneous grid values.",
          "Station and model grid locations/elevations differ; no correction is fitted.",
          "120 m wind and radiation have no direct measurement validation.",
          "Hourly model values are interpolated; overlapping origins and hours are correlated.",
        ],
        deterioration: {
          status: "not_calibrated",
          reason:
            "Short correlated history does not establish a reliable deterioration alert threshold.",
        },
        provenance: Object.fromEntries(provenance),
        cells,
        days: days.map((row) => ({ ...metrics(row), ...row })),
      };
    },
  };
}
