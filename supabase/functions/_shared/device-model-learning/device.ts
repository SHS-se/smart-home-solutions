/** One variable-power device's operating points. Publication belongs to the fenced learning job. */
import { learnOperatingPoints, type DeviceQuarter } from "../device-learning/operating-points.ts";
import { readPagedRows } from "../read-paged-rows.ts";

export const DEVICE_LEARNING_METHOD = "device_operating_points_v1";
const WINDOW_DAYS = 90;
const SLOT_MS = 900_000;

/** Measured draw, and heat per kWh where metered, at each of the device's own settings. */
export async function fitStoredDevice(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  homeId: string,
  deviceKey: string,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const { data: device, error } = await supabase.from("energy_optimisation_devices")
    .select("id").eq("home_id", homeId).eq("device_key", deviceKey).maybeSingle();
  if (error) throw new Error(error.message);
  if (!device) throw new Error("Device is not in the home's inventory");
  const from = now - WINDOW_DAYS * 86_400_000;
  // A failed read is retried by the job; it is never a fit of no quarters.
  const rows = await readPagedRows<Record<string, unknown>>((fromRow, toRow) => supabase
    .from("energy_optimisation_device_slots")
    .select("start_ts, energy_kwh, power_setting, heat_kwh")
    .eq("home_id", homeId).eq("device_id", device.id).gte("start_ts", new Date(from).toISOString())
    .order("start_ts").range(fromRow, toRow));
  const number = (value: unknown) => value == null ? null : Number(value);
  const quarters = rows.flatMap((row): DeviceQuarter[] => {
    const kwh = Number(row.energy_kwh);
    return row.energy_kwh != null && Number.isFinite(kwh) ? [{ start_ms: Date.parse(String(row.start_ts)),
      device_key: deviceKey, energy_kwh: kwh, power_setting: number(row.power_setting), heat_kwh: number(row.heat_kwh) }] : [];
  });
  const at = new Date(now).toISOString();
  return {
    home_id: homeId, customer_id: customerId, device_key: deviceKey, fitted_at: at,
    operating_points: learnOperatingPoints(quarters, [deviceKey], [], from, Math.floor(now / SLOT_MS) * SLOT_MS),
    last_attempted_at: at, last_fit_attempt: { learning: { method: DEVICE_LEARNING_METHOD }, issues: [] },
  };
}
