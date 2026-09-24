/**
 * The plan workbench, fully local — no real backend.
 *
 * ENERGY_OPTIMISATION_ARCHITECTURE.md §8.12 is settled by comparing two scored
 * schedules, and the comparison is only worth anything if the page a household
 * actually uses can run the planner in the browser and show both numbers. The
 * arithmetic has unit tests; this covers the part they cannot reach — that the
 * tab mounts, solves a real 288-quarter snapshot client-side, and renders an
 * editable grid whose edits move the score.
 *
 * Run with a local dev server:
 *   E2E_BASE_URL=http://localhost:8080 npx playwright test e2e/plan-workbench.spec.ts
 */
import { test, expect, type BrowserContext } from '../playwright-fixture';
import { snapshot } from '../src/lib/energy-shift/optimisation-snapshot.fixture';

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const HOME_ID = 'cccccccc-dddd-4eee-8fff-111111111111';

function fakeJwt(sub: string, email: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: 'HS256', typ: 'JWT' }),
    enc({ sub, email, aud: 'authenticated', role: 'authenticated', exp: now + 3600, iat: now }),
    'x'.repeat(43),
  ].join('.');
}

async function mockBackend(context: BrowserContext) {
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

  await context.route('**/functions/v1/**', route => route.fulfill({ json: {} }));
  await context.route('**/storage/v1/**', route => route.fulfill({ json: [] }));

  await context.route('**/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/rpc/')) {
      await route.fulfill({ json: false });
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
      ? [{ home_id: HOME_ID, snapshot: snapshot() }]
      : [];
    const single = (route.request().headers().accept || '').includes('vnd.pgrst.object');
    await route.fulfill({
      status: single && rows.length === 0 ? 406 : 200,
      contentType: 'application/json',
      body: JSON.stringify(single ? rows[0] ?? null : rows),
    });
  });
}

