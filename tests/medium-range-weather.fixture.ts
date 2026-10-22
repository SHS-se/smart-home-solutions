export function mediumRangeWeatherFixture(times = ["2026-10-24T22:00", "2026-10-24T23:00", "2026-10-25T00:00", "2026-10-25T01:00", "2026-10-25T23:00"]) {
  return Array.from({ length: 10 }, (_, index) => ({
    latitude: 58.25 + index * 0.01, longitude: 13, elevation: index === 0 ? null : 66,
    utc_offset_seconds: 0, timezone: "GMT", timezone_abbreviation: "GMT", generationtime_ms: 4.77,
    hourly_units: { time: "iso8601", wind_speed_10m: "m/s", wind_speed_120m: "m/s", temperature_2m: "°C", shortwave_radiation: "W/m²" },
    hourly: { time: [...times], wind_speed_10m: times.map(() => 3.38) as (number | null)[],
      wind_speed_120m: times.map(() => 7.26), temperature_2m: times.map(() => 11),
      shortwave_radiation: times.map(() => 0) },
  }));
}
