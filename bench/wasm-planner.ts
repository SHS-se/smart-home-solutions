import { boilerDemand } from "../src/lib/planner-bench/household.ts";
import { POOL_START_COST_SEK, EV_START_PREFERENCE_SEK, BATTERY_START_PREFERENCE_SEK } from "../supabase/functions/_shared/planner-wasm/cost-policy.ts";
import { demandLevel } from "../supabase/functions/_shared/planner/demand-outlook.ts";
import { localDay, localMonths } from "../supabase/functions/_shared/planner-wasm/calendar.ts";
import { builderRecipe } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
// Fixture publisher and adapter for the nonpublishing candidate. No observed
// future price/load/PV is passed through the ready-problem boundary.
import recipe from "../planner-core/recipe.json" with { type: "json" };
import { createHash } from "node:crypto";
import { sourceDigest } from "../scripts/build-planner-wasm.ts";
import { createWasmPlanner } from "../supabase/functions/_shared/planner-wasm/core.ts";
import { problemEndCredit } from "../supabase/functions/_shared/planner-wasm/end-credit.ts";
import {
  type PlannerRuleKey,
  type ReadyProblem,
  RULE_KEYS,
} from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { buildPriceOutlook } from "../supabase/functions/_shared/planner/energy-price-shape.ts";
import { publishHeater } from "../supabase/functions/_shared/planner/device-models.ts";
import type { DutyCycleServiceInput } from "../supabase/functions/_shared/planner/planning-contracts.ts";
import { addHotWater } from "../supabase/functions/_shared/rules-hot-water.ts";
import type { PreparedRulesInput } from "../supabase/functions/_shared/rules-planner.ts";
import { caseCarPolicy, type HotWaterCommand } from "../src/lib/planner-bench/referee.ts";
import {
  type BenchCase,
  caseTargets,
  quarterStarts,
} from "../src/lib/planner-bench/case.ts";
import type { Household } from "../src/lib/planner-bench/household.ts";
import { resolveRules, serviceGuard } from "../src/lib/planner-bench/score.ts";
import { REFEREE_RULE_DEFAULTS } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import type {
  CriteriaOverrides,
  PlanRecord,
} from "../src/lib/planner-bench/types.ts";

const supported = (key: string): key is PlannerRuleKey =>
  RULE_KEYS.some((k) => k === key);
export const READY_PRODUCER_VERSION = "bench-ready-v13";

/**
 * The water heater as production plans it, around the kernel rather than in
 * it: the house's water windows, one per local day as the home sends them, and
 * the load the kernel is told the rest of the house draws.
 */
export interface HotWaterInput {
  services: DutyCycleServiceInput[];
  /** The base load without the heater, level-corrected as the kernel's base is. */
  other_house_w: number[];
}

/** Permissions exist independently of whether the case measured boiler demand. */
export function hotWaterInput(c: BenchCase, h: Household): HotWaterInput | null {
  const demand = boilerDemand(c.other_devices_w, h.hot_water);
  const water = demand ?? c.base_load_forecast_w.map(() => 0);
  const starts = quarterStarts(c.start);
  const level = demandLevel(c.recorded.history.demand_days, localDay(c.start, c.timezone));
  const days = new Map<string, number[]>();
  starts.forEach((start, i) => {
    const day = localDay(start, c.timezone);
    days.set(day, [...days.get(day) ?? [], i]);
  });
  return {
    services: [...days].map(([day, quarters]) => ({
      id: `boiler:${day}`, device: "boiler", priority: 1,
      earliest_start: starts[quarters[0]],
      deadline: new Date(Date.parse(starts[quarters.at(-1)!]) + 900_000).toISOString(),
      required_kwh: quarters.reduce((sum, i) => sum + water[i], 0) * 0.25 / 1_000,
      control: { type: "duty_cycle", rated_power_w: h.hot_water.rated_w, expected_power_w_by_slot: [...water] },
    })),
    other_house_w: starts.map((_start, i) => Math.max(0, c.base_load_forecast_w[i] - water[i]) * (level?.factor ?? 1)),
  };
}

/** Daily opportunities share the production allocator. */
export interface HotWaterContext {
  input: HotWaterInput;
  starts: string[];
  timezone: string;
}

/** The household solve starts without unlocked water. */
export function hotWaterContext(c: BenchCase, h: Household): HotWaterContext | null {
  const input = hotWaterInput(c, h);
  if (!input) return null;
  const starts = quarterStarts(c.start);
  return { input, starts, timezone: c.timezone };
}

