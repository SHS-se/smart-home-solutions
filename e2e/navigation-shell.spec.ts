/**
 * Navigation shell smoke tests — fully local, no real backend.
 *
 * The Supabase API is mocked via route interception, so these tests verify
 * the app shell (sidebar, topbar, customer-view banner, role-based nav)
 * without touching any shared database.
 *
 * Run with a local dev server:
 *   E2E_BASE_URL=http://localhost:8080 npx playwright test e2e/navigation-shell.spec.ts
 */
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const STAFF_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CUSTOMER_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const VIEWED_CUSTOMER_NAME = 'Ana the Wifey';

function fakeJwt(sub: string, email: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: 'HS256', typ: 'JWT' }),
    enc({ sub, email, aud: 'authenticated', role: 'authenticated', exp: now + 3600, iat: now }),
    'x'.repeat(43),
  ].join('.');
}

const viewedCustomer = {
  id: CUSTOMER_ID,
  contact_id: null,
  contact_name: 'Ana Contact',
  contact_email: 'ana@example.com',
  contact_phone: null,
  name: VIEWED_CUSTOMER_NAME,
  billing_email: 'ana@example.com',
  phone: null,
  site_street: null,
  site_postcode: null,
  site_city: null,
  billing_street: null,
  billing_postcode: null,
  billing_city: null,
  billing_same_as_site: true,
  is_test: true,
};

async function mockSupabase(context: BrowserContext, role: 'staff' | 'customer') {
  const userId = role === 'staff' ? STAFF_USER_ID : CUSTOMER_USER_ID;
  const email = role === 'staff' ? 'staff.member@smarthomesolutions.se' : 'ana@example.com';
  const nowIso = new Date().toISOString();
  const user = {
    id: userId,
    email,
    aud: 'authenticated',
    role: 'authenticated',
    email_confirmed_at: nowIso,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: nowIso,
    updated_at: nowIso,
  };

  await context.route('**/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/token')) {
      const now = Math.floor(Date.now() / 1000);
      await route.fulfill({
        json: {
          access_token: fakeJwt(userId, email),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          refresh_token: 'fake-refresh-token',
          user,
        },
      });
    } else if (url.pathname.endsWith('/user')) {
      await route.fulfill({ json: user });
    } else if (url.pathname.endsWith('/logout')) {
      await route.fulfill({ status: 204, body: '' });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  await context.route('**/rest/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (url.pathname.includes('/rpc/')) {
      await route.fulfill({ json: false });
      return;
    }

    const table = url.pathname.split('/').pop() || '';
    const rows: Record<string, unknown>[] = (() => {
      if (table === 'staff_users') {
        return role === 'staff' ? [{ role: 'admin' }] : [];
      }
      if (table === 'customers_with_identity') {
        // Customer role: matched by user_id. Staff customer-view: matched by id.
        return [viewedCustomer];
      }
      return [];
    })();

    const accept = req.headers()['accept'] || '';
    if (accept.includes('vnd.pgrst.object')) {
      if (rows.length === 0) {
        await route.fulfill({
          status: 406,
          json: {
            code: 'PGRST116',
            details: 'Results contain 0 rows',
            hint: null,
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        });
      } else {
        await route.fulfill({ json: rows[0], headers: { 'content-range': '0-0/1' } });
      }
      return;
    }

    await route.fulfill({
      json: rows,
      headers: {
        'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0',
      },
    });
  });

  await context.route('**/functions/v1/**', (route) =>
    route.fulfill({ json: { subscribed: false, subscription_end: null } })
  );
  await context.route('**/storage/v1/**', (route) => route.fulfill({ json: [] }));
}

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#email', 'whoever@example.com');
  await page.fill('#password', 'mock-password');
  await page.getByRole('button', { name: 'Logga in' }).click();
  await page.waitForURL('**/portal');
}

