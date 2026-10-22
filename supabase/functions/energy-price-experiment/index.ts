/** TEST-only paired shadow prices. No provider calls or household plan writes. */
import { buildPricePair, type PricePairForecast, type PricePairInput } from "../_shared/price-pair.ts";
import type { EntsoeInterval } from "../_shared/entsoe-market-data.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
export interface PricePairReservation {
  id: string;
  status: "pending" | PricePairForecast["status"];
  context: Omit<PricePairInput, "actualIntervals"> & {
    homeId: string; mixRunId: string; origin: string;
    actualObservationId: string; priceCutoff: number;
  };
}
export interface PriceExperimentStore {
  verifyToken(token: string): Promise<boolean>;
  begin(): Promise<PricePairReservation | null>;
  actualIntervals(observationId: string): Promise<EntsoeInterval[]>;
  complete(id: string, forecast: PricePairForecast): Promise<void>;
}
export function createPriceExperimentHandler(
  projectUrl: string,
  store: PriceExperimentStore,
  calculate: typeof buildPricePair = buildPricePair,
) {
  return async (request: Request): Promise<Response> => {
    if (projectUrl !== TEST) return Response.json({ error: "test_lane_only" }, { status: 403 });
    if (request.method !== "POST") return Response.json({ error: "post_required" }, { status: 405 });
    const token = request.headers.get("x-energy-market-archive-token");
    if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      if (!await store.verifyToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const reservation = await store.begin();
      if (!reservation) return Response.json({ status: "no_generation_run" });
      if (reservation.status !== "pending") return Response.json({ id: reservation.id, status: "already_saved" });
      const actualIntervals = await store.actualIntervals(reservation.context.actualObservationId);
      const forecast = calculate({ ...reservation.context, actualIntervals });
      await store.complete(reservation.id, forecast);
      return Response.json({ id: reservation.id, status: forecast.status,
        targets: forecast.targets.length,
        paired_predictions: forecast.targets.filter(row => row.reduced !== null && row.full !== null).length });
    } catch {
      // Transport/DB exceptions can carry credentials. Log only this fixed code.
      console.error("test_price_experiment_failed");
      return Response.json({ error: "test_price_experiment_failed" }, { status: 500 });
    }
  };
}

if (import.meta.main) {
  const { createClient } = await import("@supabase/supabase-js");
  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const client = createClient(projectUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  Deno.serve(createPriceExperimentHandler(projectUrl, {
    async verifyToken(token) {
      const { data, error } = await client.rpc("verify_test_market_archive_token", { p_token: token });
      if (error) throw new Error("Price experiment authentication failed");
      return data === true;
    },
    async begin() {
      const { data, error } = await client.rpc("begin_test_price_pair");
      if (error) throw new Error("Price experiment reservation failed");
      return data;
    },
    async actualIntervals(observationId) {
      const { data, error } = await client.from("energy_market_forecast_observations")
        .select("dataset,result").eq("id", observationId).single();
      if (error || data.dataset !== "generation_actual") throw new Error("Pinned generation evidence unavailable");
      return data.result.status === "data" ? data.result.document.intervals : [];
    },
    async complete(id, forecast) {
      const { error } = await client.rpc("complete_test_price_pair", { p_id: id, p_forecast: forecast });
      if (error) throw new Error("Price experiment completion failed");
    },
  }));
}
