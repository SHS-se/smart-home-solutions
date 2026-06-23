/**
 * Invoice ↔ BOM fulfillment regression tests — fully local, no real backend.
 *
 * The Supabase REST/Auth API is mocked via route interception. These tests guard the
 * BOM-first fulfillment behaviour of the invoice draft editor:
 *
 *  - A BOM-linked draft that already has its hardware lines must NOT be re-expanded into the
 *    full BOM on (re)load. Regression for the bug where the "restore hardware from BOM" effect
 *    read transient local state during hydration and re-injected already-invoiced items, piling
 *    up duplicates over time.
 *  - Only items with remaining-to-invoice > 0 belong on the draft; fully invoiced SKUs stay off it.
 *
 * Run with a local dev server:
 *   E2E_BASE_URL=http://localhost:8080 npx playwright test e2e/invoice-bom-fulfillment.spec.ts
 */
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';

const STAFF_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const BOM_ID = '22222222-3333-4444-8555-666666666666';
const BOM_GROUP_ID = '33333333-4444-4555-8666-777777777777';
const INVOICE_ID = '44444444-5555-4666-8777-888888888888';

const SKU_UDB = 'sku-udb';
const SKU_UDR7 = 'sku-udr7';
const SKU_NABU = 'sku-nabu';
const SKU_EMS = 'sku-ems';

const ITEM_UDB = 'item-udb';
const ITEM_UDR7 = 'item-udr7';
const ITEM_NABU = 'item-nabu';
const ITEM_EMS = 'item-ems';

// BOM v4: three SKUs fully invoiced (remaining 0), one with an outstanding unit (EMS).
const FULLY_INVOICED_SKUS = ['NET-UBQ-UDB', 'NET-UBQ-UDR7', 'HA-HOST-NABU-GREEN'];
const REMAINING_SKU = 'CTR-EMS-GW-E32-V2';

function fakeJwt(sub: string, email: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: 'HS256', typ: 'JWT' }),
    enc({ sub, email, aud: 'authenticated', role: 'authenticated', exp: now + 3600, iat: now }),
    'x'.repeat(43),
  ].join('.');
}

const nowIso = new Date().toISOString();

const customer = { id: CUSTOMER_ID, name: 'Sven Titusson', contact_name: 'Sven', billing_email: 'sven@example.com' };

const invoice = {
  id: INVOICE_ID,
  invoice_number: null,
  customer_id: CUSTOMER_ID,
  bom_id: BOM_ID,
  bom_version: 4,
  quote_id: null,
  quote_number: null,
  status: 'draft',
  is_test: true,
  due_date: '2026-07-07',
  customer: { id: CUSTOMER_ID, name: 'Sven Titusson', billing_email: 'sven@example.com' },
  bom: { id: BOM_ID, project_name: 'Porfyrvägen 3', version: 4 },
};

const computedTotals = { invoice_id: INVOICE_ID, subtotal: 1515, tax: 379, total: 1894 };

// The persisted draft has exactly one hardware line — the outstanding EMS Gateway unit.
const invoiceLineItems = [
  {
    id: 'line-ems',
    invoice_id: INVOICE_ID,
    line_type: 'hardware',
    description: 'EMS Gateway E32 V2',
    sku: REMAINING_SKU,
    sku_id: SKU_EMS,
    quantity: 1,
    unit_price: 1515,
    tax_rate: 25,
    category: 'hardware',
    sort_order: 0,
    source_bom_id: BOM_ID,
    source_bom_item_id: ITEM_EMS,
    source_bom_version: 4,
    created_at: nowIso,
  },
];

const bomItems = [
  { id: ITEM_UDB, sku_id: SKU_UDB, quantity: 1, cost_ex_vat_at_time: 975, skus: { sku: 'NET-UBQ-UDB', name: 'Unifi Device Bridge', sell_price_ex_vat: 1220, vat_rate: 0.25 } },
  { id: ITEM_UDR7, sku_id: SKU_UDR7, quantity: 1, cost_ex_vat_at_time: 2740, skus: { sku: 'NET-UBQ-UDR7', name: 'Unifi Dream Router 7', sell_price_ex_vat: 3425, vat_rate: 0.25 } },
  { id: ITEM_NABU, sku_id: SKU_NABU, quantity: 1, cost_ex_vat_at_time: 1529, skus: { sku: 'HA-HOST-NABU-GREEN', name: 'Nabu Casa Home Assistant Green', sell_price_ex_vat: 1915, vat_rate: 0.25 } },
  { id: ITEM_EMS, sku_id: SKU_EMS, quantity: 1, cost_ex_vat_at_time: 1081, skus: { sku: REMAINING_SKU, name: 'EMS Gateway E32 V2', sell_price_ex_vat: 1515, vat_rate: 0.25 } },
];

