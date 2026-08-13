// Price a home's already-recorded history, from the portal.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.6. The integration also sends
// prices, and for quarters it has seen that remains the source. This exists
// because prices only accumulate forward from the day the integration started
// sending them, while measured energy goes back 120 days — so the history tab
// showed kWh with no cost for everything already recorded, which is precisely
// the window a planner is tuned against.
//
// Reproducing the price here means a second implementation of the grid tariff.
// That risk is answered structurally rather than argued away: _shared/
// energy-grid-pricing.ts is asserted against a fixture captured from the
// integration's own tariff.py, and the same fixture is asserted against the
// Python in the integration repository.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { resolveCaller } from "../_shared/staff-auth.ts";
import {
  currentGridPrices,
  GridTariffError,
  type GridPriceConfiguration,
  type GridTariffCatalogue,
} from "../_shared/energy-grid-pricing.ts";
import {
  calculateSupplierPrice,
  parseSpotPriceIntervals,
} from "../_shared/energy-supplier-pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SPOT_SOURCE = "https://www.elprisetjustnu.se/api/v1/prices";
const AREAS = new Set(["SE1", "SE2", "SE3", "SE4"]);
const VALID_FUSES = new Set([16, 20, 25, 35, 50, 63]);
// Matches the retention on the quarters being priced; pricing further back has
// nothing to attach to.
const MAX_DAYS = 120;
// Spot days are fetched concurrently. Small enough to stay a polite neighbour
// to a free public API, large enough that 120 days is not a minute of waiting.
const FETCH_CONCURRENCY = 8;
const SLOT_MS = 15 * 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const round = (value: number, decimals = 6) => {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

const answerValue = (
  answer: { answer_value: unknown; answer_text: string | null } | undefined,
) => answer?.answer_value ?? answer?.answer_text ?? null;

const stockholmParts = (date: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );

const isoDate = (date: Date) => {
  const { year, month, day } = stockholmParts(date);
  return `${year}-${month}-${day}`;
};

const spotUrl = (localDate: string, area: string) => {
  const [year, month, day] = localDate.split("-");
  return `${SPOT_SOURCE}/${year}/${month}-${day}_${area}.json`;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const caller = await resolveCaller(req);
    if (!caller) return json({ error: "unauthorized" }, 401);

    let homeId = "";
    let days = 0;
    try {
      const body = await req.json();
      homeId = String(body?.home_id ?? "");
      days = Number(body?.days);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (!homeId || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return json({ error: "invalid_request" }, 400);
    }

    const { data: home, error: homeError } = await supabase
      .from("homes")
      .select("id, customer_id")
      .eq("id", homeId)
      .maybeSingle();
    if (homeError) throw homeError;
    if (!home) return json({ error: "home_not_found" }, 404);

    // Authorisation is the database's own rule rather than a second opinion
    // reimplemented here: the very predicate every RLS policy on this
    // customer's energy data uses. It reads auth.uid(), so it has to run on a
    // client carrying the caller's token, not the service role.
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        auth: { persistSession: false },
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      },
    );
    const { data: allowed, error: accessError } = await callerClient.rpc(
      "can_access_energy_billing_customer",
      { _customer_id: home.customer_id },
    );
    if (accessError) throw accessError;
    if (allowed !== true) return json({ error: "forbidden" }, 403);

    // ── Supplier terms ───────────────────────────────────────────────────────
    const { data: questions, error: questionError } = await supabase
      .from("home_questions")
      .select("id, semantic_key")
      .in("semantic_key", [
        "electricity_supplier",
        "electricity_price_area",
        "main_fuse_a",
        "has_solar",
      ]);
    if (questionError) throw questionError;
    const { data: answers, error: answerError } = await supabase
      .from("home_answers")
      .select("question_id, answer_value, answer_text")
      .eq("home_id", homeId)
      .in("question_id", (questions ?? []).map((question) => question.id));
    if (answerError) throw answerError;
    const answersByQuestion = new Map(
      (answers ?? []).map((answer) => [answer.question_id, answer]),
    );
    const values = Object.fromEntries((questions ?? []).map((question) => [
      question.semantic_key,
      answerValue(answersByQuestion.get(question.id)),
    ]));

    const supplierKey = typeof values.electricity_supplier === "string"
      ? values.electricity_supplier.trim().toLowerCase()
      : "";
    const area = typeof values.electricity_price_area === "string"
      ? values.electricity_price_area.trim().toUpperCase()
      : "";
    const missingInputs = [
      ...(!supplierKey ? ["electricity_supplier"] : []),
      ...(!AREAS.has(area) ? ["electricity_price_area"] : []),
    ];
    if (missingInputs.length > 0) {
      return json({ error: "missing_inputs", missing_inputs: missingInputs }, 422);
    }

    const { data: profile, error: profileError } = await supabase
      .from("energy_supplier_profiles")
      .select("id")
      .eq("provider_key", supplierKey)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return json({ error: "supplier_not_supported" }, 422);
    const { data: supplierVersions, error: supplierVersionError } = await supabase
      .from("energy_supplier_versions")
      .select("revision, valid_from, valid_to, definition")
      .eq("profile_id", profile.id)
      .order("valid_from", { ascending: true });
    if (supplierVersionError) throw supplierVersionError;
    if (!supplierVersions?.length) {
      return json({ error: "supplier_terms_not_published" }, 422);
    }

    // ── Grid catalogue ───────────────────────────────────────────────────────
    const { data: settings, error: settingsError } = await supabase
      .from("energy_tariff_settings")
      .select(
        "profile_id, connection_type, grid_area, energy_tax_reduced, include_vat, export_vat_registered",
      )
      .eq("id", true)
      .maybeSingle();
    if (settingsError) throw settingsError;
    if (!settings) return json({ error: "grid_tariff_not_configured" }, 422);

    const { data: gridVersions, error: gridVersionError } = await supabase
      .from("energy_tariff_versions")
      .select("revision, valid_from, valid_to, calculation_model, definition")
      .eq("profile_id", settings.profile_id)
      .order("valid_from", { ascending: true });
    if (gridVersionError) throw gridVersionError;

    const fuse = Number(values.main_fuse_a);
    const productionEnabled = values.has_solar === true ||
      values.has_solar === "true";
    if (!VALID_FUSES.has(fuse)) {
      return json({ error: "missing_inputs", missing_inputs: ["main_fuse_a"] }, 422);
    }

    const configuration: GridPriceConfiguration = {
      profile_id: settings.profile_id,
      connection_type: "three_phase",
      fuse_a: fuse,
      grid_area: settings.grid_area,
      production_enabled: productionEnabled,
      energy_tax_reduced: settings.energy_tax_reduced,
      include_vat: settings.include_vat,
      export_vat_registered: settings.export_vat_registered,
    };
    const catalogue: GridTariffCatalogue = {
      timezone: "Europe/Stockholm",
      configuration,
      missing_inputs: [],
      profiles: [{
        id: settings.profile_id,
        versions: (gridVersions ?? []).map((version) => ({
          revision: version.revision,
          valid_from: version.valid_from,
          valid_to: version.valid_to,
          calculation_model: version.calculation_model,
          definition: version.definition as Record<string, unknown>,
        })),
      }],
    };

    // ── Walk the window ──────────────────────────────────────────────────────
    const now = new Date();
    const latestStart = Math.floor(now.getTime() / SLOT_MS) * SLOT_MS - SLOT_MS;
    const localDates: string[] = [];
    for (let back = days; back >= 0; back -= 1) {
      localDates.push(isoDate(new Date(now.getTime() - back * 86_400_000)));
    }

    const rows: Record<string, unknown>[] = [];
    const skipped: Array<{ date: string; reason: string }> = [];
    const pricedDates: string[] = [];

    for (let index = 0; index < localDates.length; index += FETCH_CONCURRENCY) {
      const batch = localDates.slice(index, index + FETCH_CONCURRENCY);
      const responses = await Promise.all(batch.map(async (localDate) => {
        try {
          const response = await fetch(spotUrl(localDate, area));
          if (!response.ok) {
            return { localDate, error: `spot ${response.status}` } as const;
          }
          return { localDate, intervals: parseSpotPriceIntervals(await response.json()) } as const;
        } catch (error) {
          return {
            localDate,
            error: error instanceof Error ? error.message : String(error),
          } as const;
        }
      }));

      for (const result of responses) {
        if ("error" in result) {
          skipped.push({ date: result.localDate, reason: result.error });
          continue;
        }
        const supplierVersion = supplierVersions.find((candidate) =>
          candidate.valid_from <= result.localDate &&
          (!candidate.valid_to || candidate.valid_to >= result.localDate)
        );
        if (!supplierVersion) {
          skipped.push({
            date: result.localDate,
            reason: "no supplier terms published for this date",
          });
          continue;
        }

        let priced = 0;
        let dayError: string | null = null;
        for (const interval of result.intervals) {
          const start = Date.parse(interval.time_start);
          if (!Number.isFinite(start) || start % SLOT_MS !== 0) continue;
          // A quarter that has not finished has no measured energy to price.
          if (start > latestStart) continue;
          const supplier = calculateSupplierPrice(
            interval,
            supplierVersion.definition,
          );
          let grid;
          try {
            grid = currentGridPrices(catalogue, new Date(start));
          } catch (error) {
            dayError = error instanceof GridTariffError
              ? error.message
              : String(error);
            break;
          }
          // Both halves or neither: a supplier price without its grid component
          // looks complete while understating the marginal cost by the transfer
          // and tax, and nothing downstream could detect that.
          if (grid === null) {
            dayError ??= "no grid tariff version covers this date";
            break;
          }
          rows.push({
            customer_id: home.customer_id,
            home_id: homeId,
            start_ts: new Date(start).toISOString(),
            import_price_sek_per_kwh: round(
              supplier.supplier_import_price_sek_per_kwh +
                grid.import_price_sek_per_kwh,
              5,
            ),
            export_price_sek_per_kwh: round(
              supplier.supplier_export_price_sek_per_kwh +
                grid.export_price_sek_per_kwh,
              5,
            ),
            source: "portal_backfill",
          });
          priced += 1;
        }
        if (dayError) skipped.push({ date: result.localDate, reason: dayError });
        else if (priced > 0) pricedDates.push(result.localDate);
      }
    }

    // Written in chunks so one oversized statement cannot fail the whole run,
    // and existing quarters are overwritten so re-running is free.
    let written = 0;
    for (let index = 0; index < rows.length; index += 2_000) {
      const chunk = rows.slice(index, index + 2_000);
      const { error } = await supabase
        .from("energy_optimisation_price_slots")
        .upsert(chunk, { onConflict: "home_id,start_ts" });
      if (error) {
        console.error("[BACKFILL-PRICES] upsert failed", error);
        return json({
          error: "storage_failed",
          quarters_written: written,
        }, 500);
      }
      written += chunk.length;
    }

    return json({
      days,
      quarters_priced: written,
      days_priced: pricedDates.length,
      first_priced_date: pricedDates[0] ?? null,
      last_priced_date: pricedDates.at(-1) ?? null,
      skipped_days: skipped,
    });
  } catch (error) {
    console.error("[BACKFILL-PRICES] unexpected", error);
    return json({ error: "backfill_failed" }, 500);
  }
});
