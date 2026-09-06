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

    // A breach names a time, and clicking it takes the table there. The fixture
    // supplies real ones: the planner's own export leak (§8.20.1).
    const breach = page.locator('button', { hasText: /^\d{2}\/\d{2} \d{2}:\d{2}$/ }).first();
    await expect(breach).toBeVisible();
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

    // And the whole comparison leaves the machine as one file.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export|Exportera/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^plan-.*\.json$/);
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(payload.format).toBe('shs.plan-workbench.v1');
    expect(payload.quarters).toHaveLength(288);
    expect(payload.scores.planner.total_sek).toBeLessThan(0);
  });
});