test.describe('plan workbench', () => {
  test.beforeEach(async ({ context, page }) => {
    await mockBackend(context);
    // Auth is intercepted, so the form is just how the app is told a session
    // exists — nothing here is a credential.
    await page.goto('/login');
    await page.fill('#email', 'whoever@example.com');
    await page.fill('#password', 'mock-password');
    await page.getByRole('button', { name: 'Logga in' }).click();
    await page.waitForURL(url => !url.pathname.endsWith('/login'));
  });

  test('solves the snapshot in the browser and scores an edit', async ({ page }) => {
    await page.goto('/portal/energy-modeling?tab=workbench');

    await page.getByRole('button', { name: /Load the planner|Läs in planerarens/ }).click();

    // The planner ran client-side over the stored snapshot: both plans priced.
    await expect(page.getByText(/The planner’s plan|Planerarens plan/)).toBeVisible({
      timeout: 30_000,
    });
    const cells = page.locator('input[type="number"]');
    await expect(cells.first()).toBeVisible();

    const difference = page.locator('text=/^[+−]?\\d+\\.\\d{2} SEK$/').last();
    const before = await difference.textContent();

    // Editing a quarter must move the score: that is the whole mechanism.
    await cells.first().fill('3');
    await cells.first().blur();

    await expect(async () => {
      expect(await difference.textContent()).not.toBe(before);
    }).toPass({ timeout: 15_000 });

    // The panels are how an edit is judged by eye, so they have to be drawn
    // from the schedule rather than from the stored plan.
    const chart = page.getByRole('img', {
      name: /effektflöden|power flows/i,
    }).first();
    await expect(chart).toBeVisible();

    // The shared plan tooltip exposes both sides of the tariff.
    await chart.hover({ position: { x: 100, y: 100 } });
    await expect(page.getByText(/^(Sell|Sälj)( \((estimated|uppskattat)\))?$/)).toBeVisible();

    // Flipping to the planner's plan must redraw rather than freeze.
    const shape = await chart.textContent();
    await page.getByRole('button', { name: /The planner’s|Planerarens$/ }).click();
    await expect(async () => {
      expect(await chart.textContent()).not.toBe(shape);
    }).toPass({ timeout: 15_000 });

    // The day tabs narrow the chart and the table together.
    const oneDay = await chart.textContent();
    await page.getByRole('button', { name: /^(All|Alla)$/ }).click();
    await expect(async () => {
      expect(await chart.textContent()).not.toBe(oneDay);
    }).toPass({ timeout: 15_000 });

    // Clicking a quarter in the chart brings the table to it.
    // Scrolling to *somewhere* is not the claim — the pointed-at quarter has to
    // end up on screen, which is the part that broke when the measurement ran
    // before the day switch had been laid out.
    const grid = page.getByTestId('workbench-grid');
    const box = await chart.boundingBox();
    expect(box).not.toBeNull();
    await chart.click({ position: { x: box!.width * 0.8, y: box!.height * 0.45 } });

    await expect(async () => {
      const visible = await grid.evaluate(container => {
        const marked = container.querySelector('th[data-selected="true"]');
        if (!marked) return false;
        const cell = marked.getBoundingClientRect();
        const view = container.getBoundingClientRect();
        return cell.left >= view.left && cell.right <= view.right;
      });
      expect(visible).toBe(true);
    }).toPass({ timeout: 15_000 });
  });

  test('reports the grid, links a breach to its time, and exports the plan', async ({ page }) => {
    await page.goto('/portal/energy-modeling?tab=workbench');
    await page.getByRole('button', { name: /Load the planner|Läs in planerarens/ }).click();
    await expect(page.getByText(/The planner’s plan|Planerarens plan/)).toBeVisible({
      timeout: 30_000,
    });

    // The grid figure is derived, signed, and sits with the rows it follows from.
    const gridRow = page.locator('tr', { hasText: /Grid in \/ out|Nätet in \/ ut/ }).first();
    await expect(gridRow).toBeVisible();
    await expect(gridRow).toContainText(/[+−-]?\d+\.\d/);

    // A breach names a time, and clicking it takes the table there.
    //
    // The breach is injected rather than borrowed. This used to lean on the
    // planner's own export leak, which settlement's physical checks have since
    // fixed — so the test was asserting a defect stayed put. Charging the pack
    // flat out for a whole day overfills it, which the editor cannot snap away.
    // The snapshot starts at 22:45, so its first day holds five quarters. Fill
    // on the second tab, which is a whole one.
    await page.getByRole('button', { name: /^\d{2}\/\d{2}$/ }).nth(1).click();
    await page.getByRole('button', { name: /^(1 hour|1 tim)$/ }).click();
    // Editable rows in order: each store's charge, then each discharge. The
    // pack's charge row is the one whose label is the pack itself, not its
    // "— out" twin, so the label is asserted rather than assumed.
    const editableRows = page.locator('tr').filter({
      has: page.locator('input[type="number"]'),
    });
    const packRow = editableRows.filter({ hasText: 'Home battery' }).first();
    await expect(packRow).toContainText('max 8.8 kW');
    const chargeCells = packRow.locator('input[type="number"]');
    const cells = await chargeCells.count();
    expect(cells).toBeGreaterThan(8);
    // Six hours at 8.8 kW is far past the pack's 17.176 kWh from any state, and
    // each keystroke re-scores 288 quarters — so stop at six rather than filling
    // the day for a breach the third one already guarantees.
    for (let at = 0; at < 6; at += 1) {
      await chargeCells.nth(at).fill('8.8');
    }
    const breach = page.locator('button', { hasText: /^\d{2}\/\d{2} \d{2}:\d{2}$/ }).first();
    await expect(breach).toBeVisible({ timeout: 30_000 });
    await breach.click();
    const grid = page.getByTestId('workbench-grid');
    await expect(async () => {
      const visible = await grid.evaluate(container => {
        const marked = container.querySelector('th[data-selected="true"]');
        if (!marked) return false;
        const cell = marked.getBoundingClientRect();
        const view = container.getBoundingClientRect();
        return cell.left >= view.left && cell.right <= view.right;
      });
      expect(visible).toBe(true);
    }).toPass({ timeout: 15_000 });

    // Put the editor back before the checks that need a pristine schedule: six
    // hours of pack charging changes what the load can absorb, and the export
    // ceiling below is measured against exactly that.
    await page.getByRole('button', { name: /^(15 min)$/ }).click();
    await page.getByRole('button', { name: /^\d{2}\/\d{2}$/ }).first().click();
    await expect(
      page.locator('[role="alert"]', { hasText: /Your plan cannot be run|går inte att köra/ }),
    ).toHaveCount(0);

    // The bill: real money, free of the value curves.
    await expect(page.getByText(/What the planner costs you|Vad planeraren kostar/)).toBeVisible();
    await expect(page.getByText(/Difference on the bill|Skillnad på räkningen/)).toBeVisible();
    await expect(page.locator('tr', { hasText: /On the bill|På räkningen/ }).first())
      .toBeVisible();

    // What a stored kWh is worth, beside the price it is judged against.
    await expect(page.locator('tr', { hasText: /Home battery — worth|— värde/ }).first())
      .toBeVisible();

    // The export permit is a switch per quarter, not a setting for the horizon.
    const permit = page.locator('tr', { hasText: /Allow battery export|Tillåt export/ }).first();
    await expect(permit).toBeVisible();
    const firstSwitch = permit.locator('button').first();
    await expect(firstSwitch).toHaveAttribute('aria-pressed', 'false');

    // With the permit off, asking the pack for more than the house can use is
    // held at the load rather than allowed and then complained about.
    const out = page.locator('tr', { hasText: /Home battery — out|Home battery — ut/ }).first();
    const cell = out.locator('input[type="number"]').first();
    await cell.fill('9');
    await cell.blur();
    await expect(async () => {
      expect(Number((await cell.inputValue()).replace(',', '.'))).toBeLessThan(9);
    }).toPass({ timeout: 10_000 });
    // Nothing was sold. Changing the pack's trajectory can still overfill it
    // later, which is a real finding and stays reported — what must not appear
    // is a sale the editor did not let the household make.
    const mine = page.locator('[role="alert"]', {
      hasText: /Your plan cannot be run|går inte att köra/,
    });
    if (await mine.count() > 0) {
      await expect(mine.first()).not.toContainText('discharges into export');
    }

    // Turning the quarter on lets the same figure through.
    await firstSwitch.click();
    await expect(firstSwitch).toHaveAttribute('aria-pressed', 'true');
    await cell.fill('9');
    await cell.blur();
    await expect(async () => {
      expect(Number((await cell.inputValue()).replace(',', '.'))).toBe(9);
    }).toPass({ timeout: 10_000 });

    // And the whole comparison leaves the machine as one file.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export|Exportera/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^plan-.*\.json$/);
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(payload.format).toBe('shs.plan-workbench.v2');
    // v2 carries what the objective was computed from, not only what it decided.
    const pack = payload.stores.find((s: { key: string }) => s.key === 'battery');
    expect(pack.curve.length).toBeGreaterThan(0);
    expect(pack.units_per_kwh_by_slot).toHaveLength(288);
    expect(pack.terminal_weight).toBeGreaterThan(0);
    expect(pack.min_sized_power_w).toBe(500);
    expect(payload.quarters[0]).toHaveProperty('published_price');
    expect(payload.quarters[0]).toHaveProperty('planner_allocations');
    expect(payload.quarters).toHaveLength(288);
    expect(payload.scores.planner.total_sek).toBeLessThan(0);
    // The bill travels with the plan, separately from the objective.
    expect(payload.scores.planner.billable_sek).toBeGreaterThan(0);
    expect(payload.scores.planner.billable_sek).not.toBe(payload.scores.planner.total_sek);
    // The permit travels with the plan, so a schedule can be read back whole.
    expect(payload.quarters.filter((q: { allow_store_export: boolean }) => q.allow_store_export))
      .toHaveLength(1);
  });
});

