import type { GeneratedPlan, PlanSummary } from './contracts.ts';
import { comparePlans, formatSigned } from './plan-comparison.ts';

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const summary = (overrides: Partial<PlanSummary>): PlanSummary => ({
  load_kwh: 0,
  flexible_load_kwh: 0,
  pv_kwh: 0,
  grid_import_kwh: 0,
  grid_export_kwh: 0,
  curtailed_kwh: 0,
  priced_import_kwh: 0,
  priced_export_kwh: 0,
  net_cost_sek: 0,
  terminal_adjusted_cost_sek: 0,
  battery_soc_start: 0,
  battery_soc_end: 0,
  battery_soc_low: 0,
  battery_end_of_solar_soc: {},
  service_required_kwh: 0,
  service_delivered_kwh: 0,
  ...overrides,
});

const generatedPlan = (planSummary: PlanSummary): GeneratedPlan => ({
  key: 'priority',
  label: 'With plan',
  status: 'ready',
  validation_errors: [],
  slots: [],
  summary: planSummary,
  service_slots: {},
  service_currents_a: {},
});

Deno.test('plan comparison uses with-plan minus without-plan consistently', () => {
  const result = comparePlans(
    generatedPlan(summary({
      load_kwh: 20,
      grid_import_kwh: 4,
      grid_export_kwh: 7,
      net_cost_sek: 2.5,
      terminal_adjusted_cost_sek: -1.25,
    })),
    generatedPlan(summary({
      load_kwh: 20,
      grid_import_kwh: 6.5,
      grid_export_kwh: 5,
      net_cost_sek: 4,
      terminal_adjusted_cost_sek: 0.75,
    })),
  );

  assertEquals(result, {
    loadKwhDelta: 0,
    gridImportKwhDelta: -2.5,
    gridExportKwhDelta: 2,
    netCostSekDelta: -1.5,
    terminalAdjustedCostSekDelta: -2,
  }, 'comparison deltas');
});

Deno.test('signed values make cost direction explicit without negative zero', () => {
  assertEquals(formatSigned(-2.345, 2), '−2.35', 'negative value');
  assertEquals(formatSigned(2.345, 2), '+2.35', 'positive value');
  assertEquals(formatSigned(-0.0001, 2), '0.00', 'rounded negative zero');
});
