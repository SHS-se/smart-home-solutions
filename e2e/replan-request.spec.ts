import { runRulesPlanner } from "../supabase/functions/_shared/run-rules-planner.ts";
/**
 * "Planera om nu", fully local — no real backend.
 *
 * The button used to re-solve the snapshot stored beside the plan, and failed
 * with `captured_at must describe a fresh snapshot` whenever that snapshot had
 * aged past the planner's fifteen-minute limit — which is most of every
 * quarter. It now records a request the house answers with fresh measurements,
 * so what a person sees after pressing it is a wait rather than a result.
 *
 * The rules behind that wait have unit tests. What they cannot reach is the
 * part that failed before: pressing the button and being told something true.
 *
 * Run with a local dev server:
 *   E2E_BASE_URL=http://localhost:8080 npx playwright test e2e/replan-request.spec.ts
 */
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';
import { CAPTURED_AT, snapshot } from '../src/lib/energy-shift/optimisation-snapshot.fixture';

import { mixedModeSnapshot } from '../scripts/generate-ha-plan-fixture';
import { readFileSync } from 'node:fs';
const mixedModeFixture = JSON.parse(readFileSync(new URL('../contracts/ha-api/fixtures/schema-9-mixed-mode-plan.json', import.meta.url), 'utf8'));
import { baselineFixture } from '../src/lib/home-baseline/fixture';
import { mockRoiHistory, expectRoiMonths } from './helpers/roi-history';
import { portalDelta } from './helpers/portal-delta';

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const HOME_ID = 'cccccccc-dddd-4eee-8fff-111111111111';
const REQUEST_ID = '2f1c0c74-9d31-4f0e-9a45-9c6f2f5f0a11';

// Solved at the snapshot's own capture time, which is also the clock the browser
// is pinned to below: a plan the page considers current, as in service.
const PLAN = runRulesPlanner({ snapshot: snapshot(), now: (new Date(CAPTURED_AT)).toISOString(), price_archive: [] }).plan;

function withoutRulePoints(plan:typeof PLAN):typeof PLAN {
 const copy=structuredClone(plan);
 for(const scenario of Object.values(copy.plans)) for(const slot of scenario.slots) delete slot.rule_points;
 return copy;
}

async function isTestWebsite(page: Page): Promise<boolean> {
  return page.getByText(/TESTMILJÖ -|TEST ENVIRONMENT -/).isVisible();
}

async function expectTestPlanStatus(page: Page) {
  await expect(page.getByTestId('test-plan-status')).toContainText(/TEST styr inte Home Assistant|TEST does not control Home Assistant/);
  await expect(page.getByTestId('test-plan-status')).toContainText(/produktionsmiljöns plan|production plan/);
  await expect(page.getByTestId('ha-plan-identity')).toHaveCount(0);
  await expect(page.getByText(/Annan plan i HA|Different plan in HA|Senast rapporterad redo i HA|Last reported ready in HA/)).toHaveCount(0);
}

function fakeJwt(sub: string, email: string, expiresAt: number): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: 'HS256', typ: 'JWT' }),
    enc({ sub, email, aud: 'authenticated', role: 'authenticated', exp: expiresAt, iat: now }),
    'x'.repeat(43),
  ].join('.');
}

interface ReplanColumns {
  replan_request_id: string | null;
  replan_requested_at: string | null;
  replan_completed_request_id: string | null;
  replan_error: string | null;
  replan_recommendations?: Array<{key: string; reason: string; occurred_at: string}>;
}

const idle: ReplanColumns = {
  replan_request_id: null,
  replan_requested_at: null,
  replan_completed_request_id: null,
  replan_error: null,
};

/**
 * The row as the portal reads it, with the replan columns under the test's
 * control. Held in a mutable cell so pressing the button can change what the
 * next read returns, which is the whole behaviour being checked.
 */
interface MockPlanState {
  accuracy?: Record<string, unknown>;
  row: ReplanColumns;
  reportedPlanId?: string;
  reportedValidUntil?: string;
  acknowledgement?: { status: 'pending' | 'accepted' | 'rejected'; message: string | null; version: string | null };
  publishedPlan?: typeof PLAN;
  unsupportedPlan?: boolean;
  refreshing?: boolean;
  readError?: boolean;
  history?: Array<{ start_ts: string; total_load_kwh: number }>;
  deviceHistory?: Array<{ start_ts: string; device_energy_kwh: Record<string, number> }>;
  poolHistory?: Array<{ start_ts: string; water_temperature_c: number }>;
  devices?: Array<Record<string, unknown>>;
}

async function mockBackend(context: BrowserContext, replan: MockPlanState, plan = PLAN, planSnapshot = snapshot()) {
  const nowIso = new Date().toISOString();
  // Reloading ROI uses the historical fixture's fixed clock, which can be ahead
  // of the test runner. Keep mocked sessions valid on both clocks.
  const expiresAt = Math.floor(Math.max(Date.now(), Date.parse(baselineFixture().end)) / 1000) + 3600;
  const email = 'ana@example.com';
  const user = {
    id: CUSTOMER_USER_ID,
    email,
    aud: 'authenticated',
    role: 'authenticated',
    email_confirmed_at: nowIso,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: nowIso,
    updated_at: nowIso,
  };

  await context.route('**/auth/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/token')) {
      await route.fulfill({
        json: {
          access_token: fakeJwt(CUSTOMER_USER_ID, email, expiresAt),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: expiresAt,
          refresh_token: 'fake-refresh-token',
          user,
        },
      });
    } else if (url.pathname.endsWith('/user')) {
      await route.fulfill({ json: user });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  await context.route('**/functions/v1/**', async route => {
    if (!route.request().url().includes('energy-optimisation-replan')) {
      await route.fulfill({ json: {} });
      return;
    }
    // What the edge function does: record the request and acknowledge it. No
    // plan comes back, because no plan can be built from here.
    replan.row = {
      replan_request_id: REQUEST_ID,
      replan_requested_at: CAPTURED_AT,
      replan_completed_request_id: null,
      replan_error: null,
    };
    await route.fulfill({
      status: 202,
      json: { status: 'queued', replan_request_id: REQUEST_ID },
    });
  });
  await context.route('**/storage/v1/**', route => route.fulfill({ json: [] }));

  await context.route('**/rest/v1/**', async route => {
    const shown = replan.publishedPlan ?? plan;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/rpc/get_energy_forecast_accuracy')) {
      await route.fulfill({json: replan.accuracy ?? null});
      return;
    }
    if (url.pathname.endsWith('/rpc/get_energy_portal_delta')) {
      if (replan.readError) {
        await route.fulfill({ status: 503, json: { message: 'Database temporarily unavailable' } });
        return;
      }
      await route.fulfill({ json: { ...portalDelta(route.request().postDataJSON().p_known, {
        current: {
          home_id: HOME_ID,
          captured_at: CAPTURED_AT,
          updated_at: CAPTURED_AT,
          plan_id: shown.plan_id,
          generation_request_id: REQUEST_ID,
          plan_schema_version: shown.schema_version,
          ha_runtime: replan.reportedPlanId ? {
            plan_id: replan.reportedPlanId, observed_at: CAPTURED_AT, state: 'ready',
            reason: 'A validated plan is available', binding_until: shown.binding_until,
            valid_until: replan.reportedValidUntil ?? shown.valid_until, recovering: replan.refreshing ?? false, retry_at: null, last_error: null,
          } : null,
          ha_runtime_received_at: replan.reportedPlanId ? CAPTURED_AT : null,
          ha_ack_status: replan.acknowledgement?.status ?? 'accepted',
          ha_acknowledged_at: CAPTURED_AT,
          ha_integration_version: replan.acknowledgement?.version ?? null,
          ha_ack_request_id: null,
          ha_ack_error: replan.acknowledgement?.message ? { message: replan.acknowledgement.message } : null,
          ...replan.row,
        },
        plan: replan.unsupportedPlan ? { ...shown, schema_version: 999 } : shown,
        devices: replan.devices ?? [],
      }),
      device_actuals: {
        upserts: (replan.deviceHistory ?? []).map(row => ({ row, hash: JSON.stringify(row) })), removed: [],
      },
      actuals: {
        upserts: (replan.history ?? []).map(row => ({ row, hash: JSON.stringify(row) })), removed: [],
      } } });
      return;
    }
    if (url.pathname.includes('/rpc/')) {
      // The quarter-series readers return rows; access checks return a boolean.
      await route.fulfill({
        json: url.pathname.includes('get_energy_optimisation') ? [] : false,
      });
      return;
    }
    const table = url.pathname.split('/').pop() || '';
    const rows: Record<string, unknown>[] = table === 'staff_users'
      ? []
      : table === 'customers_with_identity'
      ? [{ id: CUSTOMER_ID, user_id: CUSTOMER_USER_ID, name: 'Ana', primary_home_id: HOME_ID }]
      : table === 'customers'
      ? [{ id: CUSTOMER_ID, primary_home_id: HOME_ID }]
      : table === 'energy_optimisation_current'
      // User-requested replay downloads read the source snapshot separately from sync.
      ? [{ snapshot: planSnapshot, plan: shown }]
      : table === 'energy_optimisation_pool_slots'
      ? replan.poolHistory ?? []
      : [];
    const single = (route.request().headers().accept || '').includes('vnd.pgrst.object');
    await route.fulfill({
      status: single && rows.length === 0 ? 406 : 200,
      contentType: 'application/json',
      body: JSON.stringify(single ? rows[0] ?? null : rows),
    });
  });
}

