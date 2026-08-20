// Delivers the global, staff-published Ellevio catalogue plus customer facts
// derived from the primary-home questionnaire. Customers never select a tariff.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import {
  HA_API_CORS_HEADERS,
  haApiResponse,
  haRequestId,
} from "../_shared/ha-api-contract.ts";

const VALID_FUSES = new Set([16, 20, 25, 35, 50, 63]);

const answerValue = (
  answer: { answer_value: unknown; answer_text: string | null } | undefined,
) => answer?.answer_value ?? answer?.answer_text ?? null;

serve(async (req) => {
  const requestId = haRequestId(req);
  const json = (body: unknown, status = 200) =>
    haApiResponse(requestId, body, status);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: HA_API_CORS_HEADERS });
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

    const { data: settings, error: settingsError } = await supabase
      .from("energy_tariff_settings")
      .select(
        "profile_id, connection_type, grid_area, energy_tax_reduced, include_vat, export_vat_registered",
      )
      .eq("id", true)
      .maybeSingle();
    if (settingsError) {
      console.error(
        "[INTEGRATION-TARIFF] settings lookup failed",
        settingsError,
      );
      return json({ error: "tariff_lookup_failed" }, 500);
    }

    if (!settings) {
      return json({
        schema_version: 2,
        calculation_version: 2,
        timezone: "Europe/Stockholm",
        configuration: null,
        missing_inputs: ["central_tariff_settings"],
        missing_input_details: [
          {
            key: "central_tariff_settings",
            question_sv: null,
            question_en: null,
          },
        ],
        profiles: [],
      });
    }

    const [
      { data: profiles, error: profileError },
      { data: versions, error: versionError },
    ] = await Promise.all([
      supabase.from("energy_tariff_profiles")
        .select(
          "id, provider_key, tariff_key, provider_name, display_name, currency",
        )
        .eq("id", settings.profile_id),
      supabase.from("energy_tariff_versions")
        .select(
          "id, profile_id, revision, valid_from, valid_to, calculation_model, definition, source_url, published_at",
        )
        .eq("profile_id", settings.profile_id)
        .order("valid_from", { ascending: true }),
    ]);
    if (profileError || versionError) {
      console.error("[INTEGRATION-TARIFF] catalogue lookup failed", {
        profileError,
        versionError,
      });
      return json({ error: "tariff_lookup_failed" }, 500);
    }

    let mainFuseA: number | null = null;
    let productionEnabled: boolean | null = null;
    // Keyed by semantic key so an unanswered input can be reported by its real
    // question text instead of an opaque key the customer has never seen.
    const questionText = new Map<string, { sv: string; en: string }>();
    if (auth.homeId) {
      const { data: questions, error: questionError } = await supabase
        .from("home_questions")
        .select("id, semantic_key, question_text, question_text_en")
        .in("semantic_key", ["main_fuse_a", "has_solar"]);
      if (questionError) {
        console.error(
          "[INTEGRATION-TARIFF] question lookup failed",
          questionError,
        );
        return json({ error: "tariff_lookup_failed" }, 500);
      }

      const { data: answers, error: answerError } = await supabase
        .from("home_answers")
        .select("question_id, answer_value, answer_text")
        .eq("home_id", auth.homeId)
        .in("question_id", (questions ?? []).map((question) => question.id));
      if (answerError) {
        console.error("[INTEGRATION-TARIFF] answer lookup failed", answerError);
        return json({ error: "tariff_lookup_failed" }, 500);
      }

      const answersByQuestion = new Map(
        (answers ?? []).map((answer) => [answer.question_id, answer]),
      );
      for (const question of questions ?? []) {
        if (!question.semantic_key) continue;
        questionText.set(question.semantic_key, {
          sv: question.question_text,
          en: question.question_text_en || question.question_text,
        });
      }
      const values = Object.fromEntries((questions ?? []).map((question) => [
        question.semantic_key,
        answerValue(answersByQuestion.get(question.id)),
      ]));
      const fuse = Number(values.main_fuse_a);
      if (VALID_FUSES.has(fuse)) mainFuseA = fuse;
      if (values.has_solar === true || values.has_solar === "true") {
        productionEnabled = true;
      }
      if (values.has_solar === false || values.has_solar === "false") {
        productionEnabled = false;
      }
    }

    const missingInputs: string[] = [];
    if (mainFuseA === null) missingInputs.push("main_fuse_a");
    if (productionEnabled === null) missingInputs.push("has_solar");

    // missing_inputs stays a plain key list for older integration builds; the
    // details carry what the customer actually needs to read.
    const missingInputDetails = missingInputs.map((key) => ({
      key,
      question_sv: questionText.get(key)?.sv ?? null,
      question_en: questionText.get(key)?.en ?? null,
    }));

    return json({
      schema_version: 2,
      calculation_version: 2,
      timezone: "Europe/Stockholm",
      configuration: missingInputs.length === 0
        ? {
          profile_id: settings.profile_id,
          connection_type: "three_phase",
          fuse_a: mainFuseA,
          grid_area: settings.grid_area,
          production_enabled: productionEnabled,
          energy_tax_reduced: settings.energy_tax_reduced,
          include_vat: settings.include_vat,
          export_vat_registered: settings.export_vat_registered,
        }
        : null,
      missing_inputs: missingInputs,
      missing_input_details: missingInputDetails,
      profiles: (profiles ?? []).map((profile) => ({
        ...profile,
        versions: (versions ?? []).filter((version) =>
          version.profile_id === profile.id
        ),
      })),
    });
  } catch (error) {
    console.error("[INTEGRATION-TARIFF] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
