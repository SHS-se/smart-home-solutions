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
const PRIMARY_HOME_ID = 'cccccccc-dddd-4eee-8fff-111111111111';
const MOVE_IN_QUESTION_ID = '50000000-0000-4000-8000-000000000001';
const HEATED_BOAREA_QUESTION_ID = '50000000-0000-4000-8000-000000000002';
const HEATED_BIAREA_QUESTION_ID = '50000000-0000-4000-8000-000000000003';
const HAS_SOLAR_QUESTION_ID = '50000000-0000-4000-8000-000000000004';

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

const temperatureChartBaseReadings: Array<[string, number]> = [
  ['2024-01-03', 152],
  ['2024-02-04', 108],
  ['2024-03-05', 72],
  ['2025-01-06', 136],
  ['2025-02-07', 95],
];

const temperatureImpactSeries = Array.from({ length: 365 }, (_, index) => {
  const date = new Date(Date.UTC(2025, 2, 4 + index));
  const readingDate = date.toISOString().slice(0, 10);
  const temperatureC = Number((4 + (12 * Math.sin(index / 28))).toFixed(1));
  const expectedKwh = 95 - (3.2 * temperatureC) + (0.08 * (temperatureC ** 2));
  const eventDate = '2025-12-03';
  const eventAdjustmentKwh = readingDate < eventDate ? 14 : readingDate > eventDate ? -8 : 0;
  return {
    readingDate,
    temperatureC,
    consumptionKwh: Number((expectedKwh + eventAdjustmentKwh).toFixed(1)),
  };
});

const gridImportReadings = [
  ...temperatureChartBaseReadings,
  ...temperatureImpactSeries.map((point) => [
    point.readingDate,
    Number(Math.max(4, point.consumptionKwh * 0.35).toFixed(1)),
  ] as const),
].map(([reading_date, consumption_kwh], index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  customer_id: CUSTOMER_ID,
  reading_date,
  reading_kind: 'grid_import',
  consumption_kwh,
  source_import_id: '20000000-0000-4000-8000-000000000001',
  created_at: '2026-07-28T00:00:00Z',
  updated_at: '2026-07-28T00:00:00Z',
}));