const replanButton = /Planera om nu|Replan now/;

test.describe('requesting a replan', () => {
  let replan: MockPlanState;

  test.beforeEach(async ({ context, page }) => {
    replan = { row: { ...idle } };
    // The fixture snapshot is dated, and a plan is only shown while it is
    // current. Pinning the clock to its capture time keeps the timers running
    // while making the plan on file the one this house is executing.
    await page.clock.setFixedTime(new Date(CAPTURED_AT));
    await mockBackend(context, replan);
    // Auth is intercepted, so the form is just how the app is told a session
    // exists — nothing here is a credential.
    await page.goto('/login');
    await page.fill('#email', 'whoever@example.com');
    await page.fill('#password', 'mock-password');
    await page.getByRole('button', { name: 'Logga in' }).click();
    await page.waitForURL(url => !url.pathname.endsWith('/login'));
  });

  test('customer ROI uses optimizer replay and original bills, with subscription only in ROI', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    await expect(page.getByTestId('roi-baseline')).toHaveCount(0);
    await expect(page.getByRole('img', { name: /power flows|effektflöden/i })).toHaveCount(0);
    const cells = page.getByTestId('scheduler-totals').locator('td');
    const totals = history.saved()!.months;
    const totalGross = Object.values(totals).reduce((n,m) => n + m.ledger.modeled.baselineBill.totalSek - m.ledger.modeled.schedulerBill.totalSek,0);
    await expect(page.getByTestId('roi-period-net')).toContainText('SEK');
    expect(Object.values(totals).every(m => m.ledger.replay.solves > 0)).toBe(true);
    const contract = page.getByTestId('roi-period-saving'), saving = await contract.textContent();
    const reads = history.reads();
    await page.getByTestId('comparison-settings').locator('summary').click();
    await expect(page.getByTestId('roi-supplier-basis')).toHaveCount(0);
    await expect(page.getByTestId('roi-supplier-terms')).toContainText(/7[.,]50 öre\/kWh/);
    await expect(page.getByTestId('roi-supplier-terms')).toContainText(/4[.,]40 öre\/kWh/);
    await expect(page.getByTestId('roi-supplier-terms')).toContainText('2026-09');
    expect(Object.values(history.saved()!.months).every(m => m.ledger.assumedPriceQuarters === 0)).toBe(true);
    await page.locator('#roi-subscription').fill('0');
    await expect(contract).toHaveText(saving!);
    const gross = await cells.nth(2).textContent();
    expect(totalGross).toBeCloseTo(Object.values(totals).reduce((n,m)=>n+m.ledger.modeled.baselineBill.totalSek-m.ledger.modeled.schedulerBill.totalSek,0));
    await expect(page.getByTestId('roi-period-net')).toHaveText(gross!);
    await expect(page.locator('#roi-rate')).toHaveCount(0);
    // The estimate never mixes in invoices or hardware payback; bills sit in their own section.
    for (const gone of ['#roi-basis', '#roi-equipment', '#roi-installation']) await expect(page.locator(gone)).toHaveCount(0);
    await expect(page.getByTestId('roi-payback')).toHaveCount(0);
    await expect(page.getByTestId('scheduler-month-2026-09').locator('td')).toHaveCount(4);
    await expect(page.getByTestId('savings-assumptions')).toContainText(/30[.,]5 °C/);
    // No planning run has recorded SHS control here, so there is no track record yet, only the promise of one.
    await expect(page.getByTestId('track-record')).toHaveCount(0);
    await expect(page.getByTestId('track-record-pending')).toBeVisible();
    await page.getByTestId('what-happened').locator('summary').first().click();
    await expect(page.getByTestId('billed-month-2026-09').getByTestId('roi-amount')).toHaveText('579,00 SEK');
    // Tall enough to hold the whole tab: a stitched full-page capture repeats the sticky header mid-page.
    await page.setViewportSize({ width: 1280, height: 1700 });
    await page.screenshot({ path: 'test-results/savings-tab.png' });
    expect(history.reads()).toBe(reads);
    await page.locator('#roi-from').fill('2025-10');
    await expect(page.getByRole('alert')).toContainText('at most 12 months');
    await expect(page.getByTestId('roi-period-net')).toHaveText('—');
    expect(history.reads()).toBe(reads);
  });

  test('ROI reloads durable monthly totals without fetching history or generating charts', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    let billsAvailable = false;
    await context.route('**/rest/v1/energy_billing_documents*', route => route.fulfill({ json: billsAvailable ? ['electricity', 'grid'].map(kind => ({
      id: `new:${kind}`, customer_id: CUSTOMER_ID, document_kind: kind,
      period_start: '2026-09-01', period_end: '2026-09-30', total_amount_sek: kind === 'electricity' ? 123 : 456,
      consumption_kwh: 100, exported_kwh: null, peak_demand_kw: null, file_path: null, energy_billing_line_items: [],
    })) : [] }));
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    const net = await page.getByTestId('roi-period-net').textContent();
    expect(Object.keys(history.saved()!.months)).toHaveLength(2);
    expect(JSON.stringify(history.saved())).not.toContain('gridImportW');
    const evidence = history.saved()!.months['2026-09'].ledger;
    expect(evidence.modeled.baselineBill.gridPeakSek).toBeGreaterThan(0);
    expect(evidence.modeled.schedulerBill.gridPeakSek).toBeGreaterThan(0);
    const displayed = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
    const expectedBaseline = evidence.baseline.costSek + evidence.modeled.baselineBill.supplierFixedSek + evidence.modeled.baselineBill.gridFixedSek;
    const expectedScheduler = evidence.scheduler.costSek + evidence.modeled.schedulerBill.supplierFixedSek + evidence.modeled.schedulerBill.gridFixedSek;
    await expect(page.getByTestId('scheduler-month-2026-09').locator('td').nth(0)).toHaveText(displayed(expectedBaseline));
    await expect(page.getByTestId('scheduler-month-2026-09').locator('td').nth(1)).toHaveText(displayed(expectedScheduler));
    const savedBeforeReload = JSON.stringify(history.saved());
    const before = history.windows.length;
    await page.reload();
    await expectRoiMonths(page, '(2/2)');
    await expect(page.getByTestId('roi-period-net')).toHaveText(net!);
    expect(history.windows.length).toBe(before);
    expect(JSON.stringify(history.saved())).toBe(savedBeforeReload);
    await expect(page.getByTestId('roi-baseline')).toHaveCount(0);
    const row = page.getByTestId('scheduler-month-2026-09'), billed = page.getByTestId('billed-month-2026-09');
    await expect(row.getByTestId('actual-installations')).toHaveCount(0);
    await page.getByTestId('what-happened').locator('summary').first().click();
    await expect(billed.locator('th').getByTestId('actual-installations')).toContainText('Bergvärme');
    await expect(billed.locator('td').getByTestId('actual-installations')).toHaveCount(0);
    await expect(page.getByTestId('scheduler-months').locator('thead th').first()).toHaveCSS('text-align','left');
    await billed.getByTestId('actual-installations').locator('summary').click();
    await expect(billed.getByTestId('actual-installations')).toContainText(/ground-source heat pump|Bergvärmen/);
    await expect(page.getByTestId('comparison-evidence')).toHaveCount(0);
    await expect(page.getByTestId('roi-assumption-impact')).toHaveCount(0);
    // A deployment adds missing invoices; polling updates Actual without repinning
    // the equipment or rerunning any completed baseline/scheduler projections.
    await expect(billed.getByTestId('roi-amount')).toHaveText('—');
    const savedBeforeBills = JSON.stringify(history.saved());
    const modelCells = await Promise.all([0, 1, 2].map(index => row.locator('td').nth(index).textContent()));
    const readsBeforeBills = history.reads();
    billsAvailable = true;
    await expect(billed.getByTestId('roi-amount')).toHaveText('579,00 SEK', { timeout: 45_000 });
    expect(await Promise.all([0, 1, 2].map(index => row.locator('td').nth(index).textContent()))).toEqual(modelCells);
    expect(JSON.stringify(history.saved())).toBe(savedBeforeBills);
    expect(history.reads()).toBe(readsBeforeBills);
    await page.getByTestId('scheduler-calculate').click();
    await expect.poll(() => history.saved()?.generation).toBe(2);
    await expect.poll(() => Object.keys(history.saved()!.months).length, { timeout: 240_000 }).toBe(2);
    await expectRoiMonths(page, '(2/2)');
    expect(history.saved()!.generation).toBe(2);
    expect(history.windows.length).toBeGreaterThan(before);
  });

  test('the model check prices metered use like an itemised invoice, both without the demand charge', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    // September's grid invoice itemises its lines: 80 kr demand charge and 25 % VAT on 364.80 kr of lines.
    const line = (category: string, amount_sek: number, sort_order: number) => ({ category, amount_sek, sort_order, quantity: null, label: category, period_start: null, period_end: null });
    await context.route('**/rest/v1/energy_billing_documents*', route => route.fulfill({ json: ['electricity', 'grid'].map(kind => ({
      id: `09:${kind}`, customer_id: CUSTOMER_ID, document_kind: kind, period_start: '2026-09-01', period_end: '2026-09-30',
      total_amount_sek: kind === 'electricity' ? 123 : 456, consumption_kwh: 100, exported_kwh: null, peak_demand_kw: null, file_path: null,
      energy_billing_line_items: kind === 'grid' ? [line('fixed_fee', 100, 0), line('energy_transfer', 184.8, 1), line('peak_demand', 80, 2), line('vat', 91.2, 3)] : [],
    })) }));
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    const september = history.saved()!.months['2026-09'].ledger;
    const priced = september.recorded.costSek + september.modeled.baselineBill.supplierFixedSek + september.modeled.baselineBill.gridFixedSek;
    const display = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
    // 579 kr billed, less the demand charge with its VAT (100 kr).
    await expect(page.getByTestId('model-check')).toContainText(/modellens priser för din uppmätta el låg .* (över|under) fakturorna \(1 månad\)/);
    await page.getByTestId('what-happened').locator('summary').first().click();
    const row = page.getByTestId('billed-month-2026-09');
    await expect(row.locator('td').nth(0)).toHaveText('579,00 SEK');
    await expect(row.locator('td').nth(1)).toHaveText('479,00 SEK');
    await expect(row.getByTestId('model-price')).toHaveText(display(priced));
    // October has no invoice yet, so it is not compared.
    await expect(page.getByTestId('billed-month-2026-10').getByTestId('model-price')).toHaveText('—');
  });

  test('the track record counts only full months SHS controlled, against the estimate for those months', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    const requests: Record<string, unknown>[] = [];
    await context.route('**/rest/v1/rpc/get_energy_control_months*', route => {
      requests.push(route.request().postDataJSON());
      // September fully controlled; October is still in progress.
      return route.fulfill({ json: [
        { month_key: '2026-09', runs: 1000, controlling: { $battery: 1000, $pool: 990, $ev: 1000 } },
        { month_key: '2026-10', runs: 500, controlling: { $battery: 500, $pool: 500, $ev: 500 } },
      ] });
    });
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    const september = history.saved()!.months['2026-09'].ledger;
    const display = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
    const record = page.getByTestId('track-record');
    await expect(record).toContainText('under de 1 månad SHS styrde huset');
    await expect(record).toContainText(display(september.baseline.costSek - september.recorded.costSek));
    await expect(record).toContainText(display(september.baseline.costSek - september.scheduler.costSek));
    expect(requests.at(-1)).toMatchObject({ p_customer_id: CUSTOMER_ID, p_home_id: HOME_ID, p_time_zone: 'Europe/Stockholm' });
  });

  test('the estimate holds one pool temperature in both columns, and changing it recalculates', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    await expect(page.getByTestId('savings-assumptions')).toContainText(/30[.,]5 °C/);
    await page.getByTestId('comparison-settings').locator('summary').click();
    // Nothing to apply until the temperature differs, is valid, and the home's comfort target is not already in use.
    await expect(page.locator('#roi-pool-target')).toHaveValue('30.5');
    await expect(page.getByTestId('roi-pool-apply')).toBeDisabled();
    await expect(page.getByTestId('roi-pool-comfort')).toHaveCount(0);
    await page.locator('#roi-pool-target').fill('45');
    await expect(page.getByTestId('roi-pool-apply')).toBeDisabled();
    await page.locator('#roi-pool-target').fill('27');
    await page.getByTestId('roi-pool-apply').click();
    await expect.poll(() => history.saved()?.generation).toBe(2);
    expect(history.saved()!.model.comfort!.pool!.target_c).toBe(27);
    await expect(page.getByTestId('savings-assumptions')).toContainText('27 °C');
    await expect.poll(() => Object.keys(history.saved()!.months).length, { timeout: 240_000 }).toBe(2);
    await expectRoiMonths(page, '(2/2)');
    await expect(page.getByTestId('roi-pool-comfort')).toContainText(/30[.,]5 °C/);
    // A plain recalculation repins the equipment but keeps the estimate's own pool temperature.
    await page.getByTestId('scheduler-calculate').click();
    await expect.poll(() => history.saved()?.generation).toBe(3);
    expect(history.saved()!.model.comfort!.pool!.target_c).toBe(27);
    await page.reload();
    await expect(page.getByTestId('savings-assumptions')).toContainText('27 °C');
  });

  test('ROI only mounts shared charts on request, auto-navigates 72-hour frames and caches them', async ({ context, page }, testInfo) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    const writes: string[] = [];
    page.on('request', req => { if (req.url().includes('/rest/v1/energy_optimisation_') && !['GET', 'HEAD'].includes(req.method())) writes.push(req.url()); });
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    await page.getByTestId('roi-view-graphs').click();
    const viewer = page.getByTestId('roi-baseline');
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    await expect(viewer.getByRole('group', { name: /Day|Dag/ })).toHaveCount(0);
    await expect(viewer.getByTestId('period-comparison').locator('tbody tr').last().locator('td').nth(1)).toHaveText('—');
    await expect(viewer.getByRole('button', { name: /Full 72 h|Hela 72 h/ })).toHaveCount(0);
    await expect(page.getByTestId('baseline-next')).toBeDisabled();
    await expect(page.getByTestId('baseline-details')).not.toHaveAttribute('open', '');
    await viewer.getByTestId('baseline-details').locator('summary').first().click();
    await expect(page.getByTestId('baseline-models')).toContainText(/80% from midnight|80% från midnatt/);
    await expect(page.getByTestId('baseline-models')).toContainText('60 W');
    const chart = viewer.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await chart.focus(); await chart.press('ArrowRight'); await chart.press('Enter');
    await expect(page.getByTestId('baseline-quarter')).toContainText(/Driving demand|Körbehov/);
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /Export model|Exportera modell/ }).click();
    const capture = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
    expect(capture.result.series.start).toHaveLength(288);
    expect(capture.engineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.result.projectionMs).toBeLessThan(1000);
    const initialReads = history.reads();
    await page.getByTestId('baseline-previous').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    expect(history.reads()).toBeGreaterThan(initialReads);
    const olderReads = history.reads();
    await page.getByTestId('baseline-next').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    expect(history.reads()).toBe(olderReads);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await viewer.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await viewer.screenshot({ path: testInfo.outputPath('home-baseline-mobile.png') });
    await viewer.getByRole('button', { name: /Close graph|Stäng graf/ }).click();
    await expect(viewer).toHaveCount(0);
    await expectRoiMonths(page, '(2/2)');
    expect(writes).toEqual([]);
  });

  test('ROI May–August sensor gaps generate, and month graphs use the same ledgers as ROI', async ({ context, page }, testInfo) => {
    // Six full native replays plus uncached month graphs run more slowly on CI.
    test.setTimeout(20 * 60_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID, { from: '2026-05', to: '2026-10' });
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(6/6)', 12 * 60_000);
    await page.getByTestId('what-happened').locator('summary').first().click();
    for (const month of ['05', '06', '07', '08']) {
      const row = page.getByTestId(`scheduler-month-2026-${month}`);
      await expect(row.locator('td')).toHaveCount(4);
      await expect(row.locator('td').first()).toContainText('SEK');
      await expect(row).not.toContainText('initial battery SOC');
      await row.getByRole('button', { name: /View graph|Visa graf/ }).click();
      await expect(page.getByTestId('baseline-net-cost')).toHaveText((await row.locator('td').first().textContent())!);
      await page.getByTestId('baseline-details').locator('summary').first().click();
      await expect(page.getByTestId('baseline-models')).toContainText(/Battery|Batteri/);
      await expect(page.getByTestId('baseline-assumptions')).toHaveCount(0);
      const billed = page.getByTestId(`billed-month-2026-${month}`);
      await expect(row.getByTestId('actual-installations')).toHaveCount(0);
      if (month === '05') {
        const period = billed.locator('th');
        await expect(period.getByTestId('actual-installations')).toContainText(/Solar|Solceller/);
        await period.getByTestId('actual-installations').locator('summary').click();
        await expect(period.getByTestId('actual-installations')).toContainText(/battery was installed|Hembatteriet installerades/);
      } else await expect(billed.getByTestId('actual-installations')).toHaveCount(0);
      await page.getByTestId('baseline-details').locator('summary').first().click();
    }
    const september = page.getByTestId('scheduler-month-2026-09');
    await september.getByRole('button', { name: /View graph|Visa graf/ }).click();
    const viewer = page.getByTestId('roi-baseline');
    await expect(page.getByTestId('baseline-frame')).toContainText(/September|september/);
    const display = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
    await expect(page.getByTestId('billed-month-2026-09').getByTestId('roi-amount')).toHaveText('579,00 SEK');
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /Export model|Exportera modell/ }).click();
    const capture = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
    expect(capture.result.series.start).toHaveLength(2880);
    expect(capture.pricingPolicy).toBe('energy-and-fixed-fees-v1');
    expect(capture.tariffEvidence.baselineBill.gridPeakSek).toBeGreaterThan(0);
    expect(capture.tariffEvidence.schedulerBill.gridPeakSek).toBeGreaterThan(0);
    expect(capture.modeled.baselineBill).not.toHaveProperty('gridPeakSek');
    expect(capture.modeled.schedulerBill.totalSek).toBeCloseTo(capture.scheduler.ledger.costSek + capture.modeled.schedulerBill.supplierFixedSek + capture.modeled.schedulerBill.gridFixedSek);
    expect(capture.input.recorded.ledger.costSek).toBe(2879);
    await expect(september.locator('td').nth(0)).toHaveText(display(capture.modeled.baselineBill.totalSek));
    await expect(september.locator('td').nth(1)).toHaveText(display(capture.modeled.schedulerBill.totalSek));
    await expect(september.locator('td').nth(2)).toHaveText(display(capture.modeled.baselineBill.totalSek - capture.modeled.schedulerBill.totalSek));
    const comparison = viewer.getByTestId('period-comparison');
    await expect(comparison.locator('thead th').nth(2)).toHaveText(/Actual consumption|Faktisk förbrukning/);
    const actualCells = comparison.locator('tbody tr');
    const kwh = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`;
    await expect(actualCells.nth(0).locator('td').nth(1)).toHaveText(kwh(capture.input.recorded.ledger.importKwh));
    await expect(actualCells.nth(1).locator('td').nth(1)).toHaveText(kwh(Math.max(0, capture.input.recorded.rows.reduce((sum: number, row: { solarW: number | null }) => sum + (row.solarW ?? 0) / 4000, 0) - capture.input.recorded.ledger.exportKwh)));
    await expect(actualCells.nth(2).locator('td').nth(1)).toHaveText(kwh(capture.input.recorded.ledger.exportKwh));
    await expect(actualCells.last().locator('td').nth(1)).toHaveText('579,00 SEK');
    await expect(actualCells.last().locator('td').nth(2)).toHaveText(display(capture.modeled.schedulerBill.totalSek));
    const windows = history.windows.filter(w => w.start >= capture.input.start && w.end <= capture.input.end).sort((a,b) => a.start.localeCompare(b.start));
    expect(windows[0].start).toBe(capture.input.start); expect(windows.at(-1)!.end).toBe(capture.input.end);
    windows.slice(1).forEach((window, i) => expect(window.start).toBe(windows[i].end));
    const reads = history.reads();
    await page.getByTestId('comparison-graph-scheduler').click();
    await expect(viewer.getByRole('img', { name: /power flows|effektflöden/i }).first()).toContainText(/SHS ENERGY SCHEDULER|SHS ENERGIS/);
    await expect(viewer.getByRole('img', { name: /power flows|effektflöden/i }).first()).toContainText(`${capture.modeled.schedulerBill.totalSek.toFixed(0)} kr`);
    await page.getByTestId('comparison-graph-actual').click();
    await expect(page.getByTestId('comparison-graph-actual')).toHaveText(/Actual consumption|Faktisk förbrukning/);
    const chart = viewer.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await expect(chart).toContainText(/Actual consumption|Faktisk förbrukning/i);
    await chart.focus(); await chart.press('ArrowRight'); await chart.press('Enter');
    await expect(page.getByTestId('baseline-quarter')).not.toContainText(/Driving demand|Körbehov/);
    expect(capture.input.recorded.rows.at(-1).importPriceSekPerKwh).toBe(2);
    expect(capture.input.problem.slots.at(-1).import_price).toBe(1);
    await expect(page.getByTestId('baseline-quarter')).toContainText('2,00 SEK');
    await page.getByTestId('comparison-graph-default').click();
    await expect(chart).toContainText(/BASELINE MODEL|BASMODELL/);
    expect(history.reads()).toBe(reads);
    await page.getByTestId('baseline-previous').click();
    await expect(page.getByTestId('baseline-frame')).toContainText(/August|augusti/);
    await page.getByTestId('baseline-next').click();
    await expect(page.getByTestId('baseline-net-cost')).toHaveText(display(capture.modeled.baselineBill.totalSek));
    expect(history.reads()).toBe(reads);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.getByTestId('contract-roi').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.getByTestId('contract-roi').screenshot({ path: testInfo.outputPath('monthly-roi-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByTestId('contract-roi').screenshot({ path: testInfo.outputPath('monthly-roi-desktop.png') });
  });

  test('ROI recovers an empty month from hourly history and uses the same costs in its graph', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID, { from: '2026-05', to: '2026-05' });
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    const start = '2026-04-30T22:00:00.000Z', end = '2026-05-31T22:00:00.000Z';
    const hours = Array.from({ length: 745 }, (_, i) => ({
      start_ts: new Date(Date.parse(start) + (i - 1) * 3_600_000).toISOString(),
      actual: { total_load_kwh: 1.06, grid_import_kwh: 1, grid_export_kwh: 0, solar_production_kwh: 0,
        battery_charge_kwh: 0, battery_discharge_kwh: 0, battery_soc: .5, ev_soc: .75 },
      device_energy_kwh: { 'heater-id': 0, 'pump-id': .06, 'car-id': 0 },
      pool_c: 31, outdoor_c: null, baseline_load_kwh: null,
      sources: { grid_import_kwh: 'test.hourly' }, invalid_readings: 0,
    }));
    await context.route('**/rest/v1/energy_roi_history_hours*', async route => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('home_id')).toBe(`eq.${HOME_ID}`);
      expect(url.searchParams.get('customer_id')).toBe(`eq.${CUSTOMER_ID}`);
      if (url.searchParams.get('select') === 'start_ts') { await route.fallback(); return; }
      const filters = url.searchParams.getAll('start_ts');
      const from = filters.find(v => v.startsWith('gte.'))!.slice(4), to = filters.find(v => v.startsWith('lt.'))!.slice(3);
      await route.fulfill({ json: hours.filter(h => h.start_ts >= from && h.start_ts < to) });
    });
    await context.route('**/rest/v1/energy_optimisation_actual_slots*', async route => {
      const url = new URL(route.request().url());
      const from = url.searchParams.getAll('start_ts').find(v => v.startsWith('gte.'))?.slice(4);
      if (from && from >= hours[0].start_ts && from < end) await route.fulfill({ json: [] });
      else await route.fallback();
    });
    await context.route('**/rest/v1/rpc/get_energy_optimisation_device_slots*', async route => {
      const body = route.request().postDataJSON();
      if (body.p_from >= start && body.p_from < end) await route.fulfill({ json: [] });
      else await route.fallback();
    });
    await page.goto('/portal/energy-modeling?tab=savings');
    await page.locator('#roi-to').fill('2026-05');
    await expectRoiMonths(page, '(1/1)');
    const row = page.getByTestId('scheduler-month-2026-05');
    const display = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
    await expect(page.getByTestId('billed-month-2026-05').getByTestId('roi-amount')).toHaveText(display(579));
    await expect(page.getByTestId('roi-baseline')).toHaveCount(0);
    await row.getByRole('button', { name: /View graph|Visa graf/ }).click();
    const viewer = page.getByTestId('roi-baseline');
    await expect(viewer.getByTestId('baseline-net-cost')).toHaveText((await row.locator('td').first().textContent())!);
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /Export model|Exportera modell/ }).click();
    const capture = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
    expect(capture.input.recorded.ledger.importKwh).toBe(744);
    expect(capture.input.recorded.ledger.costSek).toBe(744);
    expect(capture.input.recovery.hours).toBe(744);
    expect(capture.input.problem.initial.ev_kwh).toBe(.75 * 75.6);
    await expect(row.locator('td').nth(1)).toHaveText(display(capture.modeled.schedulerBill.totalSek));
    await expect(row.locator('td').nth(2)).toHaveText(display(capture.modeled.baselineBill.totalSek-capture.modeled.schedulerBill.totalSek));
    await expect(page.getByTestId('roi-period-net')).toHaveText(display(capture.modeled.baselineBill.totalSek-capture.modeled.schedulerBill.totalSek-320));
  });

  test('ROI retains saved months when new prices are unavailable and keeps graph navigation usable', async ({ context, page }) => {
    test.setTimeout(300_000);
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID);
    await page.clock.setFixedTime(new Date(Date.parse(history.fixture.end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(2/2)');
    history.failPrices();
    await page.locator('#roi-from').fill('2026-04');
    await expectRoiMonths(page, '(2/7)');
    await expect(page.getByTestId('scheduler-month-2026-04')).toContainText('Missing historical market price');
    history.failPrices();
    await page.getByTestId('roi-view-graphs').click();
    await expect(page.getByTestId('roi-baseline').getByRole('alert')).toContainText('historical market price');
    await expect(page.getByTestId('baseline-net-cost')).toHaveCount(0);
    await expect(page.getByTestId('baseline-generate')).toBeEnabled();
    await expect(page.getByTestId('baseline-previous')).toBeEnabled();
    await expectRoiMonths(page, '(2/7)');
  });

  test('delayed meter energy is disclosed as an estimated interval average in the actual chart', async ({ context, page }, testInfo) => {
    const history = await mockRoiHistory(context, CUSTOMER_ID, HOME_ID, { from: '2026-10', to: '2026-10' });
    const end = history.fixture.end, start = new Date(Date.parse(end) - 3_600_000).toISOString();
    history.correctIntervals([{ field: 'solar_production_kwh', start, end, kwh: 2, source: 'pv' }]);
    await page.clock.setFixedTime(new Date(Date.parse(end) + 900_000));
    await page.goto('/portal/energy-modeling?tab=savings');
    await expectRoiMonths(page, '(1/1)');
    await page.getByTestId('roi-view-graphs').click();
    await page.getByTestId('comparison-graph-actual').click();
    const chart = page.getByTestId('roi-baseline').getByRole('img', { name: /power flows|effektflöden/i }).first();
    await chart.focus(); await chart.press('ArrowRight');
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText(/estimated|uppskattat/);
    await expect(tooltip).toContainText(/reporting interval|rapporteringsintervallet/);
    await expect(tooltip).toContainText('2.00 kW');
    const box = (await tooltip.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(tooltip).not.toContainText(/NaN|Unavailable|Ej tillgänglig/);
    await page.screenshot({ path: testInfo.outputPath('estimated-counter-interval.png') });
  });

  test('missing device readings contribute zero and preserve base load in the tooltip', async ({ page }, testInfo) => {
    replan.publishedPlan = { ...PLAN, device_models: mixedModeFixture.plan.device_models };
    replan.history = [{
      start_ts: new Date(Date.parse(CAPTURED_AT) - 900_000).toISOString(),
      total_load_kwh: 0.65,
    }];
    replan.devices = [{ id: 'heater-id', device_key: 'pool_heater', name: 'Pool heater', planning_role_override: 'controllable' }];
    replan.deviceHistory = [{ start_ts: replan.history[0].start_ts, device_energy_kwh: { 'heater-id': 0.45 } }];
    await page.goto('/portal/energy-modeling?tab=plan');
    const chart = page.getByRole('img', { name: /effektflöden|power flows/i }).first();
    await expect(chart).toBeVisible();
    await chart.focus();
    await chart.press('ArrowLeft');
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).not.toContainText(/Ej tillgänglig|Unavailable|Mätvärden saknas för|Missing readings for/);
    await expect(tooltip).toContainText(/Baslast|Base load/);
    await expect(tooltip).toContainText('0.80 kW');
    await expect(tooltip).toContainText('Pool heater');
    await expect(tooltip).toContainText('1.80 kW');
    await expect(tooltip).toContainText('2.60 kW');
    await expect(tooltip).not.toContainText('NaN');
    await page.screenshot({ path: testInfo.outputPath('partial-consumption.png') });
  });

  test('boiler slot control appears without an economic audit or rule score', async ({ page }, testInfo) => {
    replan.publishedPlan = withoutRulePoints({ ...PLAN, capabilities: { ...PLAN.capabilities, boiler: true },
      plans: { ...PLAN.plans, priority: { ...PLAN.plans.priority, slots: PLAN.plans.priority.slots.map((slot, i) => ({
        ...slot, boiler_permitted: i < 10, boiler_expected_w: i < 10 ? 300 : 0,
      })) } } });
    await page.goto('/portal/energy-modeling?tab=plan');
    const control = page.locator('#plan-slot-control');
    await expect(control).toContainText(/Slot control|Kvartsstyrning/);
    await expect(control.locator('#plan-water-lane')).toBeVisible();
    await expect(page.locator('#plan-audit, #plan-score')).toHaveCount(0);
    await control.locator('[data-water=allowed]').first().click();
    await expect(page.locator('#plan-quarter-explanation [data-boiler-control]')).toContainText(/Water boiler|Varmvattenberedare/);
    await expect(page.locator('#plan-quarter-explanation [data-boiler-control]')).toContainText(/Modeled consumption|Modellerad förbrukning/);
    await expect(page.getByRole('tooltip')).not.toContainText(/Thermostat controlled|Termostaten styr/);
    await page.getByRole('img', { name: /power flows|effektflöden/i }).first().screenshot({ path: testInfo.outputPath('boiler-slot-control.png') });
  });

  test('a plan made by rules shows its score under the chart and explains the picked quarter', async ({ page }, testInfo) => {
    replan.publishedPlan=withoutRulePoints(PLAN);
    // A plan from a planner without rules has no score to show.
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.getByRole('img', { name: /effektflöden|power flows/i }).first()).toBeVisible();
    await expect(page.locator('#plan-score')).toHaveCount(0);
    // The replay download closes the chart's section either way, and says what it holds while there is no score.
    const download = page.getByRole('button', { name: /Ladda ned repris|Download replay/ });
    await expect(page.locator('#plan-quarter-explanation')).toContainText(/Hela planen med indata|The whole plan with its inputs/);
    await expect(download).toBeVisible();

    // The rules planner publishes which rules fired in each planned quarter.
    replan.publishedPlan = { ...PLAN, plan_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', plans: { ...PLAN.plans, priority: { ...PLAN.plans.priority,
      slots: PLAN.plans.priority.slots.map((slot, i) => ({ ...slot, rule_points: i % 2 ? { pool_cold: -2, pool_low: -1 } : {} })) } } };
    await page.reload();
    const strip = page.locator('#plan-score');
    await expect(strip).toContainText(/regelpoäng per kvart|rule points per quarter/);
    const explanation = page.locator('#plan-quarter-explanation');
    await expect(explanation).toContainText(/Klicka på en kvart|Click a quarter/);
    // Only planned quarters are scored, and the strip sits between the chart and the explanation.
    await expect(strip.locator('[data-score="-3"]').first()).toBeVisible();
    await expect(strip.locator('[data-score="0"]').first()).toBeVisible();
    await strip.locator('[data-score="-3"]').first().click();
    await expect(explanation).toContainText('−3');
    await expect(explanation).toContainText('−2 Pool far below target');
    await expect(explanation).toContainText('−1 Pool below target');
    await expect(explanation).toContainText(/kr\/kWh (publicerat|uppskattat|published|estimated)/);
    const chart = (await page.getByRole('img', { name: /effektflöden|power flows/i }).first().boundingBox())!;
    const cell = (await strip.locator('[data-score="-3"]').first().boundingBox())!, why = (await explanation.boundingBox())!;
    expect(cell.y).toBeGreaterThan(chart.y + chart.height * 0.8);
    expect(why.y).toBeGreaterThan(cell.y);
    const button = (await download.boundingBox())!;
    expect(Math.abs(button.y - why.y)).toBeLessThan(8);
    expect(button.x).toBeGreaterThan(why.x + why.width - 1);
    await page.screenshot({ path: testInfo.outputPath('plan-score.png'), fullPage: true });
  });

  test('returning to a hidden tab refreshes measured pool temperature immediately', async ({ page }) => {
    const start = Date.parse(CAPTURED_AT);
    replan.history = [2, 1].map(quartersAgo => ({
      start_ts: new Date(start - quartersAgo * 900_000).toISOString(),
      total_load_kwh: 0.65,
    }));
    replan.poolHistory = [{ start_ts: replan.history[0].start_ts, water_temperature_c: 31.7 }];
    await page.goto('/portal/energy-modeling?tab=plan');
    const chart = page.getByRole('img', { name: /effektflöden|power flows/i }).first();
    await expect(chart).toBeVisible();
    await chart.focus();
    await chart.press('ArrowLeft');
    await expect(page.getByRole('tooltip')).not.toContainText('31.6 °C');
    await chart.press('ArrowLeft');
    await expect(page.getByRole('tooltip')).toContainText('31.7 °C');

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    replan.poolHistory.push({ start_ts: replan.history[1].start_ts, water_temperature_c: 31.64 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await chart.press('ArrowRight');
    await expect(page.getByRole('tooltip')).toContainText('31.6 °C');
  });

  test('TEST ignores stale HA recovery and identity without locking replanning', async ({ page }) => {
    replan.reportedPlanId = REQUEST_ID;
    replan.refreshing = true;
    replan.row = { ...replan.row, ha_runtime_received_at: CAPTURED_AT, ha_runtime: {
      plan_id: REQUEST_ID, observed_at: '2026-08-04T12:00:00Z', state: 'ready', recovering: true,
      binding_until: PLAN.binding_until, valid_until: PLAN.valid_until,
    } };
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
    test.skip(!await isTestWebsite(page), 'TEST has no HA control authority.');
    await expectTestPlanStatus(page);
    await expect(page.getByTestId('plan-refresh-progress')).toHaveCount(0);
    await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
    await page.getByText(/Statusdetaljer|Status details/, { exact: true }).click();
    await expect(page.getByText(/Senaste status från HA|Last status from HA/)).toHaveCount(0);
  });

  for (const samePlan of [true, false]) {
    test(`shows the displayed and HA plan identities when they ${samePlan ? 'match' : 'differ'}`, async ({ page }) => {
      replan.reportedPlanId = samePlan ? PLAN.plan_id : REQUEST_ID;
      await page.goto('/portal/energy-modeling?tab=plan');
      await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
      if (await isTestWebsite(page)) {
        await expectTestPlanStatus(page);
        await page.getByText(/Statusdetaljer|Status details/, { exact: true }).click();
        await expect(page.getByText(/Visat plan-ID|Displayed plan ID/)).toContainText(PLAN.plan_id);
        await expect(page.getByText(/Senast rapporterat plan-ID i HA|Last reported plan ID in HA/)).toHaveCount(0);
        return;
      }
      const identity = page.getByTestId('ha-plan-identity');
      await expect(identity).toContainText(replan.reportedPlanId.slice(0, 8));
      await expect(identity).toContainText(samePlan ? /Samma plan|Same plan/ : /Annan plan|Different plan/);
      await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toHaveText(PLAN.plan_id.slice(0, 8));
      await page.getByText(/Statusdetaljer|Status details/, { exact: true }).click();
      await expect(page.getByText(/Visat plan-ID|Displayed plan ID/)).toContainText(PLAN.plan_id);
      await expect(page.getByText(/Senast rapporterat plan-ID i HA|Last reported plan ID in HA/)).toContainText(replan.reportedPlanId);
      await expect(page.getByText(/var 15:e minut|every 15 minutes/)).toBeVisible();
      await expect(page.getByText(/Nästa omplanering|Next replan/)).toHaveCount(0);
    });
  }

  test('a rejected delivery explains the mismatch without inventing stale live battery readings', async ({ page }) => {
    replan.reportedPlanId = REQUEST_ID;
    replan.acknowledgement = { status: 'rejected', message: 'optimisation plan was not issued recently', version: '0.9.0-beta.86' };
    // Frozen sources cover six hours; the actual plan covers seventy-two.
    await page.clock.setFixedTime(new Date(Date.parse(CAPTURED_AT) + 7 * 60 * 60_000));
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
    if (await isTestWebsite(page)) {
      await expectTestPlanStatus(page);
      await expect(page.getByRole('alert').filter({ hasText: /HA avvisade|HA rejected/ })).toHaveCount(0);
      await page.getByText(/Statusdetaljer|Status details/, { exact: true }).click();
      await expect(page.getByText(/Skapad från HA|Generated from HA/)).toContainText('0.9.0-beta.86');
      await expect(page.getByText(/Accepterad\/avvisad av HA|Acknowledged by HA/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
      return;
    }
    const rejection = page.getByRole('alert').filter({ hasText: /HA avvisade|HA rejected/ });
    await expect(rejection).toContainText('optimisation plan was not issued recently');
    await expect(rejection).toContainText(/tidigare planen fortfarande används|retained plan is still in use/);
    await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
    await rejection.getByText(/Vad det betyder|What this means/).click();
    await expect(rejection).toContainText('0.9.0-beta.86');
    await expect(rejection).toContainText(REQUEST_ID);
    await expect(rejection).not.toContainText(/batteriets mätvärden|battery readings/);
    // A historical ready report is not proof that an expired retained plan executes.
    replan.reportedValidUntil = CAPTURED_AT;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(rejection).not.toContainText(/tidigare planen fortfarande används|retained plan is still in use/);
  });

  test('aged frozen battery provenance does not invalidate a matching ready plan', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.clock.setFixedTime(new Date(Date.parse(CAPTURED_AT) + 7 * 60 * 60_000));
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
    if (await isTestWebsite(page)) {
      await expectTestPlanStatus(page);
      await expect(page.getByRole('alert').filter({ hasText: /batteriets mätvärden|battery readings|avvisade|rejected/ })).toHaveCount(0);
      return;
    }
    await expect(page.getByText(/Senast rapporterad redo i HA|Last reported ready in HA/, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /batteriets mätvärden|battery readings|avvisade|rejected/ })).toHaveCount(0);
  });

  test('a newer unreadable cloud plan cannot confirm the retained older chart', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
    const testWebsite = await isTestWebsite(page);
    if (testWebsite) await expectTestPlanStatus(page);
    else await expect(page.getByTestId('ha-plan-identity')).toContainText(/Samma plan|Same plan/);
    replan.publishedPlan = { ...PLAN, plan_id: REQUEST_ID };
    replan.reportedPlanId = REQUEST_ID;
    replan.unsupportedPlan = true;
    replan.acknowledgement = { status: 'rejected', message: 'Rejection belongs to the newer unreadable plan', version: 'newer-version' };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('alert')).toContainText(/Webbplatsen kan inte visa det mottagna planformatet|The website cannot display the received plan format/);
    await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
    if (testWebsite) await expectTestPlanStatus(page);
    else await expect(page.getByTestId('ha-plan-identity')).toContainText(/Annan plan|Different plan/);
    await expect(page.getByText(/Senast rapporterad redo i HA|Last reported ready in HA/, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).not.toContainText('Rejection belongs to the newer unreadable plan');
  });

  test('configuration refresh retains the plan, locks saves and recovers automatically', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.goto('/portal/energy-modeling?tab=thermal');
    const identity = page.locator(`code[title="${PLAN.plan_id}"]`).first();
    await expect(identity).toBeVisible();
    test.skip(await isTestWebsite(page), 'HA recovery status is only authoritative on the live website.');
    await expect(page.getByRole('button', { name: replanButton })).toHaveCount(0);
    replan.refreshing = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const banner = page.getByTestId('plan-refresh-progress');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.animate-spin')).toBeVisible();
    await expect(identity).toBeVisible();
    for (const button of await page.getByRole('button', { name: /^(Spara|Save)$/ }).all()) {
      await expect(button).toBeDisabled();
    }
    await page.screenshot({ path: '/tmp/shs-website-refresh.png', fullPage: false });
    replan.refreshing = false;
    replan.publishedPlan = { ...PLAN, plan_id: REQUEST_ID };
    replan.reportedPlanId = REQUEST_ID;
    await expect(banner).toHaveCount(0);
    await expect(page.locator(`code[title="${REQUEST_ID}"]`).first()).toBeVisible();
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
  });

  test('failed background reads retain the chart and display readable persistent errors', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.goto('/portal/energy-modeling?tab=plan');
    const identity = page.locator(`code[title="${PLAN.plan_id}"]`).first();
    await expect(identity).toBeVisible();
    replan.readError = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('plan-refresh-progress')).toBeVisible();
    await expect(identity).toBeVisible();
    await expect(page.getByText(/Database temporarily unavailable/)).toBeVisible();
    await expect(page.getByText('[object Object]', { exact: true })).toHaveCount(0);
    await expect(identity).toBeVisible();
    replan.readError = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText(/Database temporarily unavailable/)).toHaveCount(0);
    await expect(identity).toBeVisible();
  });

  test('comfort targets are one number each, saved from the comfort tab', async ({ context, page }) => {
    let stored: Record<string, unknown> | null = null;
    await context.route('**/rest/v1/energy_optimisation_comfort_targets*', async route => {
      if (route.request().method() === 'POST') {
        stored = route.request().postDataJSON();
        await route.fulfill({ status: 201, body: '' });
        return;
      }
      // A home that has never set its targets has no row.
      const single = (route.request().headers().accept || '').includes('vnd.pgrst.object');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(single ? stored : stored ? [stored] : []) });
    });
    await page.goto('/portal/energy-modeling?tab=comfort');
    const card = page.getByTestId('comfort-targets-card');
    const pool = card.locator('#comfort-target-pool'), car = card.locator('#comfort-target-car');
    const save = card.getByRole('button', { name: /^(Spara|Save)$/ });
    // The defaults stand until the household says otherwise, and there is nothing to save.
    await expect(pool).toHaveValue('30');
    await expect(car).toHaveValue('300');
    await expect(save).toBeDisabled();
    // An impossible value cannot be saved.
    await pool.fill('55');
    await expect(save).toBeDisabled();
    await expect(card.getByRole('alert')).toBeVisible();
    await pool.fill('29,5');
    await car.fill('350');
    await save.click();
    await expect.poll(() => stored).not.toBeNull();
    expect(stored).toMatchObject({ home_id: HOME_ID, customer_id: CUSTOMER_ID, pool_target_c: 29.5, ev_target_km: 350 });
    await expect(save).toBeDisabled();
    await page.reload();
    await expect(card.locator('#comfort-target-pool')).toHaveValue('29.5');
    // Planning comes from the live engine; manual schedule and value-curve editors are gone.
    await expect(page.getByRole('tab', { name: /^(Bygg plan|Build a plan)$/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^(Ekonomi|Economics)$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Ekonomi|Economics)$/ })).toHaveCount(0);
  });

  test('accuracy buttons open compact device lists with all five grades', async ({page}) => {
    const devices = [['baseline','Baseline',94,'green'],['ev','Car',84,'lime'],['pool','Pool',74,'yellow'],
      ['boiler','Water boiler',64,'orange'],['battery','House battery',54,'red']].map(([key,name,percentage,grade]) => ({key,name,percentage,grade}));
    replan.accuracy = {version:1,calculated_at:CAPTURED_AT,scheduled_at:CAPTURED_AT,timezone:'Europe/Stockholm',forecast_plan_id:PLAN.plan_id,
      forecast:{percentage:94,grade:'green',devices},historical:{percentage:64,grade:'orange',devices}};
    await page.goto('/portal/energy-modeling?tab=plan');
    const forecast = page.getByRole('button',{name:/Forecast accuracy %|Prognosnoggrannhet %/});
    await expect(forecast).toContainText('94');
    await forecast.click();
    const popup = page.getByRole('dialog');
    await expect(popup.getByText('Baseline',{exact:true})).toBeVisible();
    for (const n of [94,84,74,64,54]) await expect(popup.getByText(`${n}%`,{exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(forecast).toBeFocused();
    await page.getByRole('button',{name:/Historical accuracy %|Historisk noggrannhet %/}).click();
    await expect(page.getByRole('dialog').getByRole('heading')).toContainText(/Historical accuracy %|Historisk noggrannhet %/);
    await expect(page.getByRole('dialog')).toHaveCSS('opacity','1');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:'/private/tmp/shs-forecast-accuracy/website-accuracy.png'});
  });

  test('routine learning does not create a banner or block replanning', async ({page})=>{
    replan.publishedPlan={...PLAN,planning_warnings:[{code:'profile_estimated',scope:'base',severity:'error',
      message:'Five historical quarters lack observations.',consequence:'Planning continues using observed neighbouring quarters.'},
      {code:'pool_model_quality',scope:'pool',severity:'warning',message:'limited_idle_observations, limited_response_observations',
        consequence:'Learning continues.'}]};
    await page.goto('/portal/energy-modeling?tab=plan');
    const banner=page.getByTestId('planning-warnings');
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('button',{name:replanButton})).toBeEnabled();
    replan.publishedPlan={...PLAN,planning_warnings:[]};await page.reload();
    await expect(banner).toHaveCount(0);
  });

  test('an unavailable comparison leaves the executable plan visible and replanning enabled', async ({page}) => {
    replan.publishedPlan = {...PLAN, plans: {...PLAN.plans,
      baseline: {...PLAN.plans.baseline, status: 'infeasible', validation_errors: ['shared_grid_limit'], slots: [], summary: null}},
      planning_warnings: [{code: 'baseline_unavailable', scope: 'comparison', severity: 'warning',
        message: 'The comparison baseline could not be projected: shared_grid_limit.',
        consequence: 'The selected control plan remains available. Baseline forecasts and cost comparisons are unavailable.'}]};
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.getByTestId('planning-warnings')).toContainText('The selected control plan remains available.');
    await expect(page.getByRole('img', {name: /effektflöden|power flows/i}).first()).toBeVisible();
    await expect(page.getByRole('button', {name: replanButton})).toBeEnabled();
    expect(pageErrors).toEqual([]);
    replan.publishedPlan = PLAN;
    await page.reload();
    await expect(page.getByTestId('planning-warnings')).toHaveCount(0);
    await expect(page.getByRole('img', {name: /effektflöden|power flows/i}).first()).toBeVisible();
  });

  test('the planner installation address can be edited in its existing home',async({context,page})=>{
    const home={id:HOME_ID,name:'My home',address_text:'Old installation address'};
    let saved:Record<string,string>|null=null;
    await context.route('**/rest/v1/homes*',async route=>{
      if(route.request().method()==='PATCH') {saved=route.request().postDataJSON();Object.assign(home,saved);}
      const single=(route.request().headers().accept??'').includes('vnd.pgrst.object');
      await route.fulfill({json:single?home:[home]});
    });
    await page.goto('/portal/energy-modeling?tab=plan');
    await page.getByRole('button',{name:/Redigera installationsadress|Edit installation address/}).click();
    await expect(page.getByLabel(/Installationsadress|Installation address/)).toHaveValue('Old installation address');
    await page.getByLabel(/Installationsadress|Installation address/).fill('New installation address');
    await page.getByRole('button',{name:/^Spara$|^Save$/}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(saved).toEqual({name:'My home',address_text:'New installation address'});
  });

  test('recommendations are shared, expandable, and clear when the published row clears them', async ({ page }) => {
    replan.row = {...replan.row, replan_recommendations: [{key: 'household_energy', reason: 'Rolling four-quarter difference exceeded 6 kWh.', occurred_at: CAPTURED_AT}]};
    await page.goto('/portal/energy-modeling?tab=plan');
    const banner = page.getByTestId('replan-recommendations');
    await expect(banner).toBeVisible();
    await banner.locator('summary').click();
    await expect(banner.getByText(/Rolling four-quarter/)).toBeVisible();
    replan.row = {...replan.row, replan_recommendations: []};
    await page.reload();
    await expect(banner).toHaveCount(0);
    await page.goto('/portal/energy-modeling?tab=thermal');
    await expect(page.getByRole('button', {name: replanButton})).toHaveCount(0);
  });

  test('a device left out for an impossible reading is named while the rest stays planned', async ({ page }) => {
    const input = snapshot();
    input.pool = { ...input.pool!, water_temperature_c: 500, source_entity_ids: { water_temperature: 'sensor.pool_water' } };
    const isolated = runRulesPlanner({ snapshot: input, now: (new Date(CAPTURED_AT)).toISOString(), price_archive: [] }).plan;
    expect(isolated.status).toBe('ready');
    expect(isolated.plans.priority.dispatched_devices).toContain('battery');
    replan.publishedPlan = { ...isolated, plan_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    await page.goto('/portal/energy-modeling?tab=plan');
    const banner = page.getByTestId('measurement-issues');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Poolen: vattentemperaturen visar 500 °C|Pool: the water temperature reads 500 °C/);
    await expect(banner).toContainText('sensor.pool_water');
    await expect(banner).toContainText(/Resten av hemmet planeras som vanligt|The rest of the home is planned as usual/);
    replan.publishedPlan = undefined;
    await page.reload();
    await expect(banner).toHaveCount(0);
  });

  test('pressing it uses only the button for progress and clears redundant warnings', async ({ page }) => {
    replan.row.replan_recommendations = [{key: 'changed', reason: 'Measurements changed', occurred_at: CAPTURED_AT}];
    await page.goto('/portal/energy-modeling?tab=plan');

    const button = page.getByRole('button', { name: replanButton });
    await expect(button).toBeEnabled();
    await expect(page.getByTestId('replan-recommendations')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await button.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: /^(My home|Mitt hem|Example|Exempel)$/ })).toHaveCount(0);
    await button.click();
    await expect(page.getByTestId('replan-recommendations')).toHaveCount(0);
    await expect(page.getByTestId('plan-refresh-progress')).toHaveCount(0);
    await expect(page.getByText(/Omplanering beställd|Replan requested/)).toHaveCount(0);

    // The failure this replaces: a red toast saying the stored snapshot was
    // too old to plan against. Nothing may report the request as refused.
    await expect(page.getByText(/Kunde inte planera om|Could not replan/)).toHaveCount(0);
    await expect(page.getByText(/captured_at/)).toHaveCount(0);

    await expect(
      page.getByRole('button', { name: replanButton }),
    ).toHaveAttribute('aria-busy', 'true');
    // Asking twice cannot help: the house is already building the answer.
    await expect(button).toBeDisabled();
  });

  test('a later completed request also releases this browser’s busy button', async ({ page }) => {
    await page.goto('/portal/energy-modeling?tab=plan');
    const button = page.getByRole('button', { name: replanButton });
    const requested = page.waitForResponse(response => response.url().includes('/energy-optimisation-replan'));
    await button.click();
    await requested; // The request handler must finish before simulating a later completion.
    await expect(button).toHaveAttribute('aria-busy', 'true');
    const laterRequest = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    replan.row = { ...idle, replan_request_id: laterRequest,
      replan_completed_request_id: laterRequest, replan_requested_at: CAPTURED_AT };
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
  });

  test('a request already outstanding is shown to whoever opens the page', async ({ page }) => {
    // The wait belongs to the house, not to the browser that started it: a
    // reload, a second tab and a returning visitor all see the same thing.
    replan.row = {
      replan_request_id: REQUEST_ID,
      replan_requested_at: CAPTURED_AT,
      replan_completed_request_id: null,
      replan_error: null,
    };
    await page.goto('/portal/energy-modeling?tab=plan');

    await expect(
      page.getByRole('button', { name: replanButton }),
    ).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: replanButton })).toBeDisabled();
  });

  test('a house that could not answer says why, and can be asked again', async ({ page }) => {
    replan.row = {
      replan_request_id: REQUEST_ID,
      replan_requested_at: CAPTURED_AT,
      replan_completed_request_id: null,
      replan_error: 'kitchen: no trained thermal model is available',
    };
    await page.goto('/portal/energy-modeling?tab=plan');

    await expect(
      page.getByText(/kitchen: no trained thermal model is available/),
    ).toBeVisible();
    // A failure is not a dead end — the next quarter may well succeed.
    await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
  });

  test('an answered request leaves the panel alone', async ({ page }) => {
    // The ids stay on the row as the record of the last request. Read as "a
    // request exists", every visit after the first replan would show a wait
    // that never ends.
    replan.row = {
      replan_request_id: REQUEST_ID,
      replan_requested_at: CAPTURED_AT,
      replan_completed_request_id: REQUEST_ID,
      replan_error: null,
    };
    await page.goto('/portal/energy-modeling?tab=plan');

    await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
    await expect(
      page.getByText(/Omplanering beställd|Replan requested/),
    ).toHaveCount(0);
  });
});


test('mixed modes show and export the published device plan', async ({ context, page }) => {
  const plan = mixedModeFixture.plan as typeof PLAN;
  await page.clock.setFixedTime(new Date(mixedModeFixture.validation_time));
  await mockBackend(context, { row: { ...idle } }, plan, mixedModeSnapshot());
  await page.goto('/login');
  await page.fill('#email', 'whoever@example.com');
  await page.fill('#password', 'mock-password');
  await page.getByRole('button', { name: 'Logga in' }).click();
  await page.waitForURL(url => !url.pathname.endsWith('/login'));
  await page.goto('/portal/energy-modeling?tab=plan');
  const live = page.getByRole('button', { name: /Faktisk drift|Live operation/ });
  const preview = page.getByRole('button', { name: /Planeringsförhandsvisning|Planning preview/ });
  await expect(live).toHaveCount(0);
  await expect(preview).toHaveCount(0);
  const downloadReplay = async (scenario: 'priority' | 'baseline') => {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: /replay|repris/i }).click();
    const file = await downloaded;
    const bundle = JSON.parse(readFileSync((await file.path())!, 'utf8'));
    expect(bundle.selection.scenario).toBe(scenario);
    expect(bundle.expected.planner_output).toEqual(plan);
    expect(bundle.expected.selected_quarter).toEqual(
      plan.plans[scenario].slots[bundle.selection.quarter_index],
    );
  };
  await downloadReplay('priority');
  await expect(page.getByRole('button', { name: /Utan plan|Without plan|Med plan|With plan/ })).toHaveCount(0);
});