test.describe('staff navigation shell', () => {
  test.beforeEach(async ({ context }) => {
    await mockSupabase(context, 'staff');
  });

  test('staff sees grouped sidebar with integrated accounting', async ({ page }) => {
    await login(page);
    const sidebar = page.locator('[data-sidebar="sidebar"]');

    // Grouped staff sidebar from the central nav config.
    await expect(page.getByRole('link', { name: 'Kunder', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Kontakter', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SKU-katalog' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Marginalregler' })).toBeVisible();
    await expect(sidebar.getByText('CRM', { exact: true })).toBeVisible();

    // Accounting is a collapsible group inside the same sidebar (collapsed by default).
    await expect(sidebar.getByText('Bokföring', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Momsperioder' })).toBeHidden();
    await sidebar.getByText('Bokföring', { exact: true }).click();
    await expect(page.getByRole('link', { name: 'Momsperioder' })).toBeVisible();

    await page.screenshot({ path: 'test-results/nav-staff-portal.png', fullPage: false });

    // Navigating into accounting keeps the same staff shell (no separate product).
    await page.getByRole('link', { name: 'Momsperioder' }).click();
    await page.waitForURL('**/accounting/vat-periods');
    await expect(page.getByRole('link', { name: 'Kunder', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Personal');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Momsperioder');

    await page.screenshot({ path: 'test-results/nav-staff-accounting.png', fullPage: false });
  });

  test('recovers when a route chunk is briefly unavailable during deployment', async ({ page }) => {
    let failedChunkRequests = 0;
    await page.route('**/assets/Customers-*.js', async (route) => {
      if (failedChunkRequests < 2) {
        failedChunkRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Temporary SPA fallback</title>',
        });
        return;
      }
      await route.continue();
    });

    await login(page);
    await page.goto('/portal/customers');

    await expect(page.getByRole('heading', { name: 'Kunder', exact: true })).toBeVisible();
    expect(failedChunkRequests).toBe(2);
  });

  test('customer view shows persistent banner and customer-scoped nav', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/billing`);

    // Persistent context indicator: clearly staff viewing one customer.
    await expect(page.getByText('du ser kundens portal som personal')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Avsluta kundvy' })).toBeVisible();
    await expect(page.getByText(VIEWED_CUSTOMER_NAME).first()).toBeVisible();

    // Customer-style nav scoped to this customer; global staff nav hidden.
    const homeProfileLink = page.getByRole('link', { name: 'Hemprofil' });
    await expect(homeProfileLink).toBeVisible();
    await expect(homeProfileLink).toHaveAttribute(
      'href',
      `/portal/customers/${CUSTOMER_ID}/home-profile`
    );
    await expect(page.getByRole('link', { name: 'SKU-katalog' })).toBeHidden();
    await expect(
      page.locator('[data-sidebar="sidebar"]').getByText('CRM', { exact: true })
    ).toBeHidden();

    // Breadcrumb: Kunder / <name> / <section>.
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(breadcrumb.getByRole('link', { name: 'Kunder' })).toBeVisible();
    await expect(breadcrumb).toContainText(VIEWED_CUSTOMER_NAME);

    await page.screenshot({ path: 'test-results/nav-customer-view.png', fullPage: false });

    // Exit returns to the global customers list.
    await page.getByRole('button', { name: 'Avsluta kundvy' }).click();
    await page.waitForURL('**/portal/customers');
  });

  test('index customer-view route redirects to overview', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}`);
    await page.waitForURL(`**/portal/customers/${CUSTOMER_ID}/overview`);
    await expect(page.getByText('du ser kundens portal som personal')).toBeVisible();
  });

  test('public header offers a portal shortcut to logged-in users', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Portalen' })).toBeVisible();
    await page.getByRole('link', { name: 'Portalen' }).click();
    await page.waitForURL('**/portal');
  });
});

test.describe('customer navigation shell', () => {
  test.beforeEach(async ({ context }) => {
    await mockSupabase(context, 'customer');
  });

  test('customer sees flat portal nav without staff sections', async ({ page }) => {
    await login(page);

    await expect(page.getByText('Kundportal').first()).toBeVisible();
    for (const label of ['Hemprofil', 'Energimodellering', 'Offerter', 'Fakturor', 'Konto']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    await expect(sidebar.getByText('CRM', { exact: true })).toBeHidden();
    await expect(sidebar.getByText('Bokföring', { exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: 'SKU-katalog' })).toBeHidden();

    await page.screenshot({ path: 'test-results/nav-customer-portal.png', fullPage: false });
  });

  test('user menu only contains account-level actions', async ({ page }) => {
    await login(page);

    await page.getByRole('button', { name: VIEWED_CUSTOMER_NAME }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Konto' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Logga ut' })).toBeVisible();
    // The dropdown is no longer the app navigation.
    await expect(menu.getByRole('menuitem', { name: 'SKU-katalog' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Hemprofil' })).toHaveCount(0);
  });

  test('staff-only routes redirect customers back to the portal', async ({ page }) => {
    await login(page);
    await page.goto('/portal/skus');
    await page.waitForURL('**/portal');
    await page.goto('/accounting/overview');
    await page.waitForURL('**/portal');
  });
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ context }) => {
    await mockSupabase(context, 'staff');
  });

  test('sidebar collapses to a drawer behind the trigger', async ({ page }) => {
    await login(page);

    await expect(page.getByRole('link', { name: 'Kunder', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
    await expect(page.getByRole('link', { name: 'Kunder', exact: true })).toBeVisible();

    await page.screenshot({ path: 'test-results/nav-mobile-drawer.png', fullPage: false });
  });
});

test.describe('guest navigation', () => {
  test('public pages keep the lightweight marketing header', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Logga in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tjänster', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Kunskapscenter', exact: true })).toBeVisible();
    await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  });
});
