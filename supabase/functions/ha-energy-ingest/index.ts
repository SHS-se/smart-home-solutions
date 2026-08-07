// Receives daily category-level kWh readings and monthly tariff calculations
// pushed by the SHS Home Assistant integration. Device-token authenticated;
// subscription-gated (402 when inactive so the integration can raise a repair
// issue and pause pushing). Both upsert paths are idempotent for safe retries.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CATEGORIES = new Set([
  "heating",
  "hot_water",
  "cooling",
  "property_energy",
  "pool_heating",
  "ev_charging",
  "household",
  "grid_import",
  "grid_export",
  "solar_production",
  "total_consumption",
]);

const MAX_READINGS_PER_PUSH = 500; // ~45 days of full category backfill
const MAX_CALCULATIONS_PER_PUSH = 240;
const MAX_COMPONENTS_PER_CALCULATION = 100;
const MAX_KWH_PER_READING = 10000; // sanity bound for a single day/category
const MAX_MONTHLY_KWH = 1000000;
const MAX_AMOUNT_SEK = 10000000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const REVISION_RE = /^[a-z0-9_.-]+$/;
const COMPONENT_KEY_RE = /^[a-z0-9_]+$/;

const COMPONENT_CATEGORIES = new Set([
  "fixed_fee",
  "energy_transfer",
  "peak_demand",
  "energy_tax",
  "export_credit",
  "vat",
]);