test('fixed plan activation, replacement and rescission use the edited interval', async ({ context, page }) => {
  await mockBackend(context);
  await page.clock.setFixedTime(new Date('2026-08-17T20:45:00Z'));
  let state = { fixed_plan: null as null | { id: string; starts_at: string; ends_at: string }, revision: 0, generated_revision: 0, generated_fixed_plan_id: null as string | null, ha_ack_status: 'accepted', ha_ack_error: null, valid_until: '2026-08-17T22:00:00Z', error: null, pending: false };
  const submissions: Record<string, unknown>[] = [];
  await context.route('**/functions/v1/energy-optimisation-fixed-plan*', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'status') return route.fulfill({ json: state });
    submissions.push(body);
    state = { ...state, revision: state.revision + 1, pending: true,
      fixed_plan: body.action === 'rescind' ? null : { id: `fixed-${state.revision + 1}`, starts_at: '2026-08-17T21:00:00Z', ends_at: body.ends_at } };
    return route.fulfill({ status: 202, json: { status: 'queued' } });
  });
  await page.goto('/login');
  await page.fill('#email', 'whoever@example.com');
  await page.fill('#password', 'mock-password');
  await page.getByRole('button', { name: 'Logga in' }).click();
  await page.waitForURL(url => !url.pathname.endsWith('/login'));
  await page.goto('/portal/energy-modeling?tab=workbench');
  await page.getByRole('button', { name: /Load the planner|Läs in planerarens/ }).click();
  await expect(page.getByRole('button', { name: /Aktivera fast plan|Activate fixed plan/ })).toBeDisabled();
  const cells = page.locator('input[type="number"]');
  await cells.nth(2).fill('3');
  await cells.nth(2).blur();
  await page.getByRole('button', { name: /Aktivera fast plan|Activate fixed plan/ }).click();
  await expect(page.getByText(/Väntar på Home Assistant|Waiting for Home Assistant/)).toBeVisible();
  expect(submissions[0].ends_at).toBe('2026-08-17T21:30:00.000Z');
  expect(submissions[0].action).toBe('activate');
  await cells.nth(3).fill('3');
  await cells.nth(3).blur();
  await page.getByRole('button', { name: /Ersätt fast plan|Replace fixed plan/ }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].revision).toBe(1);
  expect(submissions[1].ends_at).toBe('2026-08-17T21:45:00.000Z');
  state = { ...state, generated_revision: 2, pending: false, generated_fixed_plan_id: state.fixed_plan!.id };
  // Persistence and cancellation remain accessible before loading the editor.
  await page.reload();
  await expect(page.getByText(/Home Assistant har accepterat|Home Assistant accepted/)).toBeVisible();
  await page.getByRole('button', { name: /Återgå till automatisk|Return to automatic/ }).click();
  await expect.poll(() => submissions.length).toBe(3);
  expect(submissions[2].action).toBe('rescind');
  await expect(page.getByText(/Väntar på Home Assistant|Waiting for Home Assistant/)).toBeVisible();
  state = { ...state, generated_revision: 3, generated_fixed_plan_id: null, pending: false };
  await page.reload();
  await expect(page.getByText(/^(Automatisk planering|Automatic planning)$/)).toBeVisible();
});

