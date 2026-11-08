import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";

const SLOT_MS = 900_000;
const AGGREGATION = "sum_of_recorder_5minute_changes";
const ENERGY_FIELDS = ["total_load_kwh", "solar_production_kwh", "grid_import_kwh", "grid_export_kwh",
  "pool_heating_kwh", "hot_water_kwh", "ev_charging_kwh", "battery_charge_kwh", "battery_discharge_kwh"] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const energy = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const powerSetting = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000;

/** History is evidence, not admission authority. Ignore individual bad rows. */
export function prepareActualUpload(rows: readonly unknown[], devices: ReadonlyMap<string, { id: string }>,
  context: { customer_id: string; home_id: string; device_token_id: string }, now: number): {
    actualRows: Record<string, unknown>[]; deviceSlotRows: Record<string, unknown>[];
    ignored: Record<string, number>; warnings: PlanningWarning[];
    /** Newest accepted quarter, household or device-only: the home's watermark. */
    accepted_until: string | null;
  } {
  const actualRows: Record<string, unknown>[] = [], deviceSlotRows: Record<string, unknown>[] = [];
  const ignored: Record<string, number> = {}, seen = new Set<number>();
  const ignore = (reason: string) => { ignored[reason] = (ignored[reason] ?? 0) + 1; };
  const latest = Math.floor(now / SLOT_MS) * SLOT_MS - SLOT_MS, earliest = latest - 8 * 86_400_000;
  let latestAccepted: number | null = null;
  for (const item of rows) {
    if (!record(item)) { ignore("invalid_actual"); continue; }
    const start = Date.parse(String(item.start ?? ""));
    if (!Number.isFinite(start) || start % SLOT_MS !== 0) { ignore("invalid_actual_start"); continue; }
    if (start < earliest) { ignore("outside_history_window"); continue; }
    if (start > latest) { ignore("incomplete_or_future_actual"); continue; }
    if (seen.has(start)) { ignore("duplicate_actual_start"); continue; }
    if (!record(item.quality) || item.quality.aggregation !== AGGREGATION || item.quality.duration_seconds !== 900) {
      ignore("invalid_actual_quality"); continue;
    }
    const values = ENERGY_FIELDS.map(key => item[key]);
    if (values.some(v => v != null && !energy(v))) { ignore("invalid_actual_energy"); continue; }
    const deviceEnergy = item.device_energy_kwh ?? {};
    // A quarter with device energy but no household meter reading is still
    // device evidence: it is stored without a household row.
    const householdRow = values.some(v => v != null);
    if (!householdRow && !(record(deviceEnergy) && Object.keys(deviceEnergy).length)) { ignore("empty_actual_slot"); continue; }
    seen.add(start);
    const quality = { aggregation: AGGREGATION, duration_seconds: 900 };
    const startTs = new Date(start).toISOString();
    if (householdRow) {
      const row: Record<string, unknown> = { ...context, start_ts: startTs, quality };
      for (const field of ENERGY_FIELDS) row[field] = item[field] == null ? null : round(item[field] as number);
      for (const field of ["battery_soc", "ev_soc"]) {
        const v = item[field];
        row[field] = typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? round(v) : null;
        if (v != null && row[field] === null) ignore("invalid_actual_soc");
      }
      actualRows.push(row);
    }
    if (!record(deviceEnergy)) { ignore("invalid_device_energy"); continue; }
    // A pool device's own power setting and metered heat ride on its quarter.
    // An unusable one is not observed; it never costs the quarter's energy.
    const settings = record(item.device_power_setting) ? item.device_power_setting : {};
    const heat = record(item.device_heat_kwh) ? item.device_heat_kwh : {};
    if (item.device_power_setting != null && !record(item.device_power_setting)) ignore("invalid_device_setting");
    if (item.device_heat_kwh != null && !record(item.device_heat_kwh)) ignore("invalid_device_heat");
    let accepted = householdRow;
    for (const [key, value] of Object.entries(deviceEnergy)) {
      const device = devices.get(key);
      if (!device || !energy(value)) { ignore("invalid_device_energy"); continue; }
      const setting = settings[key], metered = heat[key];
      if (setting != null && !powerSetting(setting)) ignore("invalid_device_setting");
      if (metered != null && !energy(metered)) ignore("invalid_device_heat");
      deviceSlotRows.push({ ...context, device_id: device.id, start_ts: startTs, energy_kwh: round(value),
        power_setting: powerSetting(setting) ? setting : null, heat_kwh: energy(metered) ? round(metered) : null, quality });
      accepted = true;
    }
    if (accepted && (latestAccepted === null || start > latestAccepted)) latestAccepted = start;
  }
  actualRows.sort((a, b) => Date.parse(String(a.start_ts)) - Date.parse(String(b.start_ts)));
  const warnings = Object.entries(ignored).map(([code, count]) => planningWarning(code, "history_upload",
    `${count} historical ${count === 1 ? "item was" : "items were"} ignored (${code.replaceAll("_", " ")}).`,
    "Usable history was retained and planning continues.", { count }, count >= 5 ? "error" : "warning"));
  return { actualRows, deviceSlotRows, ignored, warnings,
    accepted_until: latestAccepted === null ? null : new Date(latestAccepted).toISOString() };
}
