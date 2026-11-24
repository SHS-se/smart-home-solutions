import { readWeatherHeating, WEATHER_HEATING_METHOD } from "../planner/weather-heating.ts";
import { advanceWeatherHeatingBands, fitWeatherHeating, type HeatingDay } from "../device-learning/weather-heating.ts";
import { learnHeatPumpStartup, type HeatPumpInterval } from "../device-learning/heat-pump-startup.ts";
import type { ModelDatabase } from "../device-model-store.ts";

const HISTORY_DAYS = 400;

export async function fitStoredWeatherHeating(db: ModelDatabase, homeId: string, customerId: string,
  key: string, binding: string, previous: unknown, now: number, banded = false): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc("get_energy_weather_heating_days", {
    p_home_id: homeId, p_customer_id: customerId, p_device_key: key, p_binding: binding,
    p_from: new Date(now - HISTORY_DAYS * 86_400_000).toISOString(), p_to: new Date(now).toISOString(),
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) throw new Error("Malformed heating observations");
  const at = new Date(now).toISOString();
  const last = readWeatherHeating(previous, binding, banded);
  // Leave the newest completed UTC day time for the recorder to upload.
  const completedDay = new Date(now - 3 * 3_600_000).toISOString().slice(0, 10);
  const profile = banded ? advanceWeatherHeatingBands(binding, last, data as HeatingDay[], completedDay)
    : fitWeatherHeating(binding, data as HeatingDay[]);
  const limited = profile.points.length < (banded ? 1 : 2);
  const selected = !banded && limited && !last?.versioned ? last ?? profile : profile;
  // The start-up model sits beside the draw; a failed read keeps the last
  // one and never holds back the draw the planner uses.
  let heatPump: unknown = null, heatPumpIssue = false;
  try {
    heatPump = await fitHeatPump(db, homeId, customerId, key, now);
  } catch (error) {
    heatPumpIssue = true;
    heatPump = previous && typeof previous === "object" ? (previous as { heat_pump?: unknown }).heat_pump ?? null : null;
    console.warn("[ENERGY-LEARNING] heat pump start-up model not refitted", error instanceof Error ? error.message : error);
  }
  const issues = [...(limited ? ["insufficient_outdoor_coverage"] : []), ...(heatPumpIssue ? ["heat_pump_startup_unavailable"] : [])];
  return {
    home_id: homeId, customer_id: customerId, device_key: key, fitted_at: at,
    operating_points: heatPump ? { ...selected, heat_pump: heatPump } : selected,
    last_attempted_at: at, last_fit_attempt: { learning: { method: WEATHER_HEATING_METHOD }, issues },
  };
}

/** A room heater set up as an inverter load is a modulating heat pump; the read is null for any other device. */
async function fitHeatPump(db: ModelDatabase, homeId: string, customerId: string, key: string, now: number) {
  const { data, error: readError } = await db.rpc("get_energy_heat_pump_intervals", {
    p_home_id: homeId, p_customer_id: customerId, p_device_key: key,
    p_from: new Date(now - HISTORY_DAYS * 86_400_000).toISOString(), p_to: new Date(now).toISOString(),
  });
  if (readError) throw new Error(readError.message);
  if (data === null) return null;
  if (!Array.isArray(data)) throw new Error("Malformed heat pump intervals");
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const intervals = data.flatMap((row): HeatPumpInterval[] => {
    if (!Array.isArray(row)) return [];
    const [epoch, duration, energy, outdoor, peak, cooling] = row;
    const kwh = number(energy), at = number(epoch);
    return at !== null && kwh !== null && (duration === 900 || duration === 3600)
      ? [{ start_ms: at * 1000, duration_s: duration, energy_kwh: kwh, outdoor_c: number(outdoor), peak_w: number(peak),
        cooling: typeof cooling === "boolean" ? cooling : null }] : [];
  });
  return learnHeatPumpStartup(intervals, now);
}