/** This runs as forecast preparation, outside solve; production will consume ready artifacts. */
export function readyProblem(
  c: BenchCase,
  h: Household,
  criteria: CriteriaOverrides = {},
  grant = recipe.work_grant,
): ReadyProblem {
  const starts = quarterStarts(c.start);
  const months = localMonths(starts, c.timezone);
  const level = demandLevel(c.recorded.history.demand_days, localDay(c.start, c.timezone));
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
  const water = hotWaterContext(c, h);
  const problem: ReadyProblem = {
    abi: 15,
    ev_battery_supply_allowed: h.site.ev_battery_supply_allowed,
    work_grant: grant,
    recipe: builderRecipe(recipe),
    slots: starts.map((_start, i) => ({
      local_month: months[i],
      start_seconds: i * 900,
      hours: 0.25,
      base_w: water
        ? water.input.other_house_w[i]
        : c.base_load_forecast_w[i] * (level?.factor ?? 1),
      base_ev_w: 0,
      solar_w: c.solar_forecast_w[i],
      // The bench gives all planners this measured weather as a perfect forecast.
      outdoor_c: c.recorded.outdoor_temperature_c[i],
      import_price: prices[i],
      export_price: c.known_prices.export_sek_per_kwh[i] ?? prices[i] - spread,
      ev_available: true, pool_auxiliary_dispatch: null,
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
      pool_pending_heat_kwh: 0,
      pool_source_depletion_kwh: heater.source ? c.start_state.pool_source_depletion_kwh : null,
      heater_state: c.start_state.pool_heater,
    },
    targets: {
      pool_c: target.pool_c,
    },
    car_policy: null,
    limits: {
      import_w: h.site.import_limit_w,
      export_w: h.site.export_limit_w,
      battery_export_enabled: h.site.battery_export_enabled,
      battery_export_reserve_kwh: h.site.battery_export_reserve_soc *
        h.battery.capacity_kwh,
      battery_export_min_price: h.site.battery_export_min_price_sek_per_kwh,
      wear_per_kwh: h.site.battery_degradation_sek_per_kwh,
      ev_start_preference_sek: EV_START_PREFERENCE_SEK, battery_start_preference_sek: BATTERY_START_PREFERENCE_SEK, pool_start_cost_sek: POOL_START_COST_SEK,
    },
    // The planner optimises the score: only the rules that take points go to it.
    rules: resolveRules(criteria).flatMap((r) => {
      // Referee-only rules judge what the kernel does not plan.
      if (r.key in REFEREE_RULE_DEFAULTS) return [];
      if (!supported(r.key)) throw new Error(`Unmapped planner rule: ${r.key}`);
      return r.enabled
        ? [{
          key: r.key,
          threshold: r.threshold,
          points: r.points,
          required: r.required ?? false,
        }]
        : [];
    }),
    service_guard: serviceGuard(criteria),
    // Filled below from the finished problem: the credit's reference is the median of the prices it was told.
    end_credit: { reference_sek_per_kwh: 0, battery: null, pool: null, ev: null },
    accepted: null, released: null, unavailable: null,
    locked_through_seconds: 0,
  };
  problem.car_policy = caseCarPolicy(c, h, target);
  problem.end_credit = problemEndCredit(problem);
  return problem;
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
    manifest.abi !== 15 || hash !== manifest.wasm_sha256 ||
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
    version: `wasm-v9:${identity}`,
    cold_compile_ms,
    artifact_bytes: bytes.length,
    plan(
      problem: ReadyProblem,
      water: HotWaterContext | null = null,
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
      if (outcome.kind === "failed") throw new Error(outcome.issue);
      let s = outcome.selection;
      // Production selects binary daily opportunities after the household solve.
      let hotWater: HotWaterCommand[] | undefined;
      let refinedWaterW: number[] = [];
      if (water) {
        const prepared = {
          snapshot: { slots: water.starts.map((start) => ({ start })), timezone: water.timezone },
          problem, locked_slots: [], fixed_slots: {}, base_w: water.input.other_house_w, passive_w: {},
          boiler_services: water.input.services,
          boiler_w: water.starts.map(() => 0), boiler_rated_w: water.starts.map(() => 0), boiler_permitted: water.starts.map(() => false),
          boiler_battery_allowed: water.starts.map(() => false), boiler_permission_starts: [], boiler_shortfall_minutes: {},
        } as unknown as PreparedRulesInput;
        const refined = addHotWater(core, prepared, s);
        s = refined.selection;
        const w = refined.input;
        refinedWaterW = [...w.boiler_w];
        hotWater = water.starts.map((_start, i): HotWaterCommand => ({ kind: w.boiler_permitted[i] ? "permit" : "inhibit" }));
      }
      const elapsed_ms = performance.now() - start;
      return {
        elapsed_ms,
        outcome,
        wasm_memory_bytes,
        record: {
          status: "planned",
          generation: "ready-wasm-v9",
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
            ...(hotWater && water ? { hot_water: hotWater, hot_water_expected_w: refinedWaterW } : {}),
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
