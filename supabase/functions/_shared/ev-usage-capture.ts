import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { EV_USAGE_HISTORY_DAYS, fitWeekdayEvUsage, type EvUsageQuarter } from "./planner/ev-usage.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { localDay } from "./planner-wasm/calendar.ts";

/** Read the measured archive at admission. The frozen capture carries just seven averages. */
export async function captureEvUsage(database: Pick<SupabaseClient, "rpc">, homeId: string,
  snapshot: OptimisationSnapshot) {
  const car = snapshot.ev_battery;
  if (!car || !Number.isFinite(car.capacity_kwh) || car.capacity_kwh <= 0 ||
    !Number.isFinite(car.charge_efficiency) || car.charge_efficiency <= 0 || car.charge_efficiency > 1) {
    return { usage: null, warnings: [] };
  }
  const capture = Date.parse(snapshot.captured_at);
  const unavailable = () => ({ usage: null, warnings: [planningWarning("ev_usage_history_unavailable", "ev",
    "Past car battery use could not be estimated.", "The car’s charge readiness still guides charging.")] });
  try {
    const { data, error } = await database.rpc("get_energy_ev_usage_history", { p_home_id: homeId,
      // Include the UTC offset at either end of the requested local dates.
      p_from: new Date(capture - (EV_USAGE_HISTORY_DAYS + 2) * 86_400_000).toISOString(), p_to: snapshot.captured_at });
    if (error || !Array.isArray(data)) return unavailable();
    const { usage, gaps, late } = fitWeekdayEvUsage(data as EvUsageQuarter[], capture, at => localDay(at, snapshot.timezone), car);
    const warnings: PlanningWarning[] = [];
    if (late) warnings.push(planningWarning("ev_usage_history_late", "ev", "The newest car measurements are still arriving.",
      "The driving estimate uses earlier measurements."));
    if (!usage && gaps === 0 && late) return { usage, warnings };
    if (!usage) return unavailable();
    const pooledDays = usage.days.filter(count => count === 0).length;
    if (gaps || pooledDays) warnings.push(planningWarning("ev_usage_history_estimated", "ev", "The car’s driving history has incomplete coverage.",
      "The planner estimates battery use from the available days and uses their overall average for weekdays without evidence.",
      { incomplete_days: gaps, weekdays_without_observations: pooledDays }));
    return { usage, warnings };
  } catch {
    return unavailable();
  }
}
