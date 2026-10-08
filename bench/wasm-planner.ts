import { builderRecipe } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
// Fixture publisher and adapter for the nonpublishing candidate. No observed
// future price/load/PV is passed through the ready-problem boundary.
import recipe from "../planner-core/recipe.json" with { type: "json" };
import { createHash } from "node:crypto";
import { sourceDigest } from "../scripts/build-planner-wasm.ts";
import { createWasmPlanner } from "../supabase/functions/_shared/planner-wasm/core.ts";
import {
  type PlannerRuleKey,
  type ReadyProblem,
  RULE_KEYS,
} from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { buildPriceOutlook } from "../supabase/functions/_shared/planner/energy-price-shape.ts";
import { publishHeater } from "../supabase/functions/_shared/planner/device-models.ts";
import {
  type BenchCase,
  caseTargets,
  quarterStarts,
} from "../src/lib/planner-bench/case.ts";
import type { Household } from "../src/lib/planner-bench/household.ts";
import { resolveRules, serviceGuard } from "../src/lib/planner-bench/score.ts";
import type {
  CriteriaOverrides,
  PlanRecord,
} from "../src/lib/planner-bench/types.ts";

const supported = (key: string): key is PlannerRuleKey =>
  RULE_KEYS.some((k) => k === key);
export const READY_PRODUCER_VERSION = "bench-ready-v4";

/** This runs as forecast preparation, outside solve; production will consume ready artifacts. */
export function readyProblem(
  c: BenchCase,
  h: Household,
  criteria: CriteriaOverrides = {},
  grant = recipe.work_grant,
): ReadyProblem {
  const starts = quarterStarts(c.start);
  const priceRows = c.recorded.history.prices.import_sek_per_kwh.flatMap((
    price,
    i,
  ) =>
    price === null ? [] : [{
      start_ts: new Date(
        Date.parse(c.recorded.history.prices.start) + i * 900_000,
      ).toISOString(),
      import_price_sek_per_kwh: price,
    }]
  );
  const outlook = buildPriceOutlook(
    starts.map((start, i) => ({
      start,
      import_price_sek_per_kwh: c.known_prices.import_sek_per_kwh[i],
    })),
    priceRows,
    {
      timeZone: c.timezone,
      asOf: Date.parse(c.start),
      wind: c.recorded.wind?.days,
    },
  );
  const prices = outlook.shadowImportSekPerKwh;
  // The import/export spread is derived only from jointly published quarters.
  const spreads = c.known_prices.import_sek_per_kwh.flatMap((p, i) =>
    p === null || c.known_prices.export_sek_per_kwh[i] === null
      ? []
      : [p - c.known_prices.export_sek_per_kwh[i]!]
  ).sort((a, b) => a - b);
  if (!spreads.length) {
    throw new Error(
      "A ready price forecast needs a published import/export pair.",
    );
  }
  const spread = spreads[Math.floor(spreads.length / 2)];
  const heater = publishHeater(h.pool.heater);
  const target = caseTargets(c);
  return {
    abi: 4,
    work_grant: grant,
    recipe: builderRecipe(recipe),
    slots: starts.map((_start, i) => ({
      start_seconds: i * 900,
      hours: 0.25,
      base_w: c.base_load_forecast_w[i],
      solar_w: c.solar_forecast_w[i],
      // The bench gives all planners this measured weather as a perfect forecast.
      outdoor_c: c.recorded.outdoor_temperature_c[i],
      import_price: prices[i],
      export_price: c.known_prices.export_sek_per_kwh[i] ?? prices[i] - spread,
      ev_available: true,
      published: c.known_prices.import_sek_per_kwh[i] !== null &&
        c.known_prices.export_sek_per_kwh[i] !== null,
    })),
    battery: h.battery,
    car: h.car.battery,
    charger: h.car.charger,
    pool_store: h.pool.store,
    heater,
    // The benchmark has no captured hardware thermostat. Keep its declared model.
    pool_stop_c: null,
    initial: {
      battery_kwh: c.start_state.battery_soc * h.battery.capacity_kwh,
      ev_kwh: c.start_state.ev.soc * h.car.battery.capacity_kwh,
      pool_c: c.start_state.pool_water_c,
      heater_state: c.start_state.pool_heater,
    },
    targets: {
      pool_c: target.pool_c,
      ev_km: target.ev_km,
      ev_limit_kwh: c.start_state.ev.target_soc * h.car.battery.capacity_kwh,
    },
    limits: {
      import_w: h.site.import_limit_w,
      export_w: h.site.export_limit_w,
      battery_export_enabled: h.site.battery_export_enabled,
      battery_export_reserve_kwh: h.site.battery_export_reserve_soc *
        h.battery.capacity_kwh,
      battery_export_min_price: h.site.battery_export_min_price_sek_per_kwh,
      wear_per_kwh: h.site.battery_degradation_sek_per_kwh,
    },
    rules: resolveRules(criteria).flatMap((r) => {
      if (!supported(r.key)) throw new Error(`Unmapped planner rule: ${r.key}`);
      if (r.unless && !supported(r.unless)) {
        throw new Error(`Unmapped rule exclusion: ${r.unless}`);
      }
      return r.enabled
        ? [{
          key: r.key,
          threshold: r.threshold,
          points: r.points,
          required: r.required ?? false,
          unless: r.unless && supported(r.unless) ? r.unless : null,
        }]
        : [];
    }),
    service_guard: serviceGuard(criteria),
    accepted: null,
    locked_through_seconds: 0,
  };
}

