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
import { generateOptimisationPlan } from '../supabase/functions/_shared/energy-optimisation';
import { mixedModeSnapshot } from '../scripts/generate-ha-plan-fixture';
import { readFileSync } from 'node:fs';
const mixedModeFixture = JSON.parse(readFileSync(new URL('../contracts/ha-api/fixtures/schema-9-mixed-mode-plan.json', import.meta.url), 'utf8'));
import { portalDelta } from './helpers/portal-delta';

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
async function mockBackend(context: BrowserContext, replan: { row: ReplanColumns; reportedPlanId?: string }, plan = PLAN, planSnapshot = snapshot()) {
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
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/rpc/get_energy_portal_delta')) {
      await route.fulfill({ json: portalDelta(route.request().postDataJSON().p_known, {
        current: {
          home_id: HOME_ID,
          captured_at: CAPTURED_AT,
          updated_at: CAPTURED_AT,
          plan_id: plan.plan_id,
          generation_request_id: REQUEST_ID,
          plan_schema_version: plan.schema_version,
          ha_runtime: replan.reportedPlanId ? {
            plan_id: replan.reportedPlanId, observed_at: CAPTURED_AT, state: 'ready',
            reason: 'A validated plan is available', binding_until: plan.binding_until,
            valid_until: plan.valid_until, recovering: false, retry_at: null, last_error: null,
          } : null,
          ha_runtime_received_at: replan.reportedPlanId ? CAPTURED_AT : null,
          ha_ack_status: 'accepted',
          ha_acknowledged_at: CAPTURED_AT,
          ha_integration_version: null,
          ha_ack_request_id: null,
          ha_ack_error: null,
          ...replan.row,
        },
        plan,
      }) });
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
      ? [{ snapshot: planSnapshot, plan }]
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
  let replan: { row: ReplanColumns; reportedPlanId?: string };

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

  test('pressing it records a request and says the house is answering', async ({ page }) => {
    await page.goto('/portal/energy-modeling?tab=economics');

    const button = page.getByRole('button', { name: replanButton });
    await expect(button).toBeEnabled();
    await button.click();

    // The failure this replaces: a red toast saying the stored snapshot was
    // too old to plan against. Nothing may report the request as refused.
    await expect(page.getByText(/Kunde inte planera om|Could not replan/)).toHaveCount(0);
    await expect(page.getByText(/captured_at/)).toHaveCount(0);

    await expect(
      page.getByText(/Omplanering beställd|Replan requested/),
    ).toBeVisible();
    // Asking twice cannot help: the house is already building the answer.
    await expect(button).toBeDisabled();
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
    await page.goto('/portal/energy-modeling?tab=economics');

    await expect(
      page.getByText(/Omplanering beställd|Replan requested/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: replanButton })).toBeDisabled();
  });

  test('a house that could not answer says why, and can be asked again', async ({ page }) => {
    replan.row = {
      replan_request_id: REQUEST_ID,
      replan_requested_at: CAPTURED_AT,
      replan_completed_request_id: null,
      replan_error: 'kitchen: no trained thermal model is available',
    };
    await page.goto('/portal/energy-modeling?tab=economics');

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
    await page.goto('/portal/energy-modeling?tab=economics');

    await expect(page.getByRole('button', { name: replanButton })).toBeEnabled();
    await expect(
      page.getByText(/Omplanering beställd|Replan requested/),
    ).toHaveCount(0);
  });
});


test('mixed modes show one complete device plan and export the selected comparison', async ({ context, page }) => {
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
  await page.getByRole('button', { name: /Utan plan|Without plan/ }).click();
  await downloadReplay('baseline');
});