const totalConsumptionReadings = temperatureImpactSeries.map((point, index) => ({
  id: `11000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  customer_id: CUSTOMER_ID,
  reading_date: point.readingDate,
  reading_kind: 'total_consumption',
  consumption_kwh: point.consumptionKwh,
  source_import_id: '20000000-0000-4000-8000-000000000002',
  created_at: '2026-07-28T00:00:00Z',
  updated_at: '2026-07-28T00:00:00Z',
}));

const temperatureChartReadings = [
  ...gridImportReadings,
  ...totalConsumptionReadings,
].sort((readingA, readingB) => (
  readingA.reading_date.localeCompare(readingB.reading_date)
  || readingA.reading_kind.localeCompare(readingB.reading_kind)
));

const energyUsageImportBatches = [
  {
    id: '20000000-0000-4000-8000-000000000002',
    customer_id: CUSTOMER_ID,
    original_file_name: 'Sigenergy total load.csv',
    file_sha256: 'a'.repeat(64),
    reading_kind: 'total_consumption',
    reading_count: 365,
    imported_by: STAFF_USER_ID,
    created_at: '2026-07-28T10:00:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000001',
    customer_id: CUSTOMER_ID,
    original_file_name: 'Grid import history.csv',
    file_sha256: 'b'.repeat(64),
    reading_kind: 'grid_import',
    reading_count: 370,
    imported_by: STAFF_USER_ID,
    created_at: '2026-07-27T10:00:00Z',
  },
];

const energyParseFailures = [{
  id: '21000000-0000-4000-8000-000000000001',
  customer_id: CUSTOMER_ID,
  original_file_name: 'unsupported-provider-invoice.pdf',
  file_path: `${CUSTOMER_ID}/21000000-0000-4000-8000-000000000001/unsupported-provider-invoice.pdf`,
  mime_type: 'application/pdf',
  file_size_bytes: 12345,
  file_sha256: 'c'.repeat(64),
  file_category: 'document',
  parser_error: 'Billing parser rejected the file: unknown_format',
  uploaded_by: STAFF_USER_ID,
  created_at: '2026-07-28T11:00:00Z',
}];

const temperatureChartBaseObservations: Array<[string, number]> = [
  ['2024-01-03', -6],
  ['2024-02-04', 1],
  ['2024-03-05', 8],
  ['2025-01-06', -5],
  ['2025-02-07', 2],
];

const temperatureChartObservations = [
  ...temperatureChartBaseObservations,
  ...temperatureImpactSeries.map((point) => [point.readingDate, point.temperatureC] as const),
].map(([observed_on, temperature_c], index) => ({
  id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  dataset_key: 'stockholm-taby',
  observed_on,
  temperature_c,
  quality_code: null,
  created_at: '2026-07-28T00:00:00Z',
  updated_at: '2026-07-28T00:00:00Z',
}));

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
  let mockedUsageImports = energyUsageImportBatches.map((row) => ({ ...row }));
  let mockedParseFailures = energyParseFailures.map((row) => ({ ...row }));

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

    if (url.pathname.endsWith('/rpc/delete_energy_usage_import')) {
      const body = req.postDataJSON() as { p_import_id?: string };
      const deleted = mockedUsageImports.find((row) => row.id === body.p_import_id);
      mockedUsageImports = mockedUsageImports.filter((row) => row.id !== body.p_import_id);
      await route.fulfill({ json: deleted?.reading_count ?? 0 });
      return;
    }
    if (url.pathname.endsWith('/rpc/delete_energy_parse_failure')) {
      const body = req.postDataJSON() as { p_failure_id?: string };
      const deleted = mockedParseFailures.find((row) => row.id === body.p_failure_id);
      mockedParseFailures = mockedParseFailures.filter((row) => row.id !== body.p_failure_id);
      await route.fulfill({ json: deleted?.file_path ?? null });
      return;
    }
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
      if (table === 'customers') {
        return [{ id: CUSTOMER_ID, primary_home_id: PRIMARY_HOME_ID }];
      }
      if (table === 'home_questions') {
        const semanticKey = url.searchParams.get('semantic_key') || '';
        const matchingQuestions: Record<string, unknown>[] = [];
        if (semanticKey.includes('move_in_date')) {
          matchingQuestions.push({
            id: MOVE_IN_QUESTION_ID,
            semantic_key: 'move_in_date',
          });
        }
        if (semanticKey.includes('heated_boarea_m2')) {
          matchingQuestions.push({
            id: HEATED_BOAREA_QUESTION_ID,
            semantic_key: 'heated_boarea_m2',
          });
        }
        if (semanticKey.includes('heated_biarea_m2')) {
          matchingQuestions.push({
            id: HEATED_BIAREA_QUESTION_ID,
            semantic_key: 'heated_biarea_m2',
          });
        }
        if (semanticKey.includes('has_solar')) {
          matchingQuestions.push({
            id: HAS_SOLAR_QUESTION_ID,
            semantic_key: 'has_solar',
          });
        }
        return matchingQuestions;
      }
      if (table === 'home_answers') {
        const questionId = url.searchParams.get('question_id') || '';
        const matchingAnswers: Record<string, unknown>[] = [];
        if (questionId.includes(MOVE_IN_QUESTION_ID)) {
          matchingAnswers.push({
            question_id: MOVE_IN_QUESTION_ID,
            answer_value: '2021-10-01',
            answer_text: '2021-10-01',
          });
        }
        if (questionId.includes(HEATED_BOAREA_QUESTION_ID)) {
          matchingAnswers.push({
            question_id: HEATED_BOAREA_QUESTION_ID,
            answer_value: 160,
            answer_text: '160',
          });
        }
        if (questionId.includes(HEATED_BIAREA_QUESTION_ID)) {
          matchingAnswers.push({
            question_id: HEATED_BIAREA_QUESTION_ID,
            answer_value: 40,
            answer_text: '40',
          });
        }
        if (questionId.includes(HAS_SOLAR_QUESTION_ID)) {
          matchingAnswers.push({
            question_id: HAS_SOLAR_QUESTION_ID,
            answer_value: true,
            answer_text: 'true',
          });
        }
        return matchingAnswers;
      }
      if (table === 'energy_weather_datasets') {
        return [{
          dataset_key: 'stockholm-taby',
          display_name: 'Stockholm / Täby reference temperature',
          source_name: 'SMHI daily mean air temperature, Stockholm-Observatoriekullen A',
          source_url: 'https://opendata-download-metobs.smhi.se/',
          station_id: '98230',
          latitude: 59.3417,
          longitude: 18.0549,
          last_synced_at: nowIso,
          last_observation_date: nowIso.slice(0, 10),
          sync_started_at: null,
          sync_error: null,
        }];
      }
      if (table === 'energy_usage_current_readings') {
        return temperatureChartReadings;
      }
      if (table === 'energy_usage_import_batches') {
        return mockedUsageImports;
      }
      if (table === 'energy_parse_failures') {
        return mockedParseFailures;
      }
      if (table === 'energy_weather_observations') {
        return temperatureChartObservations;
      }
      if (table === 'energy_history_notes') {
        return [{
          id: '40000000-0000-4000-8000-000000000001',
          customer_id: CUSTOMER_ID,
          note_date: '2025-12-03',
          event_text: 'Installerade 3-glasfönster och nya ytterdörrar',
          created_by: userId,
          updated_by: userId,
          created_at: '2026-07-28T00:00:00Z',
          updated_at: '2026-07-28T00:00:00Z',
        }];
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

  test('temperature history explains the automatic shared SMHI data', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);
    const weatherRequestPromise = page.waitForRequest(
      (request) => request.url().includes('/rest/v1/energy_weather_observations'),
    );
    await page.getByRole('tab', { name: 'Temperatur' }).click();
    const weatherRequest = await weatherRequestPromise;
    const weatherUrl = new URL(weatherRequest.url());

    await expect(page.getByText('Automatisk temperaturdata från SMHI')).toBeVisible();
    await expect(page.getByText(/hämtas automatiskt varje natt/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Visa originaldata hos SMHI' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Uppdatera väderdata/ })).toHaveCount(0);
    expect(weatherUrl.searchParams.getAll('observed_on')).toEqual([
      'gte.2024-01-03',
      'lte.2026-03-03',
    ]);
  });

  test('overview shows single-field events and chart annotations', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);

    const events = page.getByTestId('energy-history-events');
    await expect(events.getByRole('heading', { name: 'Lägg till händelse' })).toBeVisible();
    await expect(events.getByLabel('Datum')).toBeVisible();
    await expect(events.getByLabel('Händelse')).toBeVisible();
    await expect(events.getByLabel('Rubrik')).toHaveCount(0);
    await expect(events.getByLabel('Beskrivning')).toHaveCount(0);
    await expect(events.getByText('Installerade 3-glasfönster och nya ytterdörrar')).toHaveCount(0);

    await expect(page.getByText('◆ 1 händelser')).toBeVisible();
    await expect(page.locator('line[stroke="#0f766e"][stroke-dasharray="4 4"]')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/energy-history-events.png', fullPage: true });
  });

  test('energy history separates grid savings from whole-home efficiency and uses one upload box', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);

    const sourceComparison = page.getByTestId('energy-source-comparison');
    await expect(sourceComparison.getByText('Nätuttag och husets verkliga energibehov')).toBeVisible();
    await expect(sourceComparison.getByText('Tekniskt årsbehov')).toBeVisible();
    await expect(sourceComparison.getByText(/365 totaldagar/)).toBeVisible();

    await expect(page.getByTestId('energy-performance')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/energy-source-accounting.png', fullPage: true });

    await page.getByRole('tab', { name: 'Ladda upp' }).click();
    const upload = page.getByTestId('energy-data-upload');
    await expect(upload.getByRole('heading', { name: 'Ladda upp energidata' })).toBeVisible();
    await expect(upload.locator('input[type="file"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Elnätsfakturor' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Elhandelsfakturor' })).toHaveCount(0);
  });

  test('gaps are shown discreetly and only where a receipt would help', async ({ page }) => {
    // Two grid invoices with April missing between them, and no electricity
    // invoice at all — the shape that used to raise a permanent yellow banner.
    const gridInvoice = (id: string, month: string, days: number) => ({
      id,
      customer_id: CUSTOMER_ID,
      document_kind: 'grid',
      provider_key: 'ellevio',
      provider_name: 'Ellevio',
      period_start: `${month}-01`,
      period_end: `${month}-${String(days).padStart(2, '0')}`,
      consumption_kwh: 1200,
      exported_kwh: null,
      peak_demand_kw: null,
      total_amount_sek: 2400,
      vat_sek: 480,
      invoice_number: id,
      invoice_date: `${month}-28`,
      currency: 'SEK',
      energy_billing_line_items: [],
    });
    await page.route('**/rest/v1/energy_billing_documents*', (route) => route.fulfill({
      json: [
        gridInvoice('inv-mar', '2026-03', 31),
        gridInvoice('inv-may', '2026-05', 31),
      ],
    }));

    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);

    // The alarm is gone for good.
    await expect(page.getByText('Luckor eller delperioder upptäckta')).toHaveCount(0);

    // What remains is one quiet, actionable line naming the receipts.
    const hint = page.getByText('Ihåliga punkter är månader utan komplett kvitto.');
    await expect(hint).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ladda upp' })).toBeVisible();

    // The months themselves are marked in the chart: a hollow, dashed marker
    // where an estimate carries the month, a solid one where a receipt does.
    await expect(
      page.locator('svg circle[stroke-dasharray="2 1.5"]').first(),
    ).toBeVisible();

    await page.screenshot({ path: 'test-results/energy-gap-hint.png', fullPage: true });

    // The full inventory moved to the Data tab, where it is reference material.
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByRole('heading', { name: 'Månadstäckning' })).toBeVisible();
  });

  test('energiprestanda lives in its own tab and grades without Home Assistant data', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);
    await page.getByRole('tab', { name: 'Energiprestanda' }).click();

    const performance = page.getByTestId('energy-performance');
    await expect(performance.getByText('Energiprestanda (primärenergital)')).toBeVisible();
    await expect(performance.getByText('Ej officiell')).toBeVisible();
    await expect(page.getByTestId('energy-performance-method')).toHaveText(
      'Uppskattad från nätuttag',
    );
    await expect(page.getByTestId('energy-class-badge')).toHaveText('D');
    await expect(
      performance.getByText('Koppla Home Assistant', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Mer precision med Home Assistant')).toBeVisible();
    await page.screenshot({ path: 'test-results/energy-performance-tab.png', fullPage: true });
  });

  test('energy imports expose privacy-safe deletion and parser review', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);
    const staffAlert = page.getByTestId('staff-energy-parse-alert');
    await expect(staffAlert).toContainText('1 energifiler behöver parsergranskning');
    const reviewOldest = staffAlert.getByRole('link', { name: 'Granska äldsta filen' });
    await expect(reviewOldest).toHaveAttribute(
      'href',
      `/portal/customers/${CUSTOMER_ID}/energy-history?tab=documents`,
    );
    await reviewOldest.click();
    await expect(page.getByRole('tab', { name: 'Data', exact: true })).toHaveAttribute(
      'data-state',
      'active',
    );

    const management = page.getByTestId('energy-data-management');
    await expect(management.getByText('Källfiler minimeras')).toBeVisible();
    await expect(management).toContainText(
      'Originalfilen behålls endast när parsningen misslyckas',
    );

    const failures = page.getByTestId('energy-parse-failures');
    await expect(failures).toContainText('unsupported-provider-invoice.pdf');
    await expect(failures).toContainText('Personalåtgärd kan krävas');
    await expect(failures.getByRole('button', { name: 'Granska' })).toBeVisible();
    await expect(failures.getByRole('button', { name: 'Ta bort' })).toBeVisible();

    const usageImports = page.getByTestId('energy-usage-imports');
    await expect(usageImports).toContainText('Sigenergy total load.csv');
    await expect(usageImports).toContainText('Husets totalförbrukning');
    await page.screenshot({ path: 'test-results/energy-data-management.png', fullPage: true });
    await usageImports.getByRole('button', { name: 'Ta bort import' }).first().click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('den äldre datan synlig igen');
    await dialog.getByRole('button', { name: 'Ta bort permanent' }).click();
    await expect(dialog).toBeHidden();
    await expect(usageImports).not.toContainText('Sigenergy total load.csv');
    await expect(usageImports).toContainText('Grid import history.csv');

    await failures.getByRole('button', { name: 'Ta bort' }).click();
    await dialog.getByRole('button', { name: 'Ta bort permanent' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('energy-parse-failures')).toHaveCount(0);
    await expect(page.getByTestId('staff-energy-parse-alert')).toHaveCount(0);
  });

  test('temperature charts provide readable series controls', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);
    await page.getByRole('tab', { name: 'Temperatur' }).click();

    await expect(page.getByTestId('temperature-energy-source')).toContainText('365 totaldagar');
    await expect(page.getByTestId('weather-normalized-history-chart')).toBeVisible();
    await expect(page.getByTestId('event-impact-chart')).toBeVisible();
    await expect(page.getByTestId('event-impact-chart').locator('.recharts-bar-rectangle')).toHaveCount(2);

    const yearControls = page.getByRole('group', { name: 'Visa årsserier' });
    await expect(yearControls).toBeVisible();
    await expect(yearControls.getByRole('button', { name: '2024' })).toHaveAttribute('aria-pressed', 'true');
    await expect(yearControls.getByRole('button', { name: 'Trendlinjer' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.recharts-legend-wrapper')).toHaveCount(0);

    await yearControls.getByRole('button', { name: '2024' }).click();
    await expect(yearControls.getByRole('button', { name: '2024' })).toHaveAttribute('aria-pressed', 'false');

    const overallControls = page.getByRole('group', { name: 'Visa serier' });
    await expect(overallControls.getByRole('button', { name: 'Genomsnittlig energianvändning' })).toHaveAttribute('aria-pressed', 'true');
    await overallControls.getByRole('button', { name: 'Trendlinje' }).click();
    await expect(overallControls.getByRole('button', { name: 'Trendlinje' })).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'test-results/energy-temperature-normalized.png', fullPage: true });
  });

  test('staff receives a portal-wide warning when the shared weather sync fails', async ({ page }) => {
    await page.route('**/rest/v1/energy_weather_datasets*', (route) => route.fulfill({
      json: {
        dataset_key: 'stockholm-taby',
        display_name: 'Stockholm / Täby reference temperature',
        source_name: 'SMHI daily mean air temperature, Stockholm-Observatoriekullen A',
        source_url: 'https://opendata-download-metobs.smhi.se/',
        station_id: '98230',
        latitude: 59.3417,
        longitude: 18.0549,
        last_synced_at: '2026-07-26T04:12:00Z',
        last_observation_date: '2026-07-25',
        sync_started_at: null,
        sync_error: 'SMHI returned HTTP 503',
      },
    }));

    await login(page);

    const alert = page.getByTestId('staff-weather-sync-alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Automatisk temperaturhämtning behöver kontrolleras');
    await expect(alert).toContainText('SMHI returned HTTP 503');
    await expect(alert.getByRole('link', { name: 'Kontrollera SMHI-källan' })).toBeVisible();
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