// ROI uses stored metered costs, independently of planner forecasts.
test.describe('contract ROI', () => {
  test.beforeEach(async ({ context, page }) => {
    await mockBackend(context);
    await page.route('**/rest/v1/energy_supplier_daily_costs*', route => route.fulfill({ json: Array.from({ length: 31 }, (_, i) => ({
      id: `day-${i}`, customer_id: CUSTOMER_ID, device_token_id: null,
      cost_date: `2026-01-${String(i + 1).padStart(2, '0')}`, import_kwh: 20, import_cost_sek: 10,
      export_kwh: 5, export_credit_sek: 8, priced_hours: 24, created_at: '', updated_at: '',
    })) }));
    await page.goto('/login');
    await page.fill('#email', 'whoever@example.com');
    await page.fill('#password', 'mock-password');
    await page.getByRole('button', { name: 'Logga in' }).click();
    await page.waitForURL(url => !url.pathname.endsWith('/login'));
    await page.goto('/portal/energy-modeling?tab=roi');
  });

  test('compares real imports, persists costs, selects all contract types and reports losses', async ({ page }) => {
    await expect(page.getByTestId('roi-period-saving')).toContainText('392');
    await page.locator('#roi-current-fee').fill('40');
    await page.locator('#roi-pricing-method').selectOption('components');
    await page.locator('#roi-rate').fill('100');
    await page.locator('#roi-contract-fee').fill('50');
    await page.locator('#roi-subscription').fill('100');
    await page.locator('#roi-equipment').fill('2400');
    await page.locator('#roi-installation').fill('240');
    // Alternative 670 - actual 350 = 320; less subscription 100 => 220/month.
    await expect(page.getByTestId('roi-period-saving')).toHaveText('320 SEK');
    await expect(page.getByTestId('roi-annual-net')).toHaveText(/2\s*640 SEK/);
    await expect(page.getByTestId('roi-payback')).toHaveText('1 år');
    await page.reload();
    await expect(page.locator('#roi-equipment')).toHaveValue('2400');
    await expect(page.getByTestId('roi-payback')).toHaveText('1 år');
    await page.locator('#roi-equipment').fill('-1');
    await expect(page.locator('#roi-equipment')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('roi-payback')).toHaveCount(0);
    await page.locator('#roi-equipment').fill('2400');
    await page.locator('#roi-contract-kind').selectOption('monthly');
    await page.locator('#roi-example').selectOption('greenely-month');
    await expect(page.locator('#roi-rate')).toHaveValue('80.75');
    await page.getByText('Ange olika priser per månad', { exact: true }).click();
    await page.locator('#roi-rate-2026-01').fill('90');
    await expect(page.getByTestId('roi-period-saving')).toHaveText('208 SEK');
    await page.locator('#roi-contract-kind').selectOption('mixed');
    await page.locator('#roi-pricing-method').selectOption('components');
    await page.locator('#roi-rate').fill('100');
    await page.locator('#roi-variable-rate').fill('60');
    await page.locator('#roi-fixed-share').fill('50');
    await expect(page.getByTestId('roi-period-saving')).toHaveText('196 SEK');
    await page.locator('#roi-contract-kind').selectOption('quarterly');
    await page.locator('#roi-pricing-method').selectOption('profile');
    await page.locator('#roi-markup').fill('10');
    await expect(page.getByTestId('roi-period-saving')).toHaveText('72 SEK');
    await expect(page.getByTestId('roi-payback')).toHaveText('Ingen återbetalning');
    await page.locator('#roi-markup').fill('-10');
    await expect(page.getByTestId('roi-period-saving')).toHaveText(/[-−]52 SEK/);
    await expect(page.getByText('högre elkostnad med mitt nuvarande avtal')).toBeVisible();
  });

  test('uses bills without adding supplier fees twice, then exposes missing and failed data', async ({ page }) => {
    await page.route('**/rest/v1/energy_billing_documents*', route => route.fulfill({ json: [{
      id: 'invoice', customer_id: CUSTOMER_ID, document_kind: 'electricity', currency: 'SEK',
      period_start: '2026-01-01', period_end: '2026-01-31', consumption_kwh: 620,
      exported_kwh: 100, total_amount_sek: 250, peak_demand_kw: null,
      energy_billing_line_items: [
        { category: 'spot_energy', amount_sek: 300, quantity: 620, period_start: null, period_end: null },
        { category: 'fixed_fee', amount_sek: 50, quantity: null, period_start: null, period_end: null },
        { category: 'export_credit', amount_sek: -100, quantity: null, period_start: null, period_end: null },
      ],
    }] }));
    await page.locator('#roi-current-fee').fill('999');
    await page.locator('#roi-source').selectOption('invoices');
    await expect(page.locator('#roi-current-fee')).toHaveCount(0);
    await page.locator('#roi-rate').fill('100');
    await expect(page.getByTestId('roi-period-saving')).toHaveText('270 SEK');
    await page.locator('#roi-from').fill('2027-01');
    await expect(page.getByTestId('roi-period-saving')).toHaveCount(0);
    await page.route('**/rest/v1/energy_billing_documents*', route => route.fulfill({ status: 500, json: { message: 'Unavailable' } }));
    await page.reload();
    await expect(page.getByText('Kunde inte läsa elhistoriken', { exact: true })).toBeVisible();
    await expect(page.getByTestId('roi-period-saving')).toHaveCount(0);
  });

  test('remains readable on mobile and at desktop size', async ({ page }) => {
    await expect(page.getByTestId('roi-period-saving')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '/tmp/roi-desktop.png', fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 375, height: 812 });
    const roi = page.getByTestId('contract-roi');
    await expect(roi).toBeVisible();
    const bounds = await roi.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(375);
    await expect(page.locator('#roi-contract-kind')).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({
      viewport: window.innerWidth,
      overflow: [...document.querySelectorAll('body *')].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed';
      }).slice(0, 12).map(el => `${el.tagName}.${el.className}`),
      width: document.documentElement.scrollWidth,
    }))).toMatchObject({ width: 375 });
    await page.screenshot({ path: '/tmp/roi-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 812, height: 375 });
    expect((await roi.boundingBox())!.width).toBeLessThanOrEqual(812);
  });
});
