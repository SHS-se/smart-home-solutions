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
import { test, expect, type BrowserContext } from '../playwright-fixture';
import { CAPTURED_AT, snapshot } from '../src/lib/energy-shift/optimisation-snapshot.fixture';
import { balancedBatteryCurve, generateOptimisationPlan } from '../supabase/functions/_shared/planner/energy-optimisation';
import { mixedModeSnapshot } from '../scripts/generate-ha-plan-fixture';
import { readFileSync } from 'node:fs';
const mixedModeFixture = JSON.parse(readFileSync(new URL('../contracts/ha-api/fixtures/schema-9-mixed-mode-plan.json', import.meta.url), 'utf8'));
import { portalDelta } from './helpers/portal-delta';
import { comparePreference } from '../src/lib/energy-shift/curve-preview';
import { DEFAULT_VALUE_CURVES } from '../supabase/functions/_shared/planner/value-curves';

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const HOME_ID = 'cccccccc-dddd-4eee-8fff-111111111111';
const REQUEST_ID = '2f1c0c74-9d31-4f0e-9a45-9c6f2f5f0a11';

// Solved at the snapshot's own capture time, which is also the clock the browser
// is pinned to below: a plan the page considers current, as in service.
const PLAN = generateOptimisationPlan(snapshot(), new Date(CAPTURED_AT));

function fakeJwt(sub: string, email: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: 'HS256', typ: 'JWT' }),
    enc({ sub, email, aud: 'authenticated', role: 'authenticated', exp: now + 3600, iat: now }),
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
  row: ReplanColumns;
  reportedPlanId?: string;
  publishedPlan?: typeof PLAN;
  refreshing?: boolean;
  readError?: boolean;
  history?: Array<{ start_ts: string; total_load_kwh: number }>;
  deviceHistory?: Array<{ start_ts: string; device_energy_kwh: Record<string, number> }>;
  devices?: Array<Record<string, unknown>>;
}