const fulfillmentRows = [
  { bom_group_id: BOM_GROUP_ID, sku_id: SKU_UDB, bom_quantity: 1, quoted_quantity: 0, invoiced_quantity: 1, remaining_quantity: 0 },
  { bom_group_id: BOM_GROUP_ID, sku_id: SKU_UDR7, bom_quantity: 1, quoted_quantity: 1, invoiced_quantity: 1, remaining_quantity: 0 },
  { bom_group_id: BOM_GROUP_ID, sku_id: SKU_NABU, bom_quantity: 1, quoted_quantity: 1, invoiced_quantity: 1, remaining_quantity: 0 },
  { bom_group_id: BOM_GROUP_ID, sku_id: SKU_EMS, bom_quantity: 1, quoted_quantity: 0, invoiced_quantity: 0, remaining_quantity: 1 },
];

const bomSingle = { id: BOM_ID, version: 4, bom_group_id: BOM_GROUP_ID, project_name: 'Porfyrvägen 3', customer_id: CUSTOMER_ID };
const bomsGroupList = [{ id: BOM_ID, version: 4, bom_group_id: BOM_GROUP_ID }];
const bomsList = [{ id: BOM_ID, project_name: 'Porfyrvägen 3', version: 4, customer_id: CUSTOMER_ID }];

async function fulfillRows(
  route: Parameters<Parameters<BrowserContext['route']>[1]>[0],
  rows: Record<string, unknown>[],
  wantsObject: boolean,
) {
  if (wantsObject) {
    if (rows.length === 0) {
      await route.fulfill({
        status: 406,
        json: { code: 'PGRST116', details: 'Results contain 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' },
      });
    } else {
      await route.fulfill({ json: rows[0], headers: { 'content-range': '0-0/1' } });
    }
    return;
  }
  await route.fulfill({
    json: rows,
    headers: { 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' },
  });
}

async function mockSupabase(context: BrowserContext) {
  const user = {
    id: STAFF_USER_ID,
    email: 'staff.member@smarthomesolutions.se',
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
          access_token: fakeJwt(STAFF_USER_ID, user.email),
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
    const method = req.method();

    // Acknowledge writes (auto-save etc.) without persisting — assertions run against the fixed reads.
    if (method !== 'GET' && method !== 'HEAD') {
      await route.fulfill({ status: 201, json: [], headers: { 'content-range': '*/0' } });
      return;
    }

    if (url.pathname.includes('/rpc/')) {
      await route.fulfill({ json: false });
      return;
    }

    const table = url.pathname.split('/').pop() || '';
    const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object');

    switch (table) {
      case 'staff_users':
        return fulfillRows(route, [{ role: 'admin' }], wantsObject);
      case 'customers_with_identity':
        return fulfillRows(route, [customer], wantsObject);
      case 'invoices':
        return fulfillRows(route, [invoice], wantsObject);
      case 'invoice_computed_totals':
        return fulfillRows(route, [computedTotals], wantsObject);
      case 'invoice_line_items':
        return fulfillRows(route, invoiceLineItems, wantsObject);
      case 'bom_items':
        return fulfillRows(route, bomItems, wantsObject);
      case 'bom_fulfillment':
        return fulfillRows(route, fulfillmentRows, wantsObject);
      case 'boms': {
        if (url.searchParams.has('bom_group_id')) return fulfillRows(route, bomsGroupList, wantsObject);
        if (wantsObject || url.searchParams.has('id')) return fulfillRows(route, [bomSingle], wantsObject);
        return fulfillRows(route, bomsList, wantsObject);
      }
      default:
        return fulfillRows(route, [], wantsObject);
    }
  });

  await context.route('**/functions/v1/**', (route) =>
    route.fulfill({ json: { subscribed: false, subscription_end: null } })
  );
  await context.route('**/storage/v1/**', (route) => route.fulfill({ json: [] }));
}

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#email', 'staff.member@smarthomesolutions.se');
  await page.fill('#password', 'mock-password');
  await page.getByRole('button', { name: 'Logga in' }).click();
  await page.waitForURL('**/portal');
}

test.describe('invoice draft ↔ BOM fulfillment', () => {
  test.beforeEach(async ({ context }) => {
    await mockSupabase(context);
  });

  test('BOM-linked draft keeps only its outstanding line and never re-injects the full BOM', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/invoices/new?id=${INVOICE_ID}`);

    await expect(page.getByRole('heading', { name: 'Fakturaförberedelse' })).toBeVisible();

    const assertOutstandingOnly = async () => {
      // The single outstanding line is present.
      await expect(page.getByText(REMAINING_SKU)).toHaveCount(1);
      // Already-invoiced SKUs must never appear as lines.
      for (const sku of FULLY_INVOICED_SKUS) {
        await expect(page.getByText(sku)).toHaveCount(0);
      }
    };

    await assertOutstandingOnly();

    // Give any (buggy) restore-from-BOM effect a window to fire before asserting the invariant holds.
    await page.waitForTimeout(2000);
    await assertOutstandingOnly();

    // The line sits exactly at its remaining quantity, so finalize is allowed and no overage alert shows.
    await expect(page.getByTestId('invoice-bom-overage-alert')).toHaveCount(0);
    await expect(page.getByTestId('invoice-finalize-button')).toBeEnabled();

    // Revisiting (warm reload) must not accumulate extra hardware either.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Fakturaförberedelse' })).toBeVisible();
    await page.waitForTimeout(2000);
    await assertOutstandingOnly();
  });
});
