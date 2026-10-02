// Where the planner's demand evidence comes from.
//
// The server provides it, from what this home's own forecasts said and what the
// house then drew (`energy_optimisation_demand_days`). The planner levels the
// base-load forecast to it and sizes its demand margin from it
// (planner/demand-outlook.ts). A home without enough matured days, or a read
// that fails, plans on the forecast as given.

import type { DemandDay } from "./planner/demand-outlook.ts";

/** The home's matured days before `until`, oldest first, or null when they cannot be read. */
export async function demandDays(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  homeId: string,
  timezone: string,
  until: string,
): Promise<DemandDay[] | null> {
  try {
    const { data, error } = await supabase.rpc("energy_optimisation_demand_days", {
      p_home_id: homeId, p_timezone: timezone, p_until: until,
    });
    if (error) {
      console.error("[DEMAND-EVIDENCE] not read", error);
      return null;
    }
    return ((data ?? []) as { day: string; forecast_kwh: number | string; actual_kwh: number | string }[])
      .map((row) => ({ day: row.day, forecast_kwh: Number(row.forecast_kwh), actual_kwh: Number(row.actual_kwh) }))
      .filter((row) => Number.isFinite(row.forecast_kwh) && Number.isFinite(row.actual_kwh));
  } catch (error) {
    console.error("[DEMAND-EVIDENCE] lookup failed", error);
    return null;
  }
}

/** The snapshot with the server's demand evidence, or without any when there is none. */
export async function withDemandOutlook<S extends { captured_at: string; timezone: string; demand_outlook?: unknown }>(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  homeId: string,
  snapshot: S,
): Promise<S> {
  // The evidence is the server's to provide; whatever a snapshot arrives with is dropped.
  const { demand_outlook: _ignored, ...without } = snapshot;
  const days = await demandDays(supabase, homeId, snapshot.timezone, snapshot.captured_at);
  if (!days?.length) return without as S;
  return { ...without, demand_outlook: { provider: "home_history", days } } as S;
}