async function mockBackend(context: BrowserContext, replan: MockPlanState, plan = PLAN, planSnapshot = snapshot()) {
  const nowIso = new Date().toISOString();
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
          access_token: fakeJwt(CUSTOMER_USER_ID, email),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
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
            valid_until: shown.valid_until, recovering: replan.refreshing ?? false, retry_at: null, last_error: null,
          } : null,
          ha_runtime_received_at: replan.reportedPlanId ? CAPTURED_AT : null,
          ha_ack_status: 'accepted',
          ha_acknowledged_at: CAPTURED_AT,
          ha_integration_version: null,
          ha_ack_request_id: null,
          ha_ack_error: null,
          ...replan.row,
        },
        plan: shown,
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
      // The economics editor loads its snapshot on demand, separately from sync.
      ? [{ snapshot: planSnapshot, plan: shown }]
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

  test('missing device readings show an explanation instead of NaN in the tooltip', async ({ page }, testInfo) => {
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
    await expect(tooltip).toContainText(/Ej tillgänglig|Unavailable/);
    await expect(tooltip).toContainText(/Mätvärden saknas för|Missing readings for/);
    await expect(tooltip).toContainText('pool_pump');
    await expect(tooltip).toContainText('Pool heater');
    await expect(tooltip).toContainText('1.80 kW');
    await expect(tooltip).toContainText('2.60 kW');
    await expect(tooltip).not.toContainText('NaN');
    await page.screenshot({ path: testInfo.outputPath('partial-consumption.png') });
  });

  for (const samePlan of [true, false]) {
    test(`shows the displayed and HA plan identities when they ${samePlan ? 'match' : 'differ'}`, async ({ page }) => {
      replan.reportedPlanId = samePlan ? PLAN.plan_id : REQUEST_ID;
      await page.goto('/portal/energy-modeling?tab=plan');
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

  test('configuration refresh retains the plan, locks saves and recovers automatically', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.goto('/portal/energy-modeling?tab=economics');
    const identity = page.locator(`code[title="${PLAN.plan_id}"]`).first();
    await expect(identity).toBeVisible();
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

  test('battery points save exactly and blue changes only when a new plan is published', async ({ context, page }) => {
    let saved: Record<string, unknown> | null = null;
    await context.route('**/rest/v1/energy_optimisation_value_curves*', async route => {
      if (route.request().method() === 'POST') saved = route.request().postDataJSON();
      if (route.request().method() === 'DELETE') saved = null;
      await route.fulfill({ json: saved ? [saved] : [] });
    });
    await page.goto('/portal/energy-modeling?tab=economics');
    const card = page.getByTestId('battery-curve-card');
    const blue = card.getByTestId('battery-current-curve');
    const before = await blue.getAttribute('data-values');
    await card.getByRole('spinbutton', { name: /Antal punkter|Number of points/ }).fill('4');
    await card.getByRole('button', { name: /Använd punktantal|Apply point count/ }).click();
    await expect(card.locator('circle')).toHaveCount(4);
    await card.getByRole('spinbutton', { name: /Punktens värde|Point value/ }).fill('10');
    const first = card.locator('circle').first();
    await first.focus(); await page.keyboard.press('ArrowUp');
    const bounds = await first.boundingBox();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 12, bounds!.y + bounds!.height / 2 - 10, { steps: 4 });
    await page.mouse.up();
    await card.getByRole('button', { name: /^(Spara|Save)$/ }).click();
    await expect(card.getByRole('button', { name: /^(Spara|Save)$/ })).toBeDisabled();
    expect(saved!.store_key).toBe('battery');
    expect(saved!.generation_mode).toBe('custom');
    const points = saved!.points as { at: number; sek_per_unit: number }[];
    expect(points).toHaveLength(4);
    expect(points[0].sek_per_unit).toBeGreaterThan(10);
    expect(points[0].at).toBeGreaterThan(0);
    await expect(blue).toHaveAttribute('data-values', before!);
    await card.screenshot({path: test.info().outputPath('battery-curve.png')});
    await card.getByRole('spinbutton', { name: /Punktens värde|Point value/ }).fill('20');
    const planPage = await context.newPage();
    await planPage.goto('/portal/energy-modeling?tab=plan');
    await planPage.getByRole('button', { name: replanButton }).click();
    await expect(planPage.getByRole('button', { name: replanButton })).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    replan.publishedPlan = { ...PLAN, plan_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      battery_value_curve: { ...PLAN.battery_value_curve!, source: 'customer', curve: { unit: 'kwh', points } } };
    replan.row.replan_completed_request_id = REQUEST_ID;
    await expect(blue).toHaveAttribute('data-values', JSON.stringify(points), { timeout: 4500 });
    // A plan refresh must preserve an unsaved edit made after Save.
    await expect(card.getByRole('spinbutton', { name: /Punktens värde|Point value/ })).toHaveValue('20');
    await expect(card.getByRole('button', { name: /^(Spara|Save)$/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: replanButton })).toHaveCount(0);
  });

  test('the automatic battery curve and a custom one save and reload as themselves', async ({ context, page }) => {
    const storedPoints = Array.from({ length: 10 }, (_, index) => ({ at: index * 0.6, sek_per_unit: (10 - index) * 0.073 }));
    let saved: Record<string, unknown> | null = null;
    await context.route('**/rest/v1/energy_optimisation_value_curves*', async route => {
      if (route.request().method() === 'POST') saved = route.request().postDataJSON();
      await route.fulfill({ json: saved ? [saved] : [] });
    });
    await page.goto('/portal/energy-modeling?tab=economics');
    const card = page.getByTestId('battery-curve-card');
    const automatic = card.getByRole('button', { name: /Använd den automatiska kurvan|Use the automatic curve/ });
    const save = card.getByRole('button', { name: /^(Spara|Save)$/ });
    const pointValue = card.getByRole('spinbutton', { name: /Punktens värde|Point value/ });
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    const expectedBalanced = balancedBatteryCurve(snapshot(), new Date(Date.parse(CAPTURED_AT) + 60_000))!;
    await automatic.click();
    await expect(pointValue).toHaveValue(String(expectedBalanced.points[0].sek_per_unit));
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved!.generation_mode).toBe('balanced');
    expect(saved!.points).toEqual(expectedBalanced.points);
    // Persisted balanced points are a seed; they must not replace the fresh
    // balanced curve when measurements are loaded for the next plan.
    saved!.points = storedPoints;
    await page.reload();
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    await expect(pointValue).toHaveValue(String(expectedBalanced.points[0].sek_per_unit));
    // A row saved under the removed price-only mode shows, and plans, as automatic.
    saved!.generation_mode = 'price_only';
    await page.reload();
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    await pointValue.fill('20');
    await expect(automatic).toHaveAttribute('aria-pressed', 'false');
    await expect(card.getByText(/^(Egen kurva|Your curve)$/)).toBeVisible();
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved!.generation_mode).toBe('custom');
  });

  test('an invalid stored battery curve has a direct explicit correction', async ({ context, page }) => {
    let invalid = true;
    await context.route('**/rest/v1/energy_optimisation_value_curves*', async route => {
      if (route.request().method() === 'DELETE') invalid = false;
      await route.fulfill({ json: invalid ? [{ store_key: 'battery', unit: 'kwh', points: [{ at: 0, sek_per_unit: -1 }] }] : [] });
    });
    await page.goto('/portal/energy-modeling?tab=economics');
    await expect(page.getByText(/Batterikurvan kan inte användas|The battery curve cannot be used/)).toBeVisible();
    await expect(page.getByTestId('battery-curve-card')).toHaveCount(0);
    await page.getByRole('button', { name: /Ta bort ogiltig kurva|Remove invalid curve/ }).click();
    await expect(page.getByTestId('battery-curve-card')).toBeVisible();
    await expect(page.getByText(/Batterikurvan kan inte användas|The battery curve cannot be used/)).toHaveCount(0);
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
    await page.goto('/portal/energy-modeling?tab=economics');
    await expect(page.getByRole('button', {name: replanButton})).toHaveCount(0);
  });

  test('a device left out for an impossible reading is named while the rest stays planned', async ({ page }) => {
    const input = snapshot();
    input.pool = { ...input.pool!, water_temperature_c: 500, source_entity_ids: { water_temperature: 'sensor.pool_water' } };
    const isolated = generateOptimisationPlan(input, new Date(CAPTURED_AT));
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
