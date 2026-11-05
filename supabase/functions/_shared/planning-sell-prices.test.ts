import { assertAlmostEquals, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { batterySnapshot, dispatchedEvSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { EXPORT_SCHEDULE, GRID_CALCULATION_MODEL, type GridTariffCatalogue } from "./energy-grid-pricing.ts";
import { readPlanningSellPrices, resolvePlanningSellPrices } from "./planning-sell-prices.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { prepareCapturedRulesInput } from "./rules-planning-execution.ts";
import { recoverRetainedBattery } from "./rules-commitments.ts";
import { generateRulesPlan } from "./rules-planner.ts";

// Independently specified synthetic rates. No household price history or plan data.
const definition = (transfer: number, low: number) => ({
  schema_version: 1, vat_rate: .25, energy_tax: { ore_per_kwh_ex_vat: 20 },
  plans: { three_phase: { selector: "fuse_a", transfer: { mode: "flat", ore_per_kwh_ex_vat: transfer } } },
  export_credit: { schedule: EXPORT_SCHEDULE, ore_per_kwh_ex_vat_by_area: { synthetic: { low, high: 7 } } },
});
const catalogue: GridTariffCatalogue = {
  timezone: "Europe/Stockholm",
  configuration: {
    profile_id: "synthetic", connection_type: "three_phase", grid_area: "synthetic",
    energy_tax_reduced: false, include_vat: true, export_vat_registered: false,
    production_enabled: true, fuse_periods: [{ valid_from: null, fuse_a: 20 }],
  },
  profiles: [{ id: "synthetic", versions: [
    { revision: "grid-1", valid_from: "2026-01-01", valid_to: "2026-01-16", calculation_model: GRID_CALCULATION_MODEL, definition: definition(20, 3) },
    { revision: "grid-2", valid_from: "2026-01-17", valid_to: null, calculation_model: GRID_CALCULATION_MODEL, definition: definition(30, 5) },
  ] }],
};
const supplierDefinition = {
  schema_version: 1, vat_rate: .25, monthly_fee_sek_in_vat: 0,
  import: { spot_multiplier: 1, fixed_markup_sek_per_kwh_ex_vat: .06, variable_cost_sek_per_kwh_ex_vat: .04 },
  export: { spot_multiplier: 1, adjustment_sek_per_kwh: -.02 },
};
const supplier = [
  { revision: "supplier-1", valid_from: "2026-01-01", valid_to: "2026-01-16", definition: supplierDefinition },
  { revision: "supplier-2", valid_from: "2026-01-17", valid_to: null, definition: {
    ...supplierDefinition, vat_rate: 0, import: { ...supplierDefinition.import, spot_multiplier: .8 },
    export: { ...supplierDefinition.export, spot_multiplier: .6 },
  } },
];
const unquoted = (start: string) => ({ start, import_price_sek_per_kwh: null, export_price_sek_per_kwh: null });

Deno.test("quarterly buy–sell margins follow spot, the grid band and tariff revisions", () => {
  // Columns are UTC start, all-in buy, expected sell and expected margin.
  const cases = [
    ["2026-01-16T04:45:00Z", 1.125, .41, .715],  // 05:45 local, low band, .4 spot
    ["2026-01-16T05:00:00Z", 1.125, .45, .675],  // same spot, 06:00 local high band
    ["2026-01-16T05:15:00Z", 2.125, 1.25, .875], // high band, 1.2 spot
    ["2026-01-16T05:30:00Z", -.375, -.75, .375], // high band, -.8 spot
    ["2026-01-16T22:45:00Z", 1.125, .41, .715],  // 23:45 local, old terms
    ["2026-01-16T23:00:00Z", 1.125, .33, .795],  // local midnight, new supplier and grid terms
  ] as const;
  const sells = resolvePlanningSellPrices(cases.map(([start]) => unquoted(start)), cases.map(([, buy]) => buy), catalogue, supplier);
  cases.forEach(([, buy, sell, margin], i) => {
    assertEquals(sells[i], sell);
    assertAlmostEquals(buy - sells[i]!, margin, 1e-10);
  });
});

Deno.test("published prices take precedence and a missing tariff stays unknown", () => {
  const slot = unquoted("2026-01-16T05:00:00Z");
  const slots = [{ ...slot, export_price_sek_per_kwh: 0 }, { ...slot, export_price_sek_per_kwh: -.4 },
    { ...slot, import_price_sek_per_kwh: 2.125 }, unquoted("2026-02-01T00:00:00Z")];
  assertEquals(resolvePlanningSellPrices(slots, [9, 9, 9, 9], catalogue, supplier.slice(0, 1)), [0, -.4, 1.25, null]);
});

Deno.test("live tariff lookup reads the planning home's settings and applies the configured supplier", async () => {
  const { production_enabled: _solar, fuse_periods: _fuses, ...settings } = catalogue.configuration!;
  const paths: string[] = [];
  const db = createClient("https://synthetic.example", "synthetic-key", { global: { fetch: input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const table = url.pathname.split("/").at(-1)!;
    paths.push(table);
    if (table === "home_answers" || table === "home_fuse_changes") assertEquals(url.searchParams.get("home_id"), "eq.synthetic-home");
    if (table === "energy_supplier_profiles") assertEquals(url.searchParams.get("provider_key"), "eq.synthetic");
    const responses = {
      home_answers: [
        { answer_value: 20, question: { semantic_key: "main_fuse_a" } },
        { answer_value: true, question: { semantic_key: "has_solar" } },
        { answer_text: "Synthetic", question: { semantic_key: "electricity_supplier" } },
      ],
      home_fuse_changes: [],
      energy_tariff_settings: [{ ...settings, profile: catalogue.profiles[0] }],
      energy_supplier_profiles: [{ versions: supplier }],
    };
    return Promise.resolve(Response.json(responses[table as keyof typeof responses]));
  } } });
  assertEquals(await readPlanningSellPrices(db, "synthetic-home", [unquoted("2026-01-16T23:00:00Z")], [1.125]), [.33]);
  assertEquals(paths.sort(), ["energy_supplier_profiles", "energy_tariff_settings", "home_answers", "home_fuse_changes"]);
});

Deno.test("the planner uses captured margins and continues when a quarter's tariff is unavailable", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const buy = [1.125, 2.125, 1.125, 1.125, 1.125, 1.125, 1.125, 1.125];
  snapshot.slots.forEach((slot, i) => {
    slot.import_price_sek_per_kwh = i < 3 ? null : buy[i];
    slot.export_price_sek_per_kwh = i < 4 ? null : .1;
  });
  snapshot.slots[3].export_price_sek_per_kwh = 0;
  snapshot.captured_at = snapshot.slots[1].start;
  const sell = [.41, 1.21, null, 9, .1, .1, .1, .1];
  const capture = captureRulesPlanningInput({
    snapshot, now: snapshot.captured_at, resolved_price_outlook: {
      shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1.125,
      shadow_import_sek_per_kwh: buy, shadow_export_sek_per_kwh: sell,
    },
  }, null, resolveRulePolicy());
  sell[1] = 9;
  const prepared = prepareCapturedRulesInput(capture);
  assertEquals(prepared.problem.slots.slice(0, 3).map(slot => slot.export_price), [1.21, 0, 0]);
  assertEquals(prepared.problem.slots[1].battery_export_allowed, false);
  const { plan } = generateRulesPlan(prepared);
  assertEquals(plan.status, "ready");
  assertEquals(plan.plans.priority.slots.slice(0, 3).map(slot => slot.shadow_export_sek_per_kwh), [1.21, null, 0]);
  assertAlmostEquals(plan.plans.priority.slots[0].shadow_import_sek_per_kwh - plan.plans.priority.slots[0].shadow_export_sek_per_kwh!, .915, 1e-10);
  assertEquals(plan.planning_warnings?.filter(warning => warning.code === "sell_tariff_unavailable").length, 1);
});

