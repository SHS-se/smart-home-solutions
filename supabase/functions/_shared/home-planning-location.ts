import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { mergePlanningWarnings, planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { PROVIDER_TIMEOUT_MS } from "./weather-cache.ts";

export interface PlannerLocation {
  coordinates: { latitude: number; longitude: number } | null;
  warnings: PlanningWarning[];
}
const unresolved = (reason: string): PlannerLocation => ({ coordinates: null, warnings: [planningWarning(
  "planner_location_unresolved", "home", reason,
  "Planning continues using available measured demand. Update the installation address in the planner home selector if needed.")] });

/** Coordinates are derived exclusively from the selected planner home's address. */
export async function readPlannerLocation(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string,
  options: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<PlannerLocation> {
  try {
    const { data: home, error } = await db.from("homes").select("address_text").eq("id", homeId).single();
    if (error) return unresolved("The planner installation address could not be read.");
    const address = typeof home?.address_text === "string" ? home.address_text.trim().replace(/\s+/g, " ") : "";
    if (!address) return unresolved("The planner home has no installation address.");
    const { data: cached } = await db.from("energy_home_locations")
      .select("address_text,latitude,longitude").eq("home_id", homeId).maybeSingle();
    if (cached?.address_text === address && Number.isFinite(cached.latitude) && Number.isFinite(cached.longitude)) {
      return { coordinates: { latitude: cached.latitude, longitude: cached.longitude }, warnings: [] };
    }
    const url = new URL(options.endpoint ?? "https://photon.komoot.io/api/");
    url.searchParams.set("q", address);
    url.searchParams.set("limit", "1");
    const response = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { "User-Agent": "SmartHomeSolutions/1.0 (https://shs.se)", Accept: "application/json" } });
    if (!response.ok) return unresolved("The planner address location service is temporarily unavailable.");
    const body = await response.json();
    const point = body?.features?.[0]?.geometry?.coordinates;
    if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)
      || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return unresolved("The planner installation address could not be located.");
    const coordinates = { latitude: point[1], longitude: point[0] };
    const { error: saveError } = await db.from("energy_home_locations").upsert({
      home_id: homeId, address_text: address, ...coordinates, provider: "photon_openstreetmap",
      resolved_at: new Date().toISOString(),
    }, { onConflict: "home_id" });
    if (saveError) console.warn("[ENERGY-LOCATION] derived location could not be cached", { home_id: homeId });
    return { coordinates, warnings: [] };
  } catch {
    return unresolved("The planner installation location is temporarily unavailable.");
  }
}

/** Remove competing location authorities even when the address is unresolved. */
export function withPlannerLocation(snapshot: OptimisationSnapshot, result: PlannerLocation): OptimisationSnapshot {
  const { location: _incoming, ...source } = snapshot;
  return { ...source, ...(result.coordinates ? { location: result.coordinates } : {}),
    // Provider coordinates describe received PV evidence; they never choose
    // the planner's weather site and are never relabelled as another site.
    sources: source.sources,
    planning_warnings: mergePlanningWarnings(snapshot.planning_warnings, result.warnings) };
}
