import { readWeatherHeating, WEATHER_HEATING_METHOD } from "../planner/weather-heating.ts";
import { fitWeatherHeating, type HeatingDay } from "../device-learning/weather-heating.ts";
import type { ModelDatabase } from "../device-model-store.ts";

export async function fitStoredWeatherHeating(db: ModelDatabase, homeId: string, customerId: string,
  key: string, binding: string, previous: unknown, now: number): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc("get_energy_weather_heating_days", {
    p_home_id: homeId, p_customer_id: customerId, p_device_key: key, p_binding: binding,
    p_from: new Date(now - 400 * 86_400_000).toISOString(), p_to: new Date(now).toISOString(),
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) throw new Error("Malformed heating observations");
  const profile = fitWeatherHeating(binding, data as HeatingDay[]);
  const limited = profile.points.length < 2;
  const at = new Date(now).toISOString();
  return {
    home_id: homeId, customer_id: customerId, device_key: key, fitted_at: at,
    operating_points: limited ? readWeatherHeating(previous, binding) ?? profile : profile,
    last_attempted_at: at, last_fit_attempt: { learning: { method: WEATHER_HEATING_METHOD },
      issues: limited ? ["insufficient_outdoor_coverage"] : [] },
  };
}