Deno.test("an unavailable sell tariff preserves a held battery export but blocks new exports", () => {
  const snapshot = batterySnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.policy.battery_export_enabled = true;
  snapshot.policy.battery_export_reserve_soc = .05;
  const { price_outlook } = rulesFixtureInput(snapshot);
  const capture = (reference: Parameters<typeof captureRulesPlanningInput>[1]) => captureRulesPlanningInput({
    snapshot, now: snapshot.captured_at, resolved_price_outlook: price_outlook,
  }, reference, resolveRulePolicy());
  const { plan } = generateRulesPlan(prepareCapturedRulesInput(capture(null)));
  const accepted = plan.plans.priority.slots;
  accepted[0].battery_instruction = { kind: "export", profile_id: "synthetic", discharge_ac_w: 1000 };
  snapshot.slots[0].export_price_sek_per_kwh = null;
  snapshot.slots[5].export_price_sek_per_kwh = null;
  const prepared = prepareCapturedRulesInput(capture({ plan_id: plan.plan_id, slots: accepted }));
  assertEquals(prepared.problem.accepted?.[0].battery, "export");
  assertEquals(prepared.problem.slots[0].battery_export_allowed, undefined);
  assertEquals(prepared.problem.slots[5].battery_export_allowed, false);
  const recovered = recoverRetainedBattery(prepared, "committed_command_infeasible:0:native_battery_power_limit");
  assertEquals(recovered?.problem.slots[0].battery_export_allowed, false);
});