export async function loadWasmCandidate(root: string) {
  const dir = `${root}/supabase/functions/_shared/planner-wasm`;
  const manifest: { abi: number; wasm_sha256: string; source_sha256: string } =
    JSON.parse(
      await Deno.readTextFile(`${dir}/artifact.json`),
    );
  const bytes = await Deno.readFile(`${dir}/solver.wasm`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    manifest.abi !== 4 || hash !== manifest.wasm_sha256 ||
    sourceDigest(root) !== manifest.source_sha256
  ) {
    throw new Error(
      "Missing or stale planner artifact: run deno task build:planner-wasm.",
    );
  }
  const started = performance.now();
  const core = createWasmPlanner(bytes);
  const cold_compile_ms = performance.now() - started;
  const identity = createHash("sha256").update(
    JSON.stringify({ manifest, producer: READY_PRODUCER_VERSION }),
  ).digest("hex");
  return {
    version: `wasm-v4:${identity}`,
    cold_compile_ms,
    artifact_bytes: bytes.length,
    plan(
      problem: ReadyProblem,
    ): {
      record: PlanRecord;
      elapsed_ms: number;
      outcome: ReturnType<typeof core.solve>["outcome"];
      wasm_memory_bytes: number;
    } {
      if (
        problem.work_grant !== recipe.work_grant ||
        JSON.stringify(problem.recipe) !== JSON.stringify(builderRecipe(recipe))
      ) {
        throw new Error(
          "Candidate identity requires the frozen work recipe; rebuild after changing recipe.json.",
        );
      }
      const start = performance.now();
      const { outcome, wasm_memory_bytes } = core.solve(problem);
      const elapsed_ms = performance.now() - start;
      if (outcome.kind === "failed") throw new Error(outcome.issue);
      const s = outcome.selection;
      return {
        elapsed_ms,
        outcome,
        wasm_memory_bytes,
        record: {
          status: "planned",
          generation: "ready-wasm-v4",
          decisions: {
            pool_w: s.quarters.map((q) => q.pool_command_w),
            ev_w: s.commands.map((c) =>
              problem.charger
                ? c.ev_amps * problem.charger.voltage_v *
                  problem.charger.phase_count
                : 0
            ),
            battery_charge_w: s.quarters.map((q) => q.charge_w),
            battery_discharge_w: s.quarters.map((q) => q.discharge_w),
            battery_follow: s.commands.map((c, i) => ({
              follows: [
                "self_consumption",
                "solar_charge",
                "supply_house",
                "hold",
              ].includes(
                c.battery,
              ),
              charge_limit_w: c.charge_limit_w,
              discharge_limit_w: ["hold", "solar_charge"].includes(c.battery)
                ? 0
                : c.discharge_limit_w,
              planned: [s.quarters[i].charge_w, s.quarters[i].discharge_w],
            })),
          },
          beliefs: {
            import_sek_per_kwh: problem.slots.map((s) => s.import_price),
            grid_cost_sek: s.account.cash_sek,
          },
          curves: [],
          valuation: { scale: 1, pool: "none", ev: "none", battery: "none" },
        },
      };
    },
  };
}