const COMPONENT_UNITS = new Set(["month", "kWh", "kW"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface IncomingReading {
  date: string;
  category: string;
  kwh: number;
}

interface IncomingComponent {
  component_key: string;
  category: string;
  label: string;
  amount_sek: number;
  quantity: number | null;
  unit: string | null;
  unit_price_sek: number | null;
  period_start: string;
  period_end: string;
  tariff_revision: string;
}

interface IncomingCalculation {
  billing_month: string;
  coverage_start: string;
  coverage_end: string;
  is_complete: boolean;
  currency: string;
  calculation_model: string;
  calculation_version: number;
  tariff_revisions: string[];
  input_hash: string;
  grid_import_kwh: number;
  grid_export_kwh: number;
  peak_demand_kw: number | null;
  components: IncomingComponent[];
  total_amount_sek: number;
}

const isValidDate = (value: string) => {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

const round = (value: number, decimals: number) => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const auth = await authenticateDevice(supabase, req);
    if (auth.ok === false) return json({ error: auth.error }, auth.status);
    if (!auth.subscriptionActive) {
      return json({ error: "subscription_inactive" }, 402);
    }

    let readings: IncomingReading[] = [];
    let calculations: IncomingCalculation[] = [];
    try {
      const body = await req.json();
      if (body === null || typeof body !== "object") throw new Error("invalid body");
      if (body.readings !== undefined && !Array.isArray(body.readings)) {
        throw new Error("invalid readings");
      }
      if (body.calculations !== undefined && !Array.isArray(body.calculations)) {
        throw new Error("invalid calculations");
      }
      readings = body.readings ?? [];
      calculations = body.calculations ?? [];
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    if (readings.length > MAX_READINGS_PER_PUSH) {
      return json({ error: "too_many_readings" }, 400);
    }
    if (calculations.length > MAX_CALCULATIONS_PER_PUSH) {
      return json({ error: "too_many_calculations" }, 400);
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows: Array<{
      customer_id: string;
      reading_date: string;
      category: string;
      kwh: number;
      device_token_id: string;
    }> = [];
    const readingKeys = new Set<string>();

    for (const r of readings) {
      const date = String(r?.date ?? "");
      const category = String(r?.category ?? "");
      const kwh = Number(r?.kwh);
      if (!isValidDate(date) || date > today) {
        return json({ error: "invalid_date", detail: date }, 400);
      }
      if (!CATEGORIES.has(category)) {
        return json({ error: "invalid_category", detail: category }, 400);
      }
      if (!Number.isFinite(kwh) || kwh < 0 || kwh > MAX_KWH_PER_READING) {
        return json({ error: "invalid_kwh", detail: `${category} ${date}` }, 400);
      }
      const readingKey = `${date}:${category}`;
      if (readingKeys.has(readingKey)) {
        return json({ error: "duplicate_reading", detail: readingKey }, 400);
      }
      readingKeys.add(readingKey);
      rows.push({
        customer_id: auth.customerId,
        reading_date: date,
        category,
        kwh: Math.round(kwh * 1000) / 1000,
        device_token_id: auth.tokenId,
      });
    }

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from("energy_device_readings")
        .upsert(rows, { onConflict: "customer_id,reading_date,category" });

      if (upsertError) {
        console.error("[HA-ENERGY-INGEST] reading upsert failed", upsertError);
        return json({ error: "storage_failed" }, 500);
      }
    }

    const calculationRows: Array<{
      customer_id: string;
      billing_month: string;
      coverage_start: string;
      coverage_end: string;
      is_complete: boolean;
      missing_days: string[];
      currency: string;
      calculation_model: string;
      calculation_version: number;
      tariff_revisions: string[];
      input_hash: string;
      grid_import_kwh: number;
      grid_export_kwh: number;
      peak_demand_kw: number | null;
      components: IncomingComponent[];
      total_amount_sek: number;
      device_token_id: string;
    }> = [];
    const calculationMonths = new Set<string>();

    for (const calculation of calculations) {
      const billingMonth = String(calculation?.billing_month ?? "");
      const coverageStart = String(calculation?.coverage_start ?? "");
      const coverageEnd = String(calculation?.coverage_end ?? "");
      const monthPrefix = billingMonth.slice(0, 7);
      if (
        !isValidDate(billingMonth) ||
        !billingMonth.endsWith("-01") ||
        !isValidDate(coverageStart) ||
        !isValidDate(coverageEnd) ||
        coverageStart < billingMonth ||
        coverageEnd < coverageStart ||
        !coverageStart.startsWith(`${monthPrefix}-`) ||
        !coverageEnd.startsWith(`${monthPrefix}-`) ||
        coverageEnd > today
      ) {
        return json({ error: "invalid_calculation_period", detail: billingMonth }, 400);
      }
      const [billingYear, billingMonthNumber] = monthPrefix.split("-").map(Number);
      const expectedMonthEnd = new Date(
        Date.UTC(billingYear, billingMonthNumber, 0),
      ).toISOString().slice(0, 10);
      if (typeof calculation?.is_complete !== "boolean") {
        return json({ error: "invalid_calculation_completeness", detail: billingMonth }, 400);
      }
      // Days the meter was down for part of the hour range. Older integration
      // builds never send the field, and a month without gaps sends [].
      const missingDays = calculation?.missing_days ?? [];
      if (
        !Array.isArray(missingDays) ||
        missingDays.length > 31 ||
        new Set(missingDays).size !== missingDays.length ||
        missingDays.some(
          (day) =>
            typeof day !== "string" ||
            !isValidDate(day) ||
            !day.startsWith(`${monthPrefix}-`) ||
            day < coverageStart ||
            day > coverageEnd,
        )
      ) {
        return json({ error: "invalid_missing_days", detail: billingMonth }, 400);
      }
      // Spanning the month is not the same as having metered it: a month with
      // a hole in the middle must never be stored as the final figure, because
      // its energy totals are short by however long the meter was out.
      const coversWholeMonth = coverageStart === billingMonth &&
        coverageEnd === expectedMonthEnd &&
        missingDays.length === 0;
      if (calculation.is_complete !== coversWholeMonth) {
        return json({ error: "inconsistent_calculation_completeness", detail: billingMonth }, 400);
      }
      if (calculationMonths.has(billingMonth)) {
        return json({ error: "duplicate_calculation", detail: billingMonth }, 400);
      }
      calculationMonths.add(billingMonth);
      if (
        calculation?.currency !== "SEK" ||
        calculation?.calculation_model !== "se_grid_v1" ||
        calculation?.calculation_version !== 2
      ) {
        return json({ error: "unsupported_calculation", detail: billingMonth }, 400);
      }
      if (
        !Array.isArray(calculation?.tariff_revisions) ||
        calculation.tariff_revisions.length === 0 ||
        calculation.tariff_revisions.length > 12 ||
        new Set(calculation.tariff_revisions).size !== calculation.tariff_revisions.length ||
        calculation.tariff_revisions.some(
          (revision) => typeof revision !== "string" || !REVISION_RE.test(revision),
        )
      ) {
        return json({ error: "invalid_tariff_revisions", detail: billingMonth }, 400);
      }
      if (!HASH_RE.test(String(calculation?.input_hash ?? ""))) {
        return json({ error: "invalid_input_hash", detail: billingMonth }, 400);
      }

      const gridImportKwh = Number(calculation?.grid_import_kwh);
      const gridExportKwh = Number(calculation?.grid_export_kwh);
      const peakDemandKw = calculation?.peak_demand_kw === null
        ? null
        : Number(calculation?.peak_demand_kw);
      const totalAmountSek = Number(calculation?.total_amount_sek);
      if (
        !Number.isFinite(gridImportKwh) ||
        gridImportKwh < 0 ||
        gridImportKwh > MAX_MONTHLY_KWH ||
        !Number.isFinite(gridExportKwh) ||
        gridExportKwh < 0 ||
        gridExportKwh > MAX_MONTHLY_KWH ||
        (peakDemandKw !== null &&
          (!Number.isFinite(peakDemandKw) || peakDemandKw < 0 || peakDemandKw > MAX_MONTHLY_KWH)) ||
        !Number.isFinite(totalAmountSek) ||
        Math.abs(totalAmountSek) > MAX_AMOUNT_SEK
      ) {
        return json({ error: "invalid_calculation_totals", detail: billingMonth }, 400);
      }

      if (
        !Array.isArray(calculation?.components) ||
        calculation.components.length === 0 ||
        calculation.components.length > MAX_COMPONENTS_PER_CALCULATION
      ) {
        return json({ error: "invalid_components", detail: billingMonth }, 400);
      }

      const components: IncomingComponent[] = [];
      let componentTotal = 0;
      for (const component of calculation.components) {
        const componentKey = String(component?.component_key ?? "");
        const category = String(component?.category ?? "");
        const label = String(component?.label ?? "").trim();
        const amountSek = Number(component?.amount_sek);
        const quantity = component?.quantity === null ? null : Number(component?.quantity);
        const unit = component?.unit === null ? null : String(component?.unit ?? "");
        const unitPriceSek = component?.unit_price_sek === null
          ? null
          : Number(component?.unit_price_sek);
        const periodStart = String(component?.period_start ?? "");
        const periodEnd = String(component?.period_end ?? "");
        const tariffRevision = String(component?.tariff_revision ?? "");

        if (
          !COMPONENT_KEY_RE.test(componentKey) ||
          !COMPONENT_CATEGORIES.has(category) ||
          label.length === 0 ||
          label.length > 120 ||
          !Number.isFinite(amountSek) ||
          Math.abs(amountSek) > MAX_AMOUNT_SEK ||
          (quantity !== null &&
            (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_MONTHLY_KWH)) ||
          (unit !== null && !COMPONENT_UNITS.has(unit)) ||
          (unitPriceSek !== null &&
            (!Number.isFinite(unitPriceSek) || Math.abs(unitPriceSek) > MAX_AMOUNT_SEK)) ||
          !isValidDate(periodStart) ||
          !isValidDate(periodEnd) ||
          periodStart < billingMonth ||
          periodEnd < periodStart ||
          periodStart < coverageStart ||
          periodEnd > coverageEnd ||
          !periodStart.startsWith(`${monthPrefix}-`) ||
          !periodEnd.startsWith(`${monthPrefix}-`) ||
          !REVISION_RE.test(tariffRevision) ||
          !calculation.tariff_revisions.includes(tariffRevision)
        ) {
          return json({ error: "invalid_component", detail: `${billingMonth} ${category}` }, 400);
        }

        const roundedAmount = round(amountSek, 2);
        componentTotal += roundedAmount;
        components.push({
          component_key: componentKey,
          category,
          label,
          amount_sek: roundedAmount,
          quantity: quantity === null ? null : round(quantity, 3),
          unit,
          unit_price_sek: unitPriceSek === null ? null : round(unitPriceSek, 6),
          period_start: periodStart,
          period_end: periodEnd,
          tariff_revision: tariffRevision,
        });
      }

      if (Math.abs(round(componentTotal, 2) - round(totalAmountSek, 2)) > 0.02) {
        return json({ error: "component_total_mismatch", detail: billingMonth }, 400);
      }

      calculationRows.push({
        customer_id: auth.customerId,
        billing_month: billingMonth,
        coverage_start: coverageStart,
        coverage_end: coverageEnd,
        is_complete: calculation.is_complete,
        missing_days: [...missingDays].sort(),
        currency: "SEK",
        calculation_model: "se_grid_v1",
        calculation_version: 2,
        tariff_revisions: calculation.tariff_revisions,
        input_hash: calculation.input_hash,
        grid_import_kwh: round(gridImportKwh, 3),
        grid_export_kwh: round(gridExportKwh, 3),
        peak_demand_kw: peakDemandKw === null ? null : round(peakDemandKw, 3),
        components,
        total_amount_sek: round(totalAmountSek, 2),
        device_token_id: auth.tokenId,
      });
    }

    if (calculationRows.length > 0) {
      const { error: calculationError } = await supabase
        .from("energy_tariff_calculations")
        .upsert(calculationRows, { onConflict: "customer_id,billing_month" });

      if (calculationError) {
        console.error("[HA-ENERGY-INGEST] calculation upsert failed", calculationError);
        return json({ error: "storage_failed" }, 500);
      }
    }

    return json({
      accepted: rows.length,
      calculations_accepted: calculationRows.length,
    });
  } catch (error) {
    console.error("[HA-ENERGY-INGEST] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
