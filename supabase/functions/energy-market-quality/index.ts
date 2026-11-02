/** TEST-only scheduled accuracy worker. Collection health remains independent in SQL. */
import {
  type WeatherForecastEvidence,
  type WeatherTruthEvidence,
  weatherValidation,
} from "../_shared/weather-forecast-quality.ts";
import {
  type DemandEvidence,
  scoreDemandForecasts,
} from "../_shared/demand-forecast-quality.ts";
const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
export type AccuracyKind = "weather_accuracy" | "demand_accuracy";
export interface AccuracyIntent {
  id: string;
  kind: AccuracyKind;
  complete: boolean;
  manifest: {
    snapshot_at: string;
    from: string;
    to: string;
    forecast_ids: string[];
    truth_ids: string[];
  };
}
export interface QualityProblem {
  key: string;
  severity: "problem";
  fingerprint: Record<string, unknown>;
  detail: Record<string, unknown>;
}
export interface QualityStore {
  verifyToken(token: string): Promise<boolean>;
  begin(kind: AccuracyKind): Promise<AccuracyIntent>;
  documents<T>(ids: string[]): Promise<T[]>;
  complete(
    id: string,
    summary: object,
    problems: QualityProblem[],
  ): Promise<void>;
}
export function createMarketQualityHandler(
  projectUrl: string,
  store: QualityStore,
) {
  return async (request: Request): Promise<Response> => {
    if (projectUrl !== TEST) {
      return Response.json({ error: "test_lane_only" }, { status: 403 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "post_required" }, { status: 405 });
    }
    const token = request.headers.get("x-energy-market-archive-token");
    try {
      if (!token || !await store.verifyToken(token)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let kind: AccuracyKind;
      try {
        const input = await request.json();
        if (
          !input || typeof input !== "object" ||
          Object.keys(input).join(",") !== "kind" ||
          !["weather_accuracy", "demand_accuracy"].includes(input.kind)
        ) throw new Error("Invalid kind");
        kind = input.kind;
      } catch {
        return Response.json({ error: "invalid_accuracy_request" }, {
          status: 400,
        });
      }
      const intent = await store.begin(kind);
      if (intent.complete) {
        return Response.json({ id: intent.id, status: "already_complete" });
      }
      const { forecast_ids: ids, truth_ids: truthIds } = intent.manifest;
      const problems: QualityProblem[] = [];
      let summary: object;
      if (kind === "weather_accuracy") {
        const truth = await store.documents<WeatherTruthEvidence>(truthIds);
        const validation = weatherValidation(truth, {
          from: Date.parse(intent.manifest.from),
          to: Date.parse(intent.manifest.to),
        });
        for (let at = 0; at < ids.length; at += 8) {
          validation.add(
            await store.documents<WeatherForecastEvidence>(
              ids.slice(at, at + 8),
            ),
          );
        }
        const result = validation.result();
        for (const variable of ["wind_speed_10m", "temperature_2m"]) {
          const primary = result.cells.filter((c) =>
            c.variable === variable && c.quality === "G"
          );
          if (!primary.some((c) => c.matched > 0)) {
            problems.push({
              key: `accuracy/weather/${variable}/unmatched`,
              severity: "problem",
              fingerprint: { rule: "no_approved_measurement_matches" },
              detail: {
                variable,
                forecast_origins: ids.length,
                truth_documents: truthIds.length,
              },
            });
          }
        }
        summary = result;
      } else {
        const documents = await store.documents<DemandEvidence>([
          ...ids,
          ...truthIds,
        ]);
        const result = scoreDemandForecasts(documents, {
          from: Date.parse(intent.manifest.from),
          to: Date.parse(intent.manifest.to),
        });
        if (!result.samples.length) {
          problems.push({
            key: "accuracy/demand/unmatched",
            severity: "problem",
            fingerprint: { rule: "no_complete_demand_matches" },
            detail: {
              forecast_origins: ids.length,
              truth_documents: truthIds.length,
            },
          });
        }
        // Actual scope already bounds matches; preserve the demand scorer's complete-day policy and result.
        summary = {
          scorer_version: "demand-accuracy-v1",
          ...result,
          window: { from: intent.manifest.from, to: intent.manifest.to },
        };
      }
      await store.complete(intent.id, summary, problems);
      return Response.json({
        id: intent.id,
        kind,
        status: "complete",
        problems: problems.length,
      });
    } catch {
      return Response.json({ error: "market_accuracy_evaluation_failed" }, {
        status: 500,
      });
    }
  };
}
if (import.meta.main) {
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2.57.2"
  );
  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const client = createClient(
    projectUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  Deno.serve(createMarketQualityHandler(projectUrl, {
    async verifyToken(token) {
      const { data, error } = await client.rpc(
        "verify_test_market_archive_token",
        { p_token: token },
      );
      if (error) throw new Error("Quality authentication failed");
      return data === true;
    },
    async begin(kind) {
      const { data, error } = await client.rpc("begin_test_market_accuracy", {
        p_kind: kind,
      });
      if (error || !data) throw new Error("Quality snapshot failed");
      return data as AccuracyIntent;
    },
    async documents<T>(ids: string[]): Promise<T[]> {
      const rows: T[] = [];
      for (let at = 0; at < ids.length; at += 8) {
        const page = ids.slice(at, at + 8);
        const { data, error } = await client.rpc("read_test_market_documents", {
          p_ids: page,
        });
        if (error || !Array.isArray(data) || data.length !== page.length) {
          throw new Error("Incomplete quality evidence");
        }
        rows.push(...data as T[]);
      }
      return rows;
    },
    async complete(id, summary, problems) {
      const { error } = await client.rpc("complete_test_market_accuracy", {
        p_id: id,
        p_summary: summary,
        p_problems: problems,
      });
      if (error) throw new Error("Quality result commit failed");
    },
  }));
}
