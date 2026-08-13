// Device-authenticated supplier prices. SHS fetches the public Swedish spot
// market and applies the effective-dated terms selected on the customer's home.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import {
  calculateSupplierPrice,
  parseSpotPriceIntervals,
  SUPPLIER_PRICE_SCHEMA_VERSION,
  type SupplierPriceInterval,
} from "../_shared/energy-supplier-pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const AREAS = new Set(["SE1", "SE2", "SE3", "SE4"]);
const SPOT_SOURCE = "https://www.elprisetjustnu.se/api/v1/prices";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=300",
    },
  });

const dateInStockholm = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

const spotUrl = (date: Date, area: string) => {
  const { year, month, day } = dateInStockholm(date);
  return `${SPOT_SOURCE}/${year}/${month}-${day}_${area}.json`;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (date: Date) => {
  const { year, month, day } = dateInStockholm(date);
  return `${year}-${month}-${day}`;
};
const addDays = (value: string, days: number) =>
  new Date(Date.parse(`${value}T12:00:00Z`) + days * 86_400_000);

const requestedDates = (url: URL, now: Date) => {
  const today = isoDate(now);
  const from = url.searchParams.get("from") ?? today;
  const to = url.searchParams.get("to") ?? isoDate(addDays(today, 1));
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    throw new Error("invalid requested date range");
  }
  const dates: Date[] = [];
  for (let cursor = from; cursor <= to; cursor = isoDate(addDays(cursor, 1))) {
    dates.push(addDays(cursor, 0));
    if (dates.length > 62) {
      throw new Error("requested date range exceeds 62 days");
    }
  }
  return { dates, today };
};

const answerValue = (
  answer: { answer_value: unknown; answer_text: string | null } | undefined,
) => answer?.answer_value ?? answer?.answer_text ?? null;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

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

    const { data: questions, error: questionError } = await supabase
      .from("home_questions")
      .select("id, semantic_key, question_text, question_text_en")
      .in("semantic_key", ["electricity_supplier", "electricity_price_area"]);
    if (questionError) throw questionError;
    const { data: answers, error: answerError } = await supabase
      .from("home_answers")
      .select("question_id, answer_value, answer_text")
      .eq("home_id", auth.homeId)
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
      return json({
        schema_version: SUPPLIER_PRICE_SCHEMA_VERSION,
        timezone: "Europe/Stockholm",
        configuration: null,
        missing_inputs: missingInputs,
        missing_input_details: missingInputs.map((key) => {
          const question = (questions ?? []).find((row) =>
            row.semantic_key === key
          );
          return {
            key,
            question_sv: question?.question_text ?? null,
            question_en: question?.question_text_en ??
              question?.question_text ?? null,
          };
        }),
        forecast: [],
        current: null,
      });
    }

    const { data: profile, error: profileError } = await supabase
      .from("energy_supplier_profiles")
      .select("id, provider_key, provider_name, currency")
      .eq("provider_key", supplierKey)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return json({ error: "supplier_not_supported" }, 422);
    const { data: versions, error: versionError } = await supabase
      .from("energy_supplier_versions")
      .select(
        "revision, valid_from, valid_to, calculation_model, definition, source_url",
      )
      .eq("profile_id", profile.id)
      .order("valid_from", { ascending: true });
    if (versionError) throw versionError;
    if (!versions?.length) {
      return json({ error: "supplier_terms_not_published" }, 422);
    }

    const now = new Date();
    const { dates, today } = requestedDates(new URL(req.url), now);
    const urls = dates.map((date) => spotUrl(date, area));
    const responses = await Promise.all(urls.map((url) => fetch(url)));
    const payloads: unknown[] = [];
    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index];
      const requestedDate = isoDate(dates[index]);
      if (response.ok) payloads.push(await response.json());
      else if (response.status !== 404 || requestedDate <= today) {
        throw new Error(
          `spot source failed for ${requestedDate} with ${response.status}`,
        );
      }
    }
    if (payloads.length === 0) throw new Error("spot source returned no days");
    const spot = payloads.flatMap(parseSpotPriceIntervals);
    const usedRevisions = new Set<string>();
    const forecast: SupplierPriceInterval[] = spot.map((interval) => {
      const localDate = interval.time_start.slice(0, 10);
      const version = versions.find((candidate) =>
        candidate.valid_from <= localDate &&
        (!candidate.valid_to || candidate.valid_to >= localDate)
      );
      if (!version) throw new Error(`supplier terms missing for ${localDate}`);
      usedRevisions.add(version.revision);
      return calculateSupplierPrice(interval, version.definition);
    });
    const current = forecast.find((interval) =>
      Date.parse(interval.start) <= now.getTime() &&
      now.getTime() < Date.parse(interval.end)
    ) ?? null;
    if (
      dates.some((date) =>
        isoDate(date) === today
      ) && !current
    ) {
      throw new Error("spot source does not cover the current quarter");
    }

    return json({
      schema_version: SUPPLIER_PRICE_SCHEMA_VERSION,
      timezone: "Europe/Stockholm",
      configuration: {
        supplier: profile.provider_key,
        supplier_name: profile.provider_name,
        price_area: area,
        currency: profile.currency,
      },
      missing_inputs: [],
      missing_input_details: [],
      current,
      forecast,
      revisions: [...usedRevisions],
      terms_valid_from: versions[0].valid_from,
      issued_at: now.toISOString(),
      valid_until: forecast.at(-1)?.end ?? null,
      source: {
        provider: "elprisetjustnu.se",
        urls,
        source_url: "https://www.elprisetjustnu.se/elpris-api",
      },
    });
  } catch (error) {
    console.error("[INTEGRATION-PRICES] unexpected", error);
    return json({ error: "price_lookup_failed" }, 502);
  }
});
