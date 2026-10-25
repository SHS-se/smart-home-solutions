/** Room-only observation loading. Unknown meter coverage is never an OFF sample. */
import { fitRoomsFromQuarters, TRAINING_WINDOW_DAYS, zoneModelRows, type ThermalQuarterRow } from "../thermal-training.ts";
import { fitRoomMeans } from "../device-learning/room/mean-observations.ts";
import { readPagedRows } from "../read-paged-rows.ts";
import { irradiancePoints, irradianceOnto } from "../solar-irradiance.ts";

export async function fitStoredRoom(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string,
  location: { latitude: number; longitude: number } | null,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const trainingTo = new Date(now).toISOString();
  const trainingFrom = new Date(Date.parse(trainingTo) - TRAINING_WINDOW_DAYS * 86_400_000).toISOString();
  if (location) {
    const points = await irradiancePoints({ supabase: db, ...location });
    if (points) {
      const { data, error } = await db.from("energy_optimisation_outdoor_slots")
        .select("customer_id, home_id, start_ts, temperature_c, device_token_id")
        .eq("home_id", homeId).is("solar_w_per_m2", null).gte("start_ts", trainingFrom).lt("start_ts", trainingTo)
        .order("start_ts").limit(250);
      if (error) throw new Error(error.message);
      const solar = irradianceOnto(points, (data ?? []).map((row: { start_ts: string }) => row.start_ts));
      const rows = (data ?? []).map((row: Record<string, unknown>, i: number) => ({ ...row, solar_w_per_m2: solar[i] }))
        .filter((row: { solar_w_per_m2: number | null }) => row.solar_w_per_m2 !== null);
      if (rows.length) {
        const { error } = await db.from("energy_optimisation_outdoor_slots").upsert(rows, { onConflict: "home_id,start_ts" });
        if (error) throw new Error(error.message);
      }
    }
  }
  const quarters = await readPagedRows<ThermalQuarterRow>((from, to) => db.rpc("get_energy_thermal_training_quarters", {
    p_customer_id: customerId, p_home_id: homeId, p_from: trainingFrom, p_to: trainingTo,
  }).eq("room_key", roomKey).range(from, to));
  // A missing series is a statistical observation outcome, not a transport failure.
  if (!quarters.length) {
    const { data, error } = await db.from("energy_optimisation_devices").select("mapping_summary")
      .eq("home_id", homeId).eq("mapping_summary->>room_key", roomKey).is("retired_at", null).limit(1);
    if (error) throw new Error(error.message);
    const roomName = data?.[0]?.mapping_summary?.room_name;
    if (!roomName) throw new Error("Learning room no longer has a mapped device");
    return zoneModelRows([{ room_key: roomKey, room_name: roomName,
      result: fitRoomMeans([], null) }],
    { homeId, customerId, trainingFrom, trainingTo })[0];
  }
  const fits = fitRoomsFromQuarters(quarters);
  if (fits.length !== 1 || fits[0].room_key !== roomKey) throw new Error("Room observations crossed owner boundary");
  return zoneModelRows(fits, { homeId, customerId, trainingFrom, trainingTo })[0];
}
