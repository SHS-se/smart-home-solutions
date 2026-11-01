/** Independent station measurements. No range clipping, interpolation or provider substitution. */
import { ZONE_STATIONS } from "./market-wind.ts";
export const SMHI_DATASETS = [
  "smhi_wind_10m_observed",
  "smhi_temperature_2m_observed",
] as const;
export type SmhiDataset = typeof SMHI_DATASETS[number];
export type MeasuredVariable = "wind_speed_10m" | "temperature_2m";
export interface SmhiRequest {
  dataset: SmhiDataset;
  station_id: string;
  from: string;
  to: string;
}
export interface SmhiDocument {
  provider: "smhi";
  station_id: string;
  variable: MeasuredVariable;
  parameter: "4" | "1";
  unit: "m/s" | "°C";
  height_m: number;
  semantics: "preceding_10minute_mean" | "instant";
  updated: number;
  period: { from: number; to: number; key: string; sampling: string };
  positions: {
    from: number;
    to: number;
    latitude: number;
    longitude: number;
    height: number;
  }[];
  hours: {
    at: number;
    value: number | null;
    quality: string | null;
    conflict: boolean;
  }[];
}
const HOUR = 3_600_000;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid SMHI object");
  }
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid SMHI number");
  }
  return value;
}
function spec(dataset: SmhiDataset) {
  if (!SMHI_DATASETS.includes(dataset)) {
    throw new Error("Unsupported SMHI product");
  }
  return dataset === "smhi_wind_10m_observed"
    ? {
      parameter: "4" as const,
      variable: "wind_speed_10m" as const,
      unit: "m/s" as const,
      nativeUnit: "meter per sekund",
      height: 10,
      semantics: "preceding_10minute_mean" as const,
    }
    : {
      parameter: "1" as const,
      variable: "temperature_2m" as const,
      unit: "°C" as const,
      nativeUnit: "celsius",
      height: 2,
      semantics: "instant" as const,
    };
}
export function smhiObservationRequest(request: SmhiRequest): URL {
  if (!ZONE_STATIONS.SE3.some((s) => s.id === request.station_id)) {
    throw new Error("Unknown observation station");
  }
  const { parameter } = spec(request.dataset);
  const from = Date.parse(request.from), to = Date.parse(request.to);
  if (
    !Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
    from % HOUR || to % HOUR
  ) throw new Error("Invalid SMHI logical window");
  return new URL(
    `https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/${parameter}/station/${request.station_id}/period/latest-months/data.json`,
  );
}
export function parseSmhiObservations(
  value: unknown,
  request: SmhiRequest,
): SmhiDocument {
  smhiObservationRequest(request);
  const body = object(value),
    station = object(body.station),
    parameter = object(body.parameter),
    period = object(body.period),
    expected = spec(request.dataset);
  if (
    station.key !== request.station_id ||
    parameter.key !== expected.parameter ||
    parameter.unit !== expected.nativeUnit ||
    station.height !== expected.height || period.key !== "latest-months" ||
    typeof period.sampling !== "string"
  ) throw new Error("SMHI measurement identity does not match request");
  if (
    !Array.isArray(body.value) || !Array.isArray(body.position) ||
    !body.position.length
  ) throw new Error("Missing SMHI measurements or positions");
  const positions = body.position.map((value) => {
    const p = object(value);
    return {
      from: number(p.from),
      to: number(p.to),
      latitude: number(p.latitude),
      longitude: number(p.longitude),
      height: number(p.height),
    };
  });
  if (positions.some((p) => p.to < p.from)) {
    throw new Error("Invalid SMHI position window");
  }
  const from = Date.parse(request.from), to = Date.parse(request.to);
  const byTime = new Map<number, SmhiDocument["hours"][number]>();
  for (const raw of body.value) {
    const row = object(raw), at = number(row.date);
    if (at % HOUR) throw new Error("SMHI measurement is not hourly");
    if (at < from || at >= to) continue;
    if (
      !(row.value === null || typeof row.value === "string" ||
        typeof row.value === "number") ||
      !(row.quality === null || typeof row.quality === "string")
    ) throw new Error("Invalid SMHI value or quality flag");
    const value = row.value === null || row.value === ""
      ? null
      : Number(row.value);
    if (value !== null && !Number.isFinite(value)) {
      throw new Error("Invalid SMHI value");
    }
    const previous = byTime.get(at);
    const conflict = previous
      ? previous.conflict || previous.value !== value ||
        previous.quality !== row.quality
      : false;
    byTime.set(at, {
      at,
      value: conflict ? null : value,
      quality: conflict ? null : row.quality,
      conflict,
    });
  }
  return {
    provider: "smhi",
    station_id: request.station_id,
    parameter: expected.parameter,
    variable: expected.variable,
    unit: expected.unit,
    height_m: expected.height,
    semantics: expected.semantics,
    updated: number(body.updated),
    period: {
      key: "latest-months",
      from: number(period.from),
      to: number(period.to),
      sampling: period.sampling,
    },
    positions,
    hours: [...byTime.values()].sort((a, b) => a.at - b.at),
  };
}
