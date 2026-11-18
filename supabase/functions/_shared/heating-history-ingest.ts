import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { parseHeatingObservations, parseHeatingProbeObservations } from "./heating-observations.ts";

/** Learning receipts are independent of admission of the household plan. */
export async function ingestHeatingHistory(db: Pick<SupabaseClient, "rpc">, input: {
  homeId: string; customerId: string; fromMs: number; toMs: number;
  observations: unknown; probes: unknown;
}) {
  const measured = input.observations === undefined ? { observations: [], ignored: {} }
    : parseHeatingObservations(input.observations, input.fromMs, input.toMs);
  const probes = input.probes === undefined ? { observations: [], ignored: {} }
    : parseHeatingProbeObservations(input.probes, input.fromMs, input.toMs);
  const scope = { p_home_id: input.homeId, p_customer_id: input.customerId };
  const exchange: {
    heating_observations_accepted: number | null;
    heating_observations_accepted_by_source: { room_key: string; source_key: string; accepted: number }[] | null;
    heating_probe_observations_accepted: number | null;
    heating_history_sources?: unknown;
  } = { heating_observations_accepted: 0, heating_observations_accepted_by_source: [], heating_probe_observations_accepted: 0 };
  // A failed side of the capture keeps its app cursor pending. Known heat and
  // probe facts can still land independently and identical retries are safe.
  await Promise.all([
    (async () => {
      if (!measured.observations.length) return;
      try {
        const { data, error } = await db.rpc("record_energy_heating_observations", { ...scope, p_rows: measured.observations });
        if (error) throw error;
        exchange.heating_observations_accepted = data.accepted;
        exchange.heating_observations_accepted_by_source = data.accepted_by_source;
      } catch (error) {
        exchange.heating_observations_accepted = null;
        exchange.heating_observations_accepted_by_source = null;
        console.error("[ENERGY-OPTIMISATION] heating history write needs retry", error);
      }
    })(),
    (async () => {
      if (!probes.observations.length) return;
      try {
        const { data, error } = await db.rpc("record_energy_heating_probe_observations", { ...scope, p_rows: probes.observations });
        if (error) throw error;
        exchange.heating_probe_observations_accepted = data;
      } catch (error) {
        exchange.heating_probe_observations_accepted = null;
        console.error("[ENERGY-OPTIMISATION] heating probe history write needs retry", error);
      }
    })(),
    (async () => {
      try {
        const { data, error } = await db.rpc("get_energy_heating_history_sources", scope);
        if (error) throw error;
        exchange.heating_history_sources = data;
      } catch (error) {
        // Omission preserves the app's last known configuration; an empty
        // assignment list would incorrectly revoke reviewed source lineage.
        console.error("[ENERGY-OPTIMISATION] heating source sync needs retry", error);
      }
    })(),
  ]);
  return { exchange, ignored: { ...measured.ignored, ...probes.ignored } };
}
