import type { SupabaseClient } from "@supabase/supabase-js";
import { currentGridPrices, GridTariffError, type GridPriceConfiguration, type GridTariffCatalogue } from "./energy-grid-pricing.ts";
import { estimateSupplierExportFromImport, SupplierPricingError } from "./energy-supplier-pricing.ts";
import type { SupplierVersion } from "./historical-electricity-prices.ts";
import { homeFusePeriods } from "./home-fuse-timeline.ts";
import { MAIN_FUSE_KEY, mainFuseA } from "./home-grid-limit.ts";
import { localDay } from "./planner-wasm/calendar.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";

type PriceSlot = Pick<OptimisationSnapshot["slots"][number], "start" | "import_price_sek_per_kwh" | "export_price_sek_per_kwh">;
type HomeTariffSettings = Omit<GridPriceConfiguration, "fuse_periods"> & {
  profile: Pick<GridTariffCatalogue["profiles"][number], "versions"> | null;
};
type HomePriceAnswer = { answer_value: unknown; answer_text: string | null; question: { semantic_key: string } };

/** Resolve both sides against the same spot for each quarter with an unpublished sell price. */
export function resolvePlanningSellPrices(
  slots: readonly PriceSlot[],
  buy: readonly number[],
  grid: GridTariffCatalogue,
  supplier: readonly SupplierVersion[],
): (number | null)[] {
  const supplierByDay = new Map<string, SupplierVersion | null>();
  return slots.map((slot, i) => {
    if (slot.export_price_sek_per_kwh !== null) return slot.export_price_sek_per_kwh;
    const day = localDay(slot.start, grid.timezone ?? "Europe/Stockholm");
    if (!supplierByDay.has(day)) {
      const active = supplier.filter(version => version.valid_from <= day && (!version.valid_to || version.valid_to >= day));
      supplierByDay.set(day, active.length === 1 ? active[0] : null);
    }
    const terms = supplierByDay.get(day);
    if (!terms) return null;
    try {
      const gridPrices = currentGridPrices(grid, new Date(slot.start));
      if (!gridPrices) return null;
      const supplierBuy = (slot.import_price_sek_per_kwh ?? buy[i]) - gridPrices.import_price_sek_per_kwh;
      const supplierSell = estimateSupplierExportFromImport(supplierBuy, terms.definition);
      return supplierSell === null ? null : Math.round((supplierSell + gridPrices.export_price_sek_per_kwh) * 100_000) / 100_000;
    } catch (error) {
      if (error instanceof GridTariffError || error instanceof SupplierPricingError) return null;
      throw error;
    }
  });
}

/** Read current terms only when admitting an actual plan, independently of the prepared buy forecast. */
export async function readPlanningSellPrices(
  db: SupabaseClient,
  homeId: string,
  slots: readonly PriceSlot[],
  buy: readonly number[],
): Promise<(number | null)[] | undefined> {
  if (slots.every(slot => slot.export_price_sek_per_kwh !== null)) return;
  const [answers, settings, fuseChanges] = await Promise.all([
    db.from("home_answers").select("answer_value, answer_text, question:home_questions!inner(semantic_key)")
      .eq("home_id", homeId).in("question.semantic_key", [MAIN_FUSE_KEY, "has_solar", "electricity_supplier"])
      .overrideTypes<HomePriceAnswer[], { merge: false }>(),
    db.from("energy_tariff_settings")
      .select("profile_id, connection_type, grid_area, energy_tax_reduced, include_vat, export_vat_registered, " +
        "profile:energy_tariff_profiles(versions:energy_tariff_versions(revision,valid_from,valid_to,calculation_model,definition))")
      .eq("id", true).maybeSingle().overrideTypes<HomeTariffSettings, { merge: false }>(),
    db.from("home_fuse_changes").select("changed_on, previous_fuse_a").eq("home_id", homeId),
  ]);
  const readError = answers.error ?? settings.error ?? fuseChanges.error;
  if (readError) throw new Error(readError.message);
  const values = new Map((answers.data ?? []).map(answer => [answer.question.semantic_key, answer.answer_value ?? answer.answer_text]));
  const fuse = mainFuseA(values.get(MAIN_FUSE_KEY));
  const solar = values.get("has_solar");
  const supplierKey = values.get("electricity_supplier");
  const tariff = settings.data;
  const hasSolarAnswer = typeof solar === "boolean" || solar === "true" || solar === "false";
  if (!tariff?.profile || fuse === null || !hasSolarAnswer || typeof supplierKey !== "string") return;
  const supplier = await db.from("energy_supplier_profiles")
    .select("versions:energy_supplier_versions(revision,valid_from,valid_to,definition)")
    .eq("provider_key", supplierKey.trim().toLowerCase()).maybeSingle();
  if (supplier.error) throw new Error(supplier.error.message);
  if (!supplier.data) return;
  const { profile, ...configuration } = tariff;
  return resolvePlanningSellPrices(slots, buy, {
    timezone: "Europe/Stockholm",
    configuration: {
      ...configuration, fuse_periods: homeFusePeriods(fuse, fuseChanges.data ?? []),
      production_enabled: solar === true || solar === "true",
    },
    profiles: [{ id: configuration.profile_id, versions: profile.versions }],
  }, supplier.data.versions);
}
