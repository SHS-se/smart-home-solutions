// Fixture publisher and adapter for the nonpublishing candidate. No observed
// future price/load/PV is passed through the ready-problem boundary.
import recipe from '../planner-core/recipe.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { sourceDigest } from '../scripts/build-planner-wasm.ts';
import { createWasmPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';
import {
  DIRECT_RULE_KEYS,
  type DirectRuleKey,
  type ReadyProblem,
} from '../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { buildPriceOutlook } from '../supabase/functions/_shared/planner/energy-price-shape.ts';
import { operatingPoint } from '../supabase/functions/_shared/planner/device-models.ts';
import { type BenchCase, caseTargets, quarterStarts } from '../src/lib/planner-bench/case.ts';
import type { Household } from '../src/lib/planner-bench/household.ts';
import { AHEAD_MARGIN, resolveRules } from '../src/lib/planner-bench/score.ts';
import type { CriteriaOverrides, PlanRecord } from '../src/lib/planner-bench/types.ts';

const direct = (key: string): key is DirectRuleKey => DIRECT_RULE_KEYS.some((k) => k === key);
export const READY_PRODUCER_VERSION = 'bench-ready-v1';

/** This runs as forecast preparation, outside solve; production will consume ready artifacts. */
export function readyProblem(
  c: BenchCase,
  h: Household,
  criteria: CriteriaOverrides = {},
  grant = recipe.work_grant,
): ReadyProblem {
  const starts = quarterStarts(c.start);
  const priceRows = c.recorded.history.prices.import_sek_per_kwh.flatMap((price, i) =>
    price === null ? [] : [{
      start_ts: new Date(Date.parse(c.recorded.history.prices.start) + i * 900_000).toISOString(),
      import_price_sek_per_kwh: price,
    }]
  );
  const outlook = buildPriceOutlook(
    starts.map((start, i) => ({
      start,
      import_price_sek_per_kwh: c.known_prices.import_sek_per_kwh[i],
    })),
    priceRows,
    { timeZone: c.timezone, asOf: Date.parse(c.start), wind: c.recorded.wind?.days },
  );
  const prices = outlook.shadowImportSekPerKwh;
  // The import/export spread is derived only from jointly published quarters.
  const spreads = c.known_prices.import_sek_per_kwh.flatMap((p, i) =>
    p === null || c.known_prices.export_sek_per_kwh[i] === null
      ? []
      : [p - c.known_prices.export_sek_per_kwh[i]!]
  ).sort((a, b) => a - b);
  if (!spreads.length) {
    throw new Error('A ready price forecast needs a published import/export pair.');
  }
  const spread = spreads[Math.floor(spreads.length / 2)];
  const mean = (a: number[]) => a.reduce((sum, v) => sum + v, 0) / a.length;
  const ahead = (i: number) => {
    const from = Math.floor(i / 96) * 96, next = from + 96;
    if (next + 96 > prices.length) return null;
    return mean(prices.slice(next, next + 96)) >
        mean(prices.slice(from, next)) * (1 + AHEAD_MARGIN) ||
      mean(c.solar_forecast_w.slice(next, next + 96)) <
        mean(c.solar_forecast_w.slice(from, next)) * (1 - AHEAD_MARGIN);
  };
  const run = operatingPoint(h.pool.heater, h.pool.heater.selected_setting);
  const target = caseTargets(c);
  return {
    abi: 1,
    work_grant: grant,
    recipe: { max_passes: recipe.max_passes, coupled_masks: recipe.coupled_masks },
    slots: starts.map((_start, i) => ({
      start_seconds: i * 900,
      hours: 0.25,
      base_w: c.base_load_forecast_w[i],
      solar_w: c.solar_forecast_w[i],
      // The bench gives all planners this measured weather as a perfect forecast.
      outdoor_c: c.recorded.outdoor_temperature_c[i],
      import_price: prices[i],
      export_price: c.known_prices.export_sek_per_kwh[i] ?? prices[i] - spread,
      published: c.known_prices.import_sek_per_kwh[i] !== null &&
        c.known_prices.export_sek_per_kwh[i] !== null,
      cheap_rank: prices.filter((v) => v < prices[i]).length / prices.length,
      dear_rank: prices.filter((v) => v > prices[i]).length / prices.length,
      next_day_buffer: ahead(i),
    })),
    battery: h.battery,
    car: h.car.battery,
    charger: h.car.charger,
    pool_store: h.pool.store,
    heater: {
      compressor_w: run.electric_w,
      auxiliary_w: h.pool.heater.auxiliary_w,
      heat_w: run.heat_w,
      response: h.pool.heater.response ?? { kind: 'steady' },
    },
    initial: {
      battery_kwh: c.start_state.battery_soc * h.battery.capacity_kwh,
      ev_kwh: c.start_state.ev.soc * h.car.battery.capacity_kwh,
      pool_c: c.start_state.pool_water_c,
      heater_age: { kind: 'off' },
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
      battery_export_reserve_kwh: h.site.battery_export_reserve_soc * h.battery.capacity_kwh,
      battery_export_min_price: h.site.battery_export_min_price_sek_per_kwh,
      wear_per_kwh: h.site.battery_degradation_sek_per_kwh,
    },
    rules: resolveRules(criteria).flatMap((r) =>
      r.enabled && direct(r.key) ? [{ key: r.key, threshold: r.threshold, points: r.points }] : []
    ),
    accepted: null,
    locked_through_seconds: 0,
  };
}

export async function loadWasmCandidate(root: string) {
  const dir = `${root}/supabase/functions/_shared/planner-wasm`;
  const manifest: { abi: number; wasm_sha256: string; source_sha256: string } = JSON.parse(
    await Deno.readTextFile(`${dir}/artifact.json`),
  );
  const bytes = await Deno.readFile(`${dir}/solver.wasm`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (
    manifest.abi !== 1 || hash !== manifest.wasm_sha256 ||
    sourceDigest(root) !== manifest.source_sha256
  ) {
    throw new Error('Missing or stale planner artifact: run deno task build:planner-wasm.');
  }
  const started = performance.now();
  const core = createWasmPlanner(bytes);
  const cold_compile_ms = performance.now() - started;
  const identity = createHash('sha256').update(
    JSON.stringify({ manifest, producer: READY_PRODUCER_VERSION }),
  ).digest('hex');
  return {
    version: `wasm-v1:${identity}`,
    cold_compile_ms,
    artifact_bytes: bytes.length,
    plan(
      problem: ReadyProblem,
    ): {
      record: PlanRecord;
      elapsed_ms: number;
      outcome: ReturnType<typeof core.solve>['outcome'];
      wasm_memory_bytes: number;
    } {
      if (
        problem.work_grant !== recipe.work_grant ||
        problem.recipe.max_passes !== recipe.max_passes ||
        JSON.stringify(problem.recipe.coupled_masks) !== JSON.stringify(recipe.coupled_masks)
      ) {
        throw new Error(
          'Candidate identity requires the frozen work recipe; rebuild after changing recipe.json.',
        );
      }
      const start = performance.now();
      const { outcome, wasm_memory_bytes } = core.solve(problem);
      const elapsed_ms = performance.now() - start;
      if (outcome.kind === 'failed') throw new Error(outcome.issue);
      const s = outcome.selection;
      return {
        elapsed_ms,
        outcome,
        wasm_memory_bytes,
        record: {
          status: 'planned',
          generation: 'ready-wasm-v1',
          decisions: {
            pool_w: s.quarters.map((q) => q.pool_command_w),
            ev_w: s.commands.map((c) =>
              c.ev_amps * problem.charger.voltage_v * problem.charger.phase_count
            ),
            battery_charge_w: s.quarters.map((q) => q.charge_w),
            battery_discharge_w: s.quarters.map((q) => q.discharge_w),
            battery_follow: s.commands.map((c, i) => ({
              follows: ['self_consumption', 'supply_house', 'hold'].includes(c.battery),
              charge_limit_w: ['hold', 'supply_house'].includes(c.battery) ? 0 : c.charge_limit_w,
              discharge_limit_w: c.battery === 'hold' ? 0 : c.discharge_limit_w,
              planned: [s.quarters[i].charge_w, s.quarters[i].discharge_w],
            })),
          },
          beliefs: {
            import_sek_per_kwh: problem.slots.map((s) => s.import_price),
            grid_cost_sek: s.account.cash_sek,
          },
          curves: [],
          valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
        },
      };
    },
  };
}
