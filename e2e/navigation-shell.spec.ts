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
import { portalDelta } from './helpers/portal-delta';

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

const seasonalReferenceSeries = Array.from({ length: 90 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 11, 4 + index));
  const readingDate = date.toISOString().slice(0, 10);
  const temperatureC = Number((4 + (12 * Math.sin(index / 28))).toFixed(1));
  const expectedKwh = 95 - (3.2 * temperatureC) + (0.08 * (temperatureC ** 2));
  return {
    readingDate,
    temperatureC,
    consumptionKwh: Number((expectedKwh + 14).toFixed(1)),
  };
});

const temperatureAnalysisSeries = [
  ...seasonalReferenceSeries,
  ...temperatureImpactSeries,
];
const temperatureAnalysisDates = new Set(
  temperatureAnalysisSeries.map((point) => point.readingDate),
);

const gridImportReadings = [
  ...temperatureChartBaseReadings.filter(([readingDate]) => !temperatureAnalysisDates.has(readingDate)),
  ...temperatureAnalysisSeries.map((point) => [
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

// Whole-home readings begin later than the historical grid-import series. The
// event comparison must therefore fall back to grid import instead of mixing
// the two measurement types across the year-over-year window.
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
    reading_count: 455,
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
  ...temperatureChartBaseObservations.filter(
    ([observedOn]) => !temperatureAnalysisDates.has(observedOn),
  ),
  ...temperatureAnalysisSeries.map((point) => [point.readingDate, point.temperatureC] as const),
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

  test('planning toggles preserve methods across Monitoring and reload without rewriting existing choices', async ({ page, context }) => {
    const methods = [null, 'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'];
    const labels = ['Välj metod', 'På/av-schema', 'Variabel effekt', 'Tillåt/blockera', 'Börvärde'];
    const devices = methods.map((method, index) => ({
      id: `device-${index}`, device_key: `sensor.device_${index}`, statistic_id: `sensor.device_${index}`,
      name: `Device ${index}`, category: 'heating', load_type_override: 'duty_cycle',
      planning_role_override: method ? 'controllable' : 'base_load', control_type_override: method,
      planning_choice_at: null, mapping_status: method ? 'ready' : 'not_configured', mapped_control_type: method,
      mapping_error: null, mapping_summary: {}, active_power_w: 1000, profile_sample_count: 937,
    }));
    const battery = { battery_present: true, battery_included: false, battery_choice_at: null };
    const writes: unknown[] = [];
    let failNextSave = false;
    await context.route('**/rest/v1/rpc/get_energy_portal_delta', route => route.fulfill({
      json: portalDelta(route.request().postDataJSON().p_known, { devices }),
    }));
    await context.route('**/rest/v1/energy_optimisation_home_planning?**', route => route.fulfill({ json: battery }));
    await context.route('**/rest/v1/rpc/get_energy_optimisation_*', route => route.fulfill({ json: [] }));
    await context.route('**/rest/v1/rpc/set_energy_*', async route => {
      const body = route.request().postDataJSON();
      if (failNextSave) {
        failNextSave = false;
        await route.fulfill({ status: 500, json: { message: 'Save failed' } });
        return;
      }
      writes.push(body);
      const device = devices.find(d => d.id === body.p_device_id);
      if (device) {
        device.planning_role_override = body.p_planning_role;
        device.control_type_override = body.p_control_type ?? device.control_type_override;
      } else battery.battery_included = body.p_included;
      await route.fulfill({ json: device ?? battery });
    });
    const toggle = (i: number) => page.getByRole('switch', { name: `Planera Device ${i}`, exact: true });
    const method = (i: number) => page.getByRole('combobox', { name: `Styrmetod för Device ${i}`, exact: true });
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=devices`);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < methods.length; i++) {
        await expect(method(i)).toHaveText(labels[i]);
        await expect(toggle(i)).toBeChecked({ checked: i > 0 });
      }
      await expect(page.getByRole('switch', { name: 'Planera husbatteriet', exact: true })).not.toBeChecked();
      expect(writes).toEqual([]);
      if (pass === 0) await page.reload();
    }
    // Every existing method survives off → reload → on.
    for (let i = 1; i < methods.length; i++) {
      await toggle(i).click();
      await expect(toggle(i)).not.toBeChecked();
      await page.reload();
      await expect(method(i)).toHaveText(labels[i]);
      await expect(toggle(i)).not.toBeChecked();
      await toggle(i).click();
      await expect(toggle(i)).toBeChecked();
      expect(writes.slice(-2)).toEqual([
        { p_device_id: `device-${i}`, p_planning_role: 'base_load', p_control_type: methods[i] },
        { p_device_id: `device-${i}`, p_planning_role: 'controllable', p_control_type: methods[i] },
      ]);
    }
    // Choosing a method does not itself grant inclusion.
    await expect(toggle(0)).toBeDisabled();
    await method(0).click();
    await page.getByRole('option', { name: 'Börvärde', exact: true }).click();
    await expect(toggle(0)).toBeEnabled();
    await expect(toggle(0)).not.toBeChecked();
    expect(writes.at(-1)).toEqual({ p_device_id: 'device-0', p_planning_role: 'base_load', p_control_type: 'setpoint' });
    // Keyboard operation and failed-save state are both truthful.
    failNextSave = true;
    await toggle(0).focus();
    await page.keyboard.press('Space');
    await expect(page.getByText('Save failed').first()).toBeVisible();
    await expect(toggle(0)).not.toBeChecked();
    await page.getByRole('switch', { name: 'Planera husbatteriet', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Planera husbatteriet', exact: true })).toBeChecked();
    expect(writes.at(-1)).toEqual({ p_home_id: PRIMARY_HOME_ID, p_included: true });
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

  test('the home profile fills in the grid limit under the chosen main fuse and lets it be lowered, not raised', async ({ page, context }) => {
    const FUSE_ID = '60000000-0000-4000-8000-000000000001';
    const LIMIT_ID = '60000000-0000-4000-8000-000000000002';
    const question = (id: string, fields: Record<string, unknown>) => ({
      id, is_active: true, display_on_contact_form: false, allow_other: false, order_index: 0, parent_question_id: null, ...fields,
    });
    const saved: Array<Record<string, unknown>> = [];
    const rows = (route: Parameters<Parameters<BrowserContext['route']>[1]>[0], json: unknown[]) =>
      route.fulfill({ json, headers: { 'content-range': json.length ? `0-${json.length - 1}/${json.length}` : '*/0' } });
    await context.route('**/rest/v1/homes*', (route) => rows(route, [{ id: PRIMARY_HOME_ID, name: 'My home' }]));
    await context.route('**/rest/v1/home_questions*', (route) => {
      // The form reads every active question; other readers ask for semantic keys.
      if (new URL(route.request().url()).searchParams.has('semantic_key')) return route.fallback();
      return rows(route, [
        question(FUSE_ID, { question_text: 'Vilken storlek har bostadens huvudsäkring?', question_text_en: 'What is the home’s main fuse size?',
          question_type: 'single_choice', semantic_key: 'main_fuse_a' }),
        question(LIMIT_ID, { question_text: 'Hur mycket effekt får bostaden högst ta från elnätet? (kW)',
          question_text_en: 'What is the most power the home may draw from the grid? (kW)',
          question_type: 'number', semantic_key: 'grid_import_limit_kw', parent_question_id: FUSE_ID }),
      ]);
    });
    await context.route('**/rest/v1/home_question_options*', (route) => rows(route, ['16', '20', '25', '35', '50', '63'].map((value, index) => ({
      id: `opt-${value}`, question_id: FUSE_ID, value, label_sv: `${value} A`, label_en: `${value} A`, order_index: index,
    }))));
    await context.route('**/rest/v1/home_question_display_rules*', (route) => rows(route, [{
      id: 'rule-limit', question_id: LIMIT_ID, depends_on_question_id: FUSE_ID, logic_group: 0,
      operator: 'is_any_of', compare_value: ['16', '20', '25', '35', '50', '63'],
    }]));
    await context.route('**/rest/v1/home_answers*', (route) => {
      if (route.request().method() !== 'POST') return rows(route, []);
      saved.push(...(route.request().postDataJSON() as Array<Record<string, unknown>>));
      return route.fulfill({ status: 201, json: [] });
    });

    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/home-profile`);
    const limit = page.locator(`[data-question-id="${LIMIT_ID}"]`);
    await expect(page.locator(`[data-question-id="${FUSE_ID}"]`)).toBeVisible();
    // Nothing to limit until a fuse is chosen.
    await expect(limit).toHaveCount(0);

    await page.getByLabel('25 A').click();
    await expect(limit.getByRole('spinbutton')).toHaveValue('17.2');
    await expect(limit).toContainText('En säkring på 25 A klarar högst 17,2 kW');

    // More than the fuse carries is brought back to the fuse.
    await limit.getByRole('spinbutton').fill('30');
    await expect(limit.getByRole('spinbutton')).toHaveValue('17.2');
    await limit.getByRole('spinbutton').fill('15');
    await page.screenshot({ path: 'test-results/home-profile-grid-limit.png', fullPage: false });

    // A different fuse starts again from what that fuse carries.
    await page.getByLabel('20 A').click();
    await expect(limit.getByRole('spinbutton')).toHaveValue('13.8');
    await page.getByLabel('25 A').click();
    await limit.getByRole('spinbutton').fill('15');

    await page.getByTestId('home-profile-save-button').click();
    await expect.poll(() => saved.length).toBe(2);
    expect(saved.find((row) => row.question_id === FUSE_ID)?.answer_value).toBe('25');
    expect(saved.find((row) => row.question_id === LIMIT_ID)?.answer_value).toBe(15);
  });

  test('index customer-view route redirects to overview', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}`);
    await page.waitForURL(`**/portal/customers/${CUSTOMER_ID}/overview`);
    await expect(page.getByText('du ser kundens portal som personal')).toBeVisible();
  });

  test('events are recorded in their own section, typed, with a period end date', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history?tab=events`);

    const events = page.getByTestId('energy-events-section');
    await expect(events.getByRole('heading', { name: 'Registrera en händelse' })).toBeVisible();
    await expect(events.getByLabel('Beskrivning')).toBeVisible();

    // A period event asks when it ended; a step event does not, because the
    // database rejects an end date on one.
    await expect(events.getByTestId('energy-event-end-date')).toBeVisible();
    await expect(events.getByLabel('Från')).toBeVisible();

    await events.getByTestId('energy-event-type').click();
    await page.getByRole('option', { name: 'Renovering' }).click();
    await expect(events.getByTestId('energy-event-end-date')).toHaveCount(0);
    await expect(events.getByLabel('Datum')).toBeVisible();

    await expect(events.getByRole('heading', { name: 'Registrerade händelser' })).toBeVisible();

    await page.screenshot({ path: 'test-results/energy-history-events.png', fullPage: true });
  });

  test('bills and data take every file in one upload box', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=data`);
    const upload = page.getByTestId('energy-data-upload');
    await expect(upload.getByRole('heading', { name: 'Ladda upp energidata' })).toBeVisible();
    await expect(upload.locator('input[type="file"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Elnätsfakturor' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Elhandelsfakturor' })).toHaveCount(0);
  });

  test('missing bills are listed in the coverage table, without an alarm', async ({ page }) => {
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
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=data`);
    await expect(page.getByText('Luckor eller delperioder upptäckta')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Månadstäckning' })).toBeVisible();
    // Staff can see when the tariff terms changed, behind a closed panel of their own.
    const checks = page.getByTestId('energy-billing-diagnostics');
    await expect(checks).not.toHaveAttribute('open', '');
    await checks.locator('summary').click();
    await expect(checks.getByRole('heading', { name: 'Förändrade villkor' })).toBeVisible();
    await page.screenshot({ path: 'test-results/energy-gap-hint.png', fullPage: true });
  });

  test('energiprestanda lives on the overview and grades without Home Assistant data', async ({ page }) => {
    const weatherObservationRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/energy_weather_observations')) {
        weatherObservationRequests.push(request.url());
      }
    });
    await login(page);
    // The old section link follows the energy class to the overview.
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history?tab=performance`);
    await page.waitForURL(`**/portal/customers/${CUSTOMER_ID}/overview`);
    await expect(
      page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Energiprestanda', exact: true }),
    ).toHaveCount(0);

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
    expect(weatherObservationRequests).toHaveLength(0);
    await page.screenshot({ path: 'test-results/energy-performance-overview.png', fullPage: true });
  });

  test('savings shows what followed each typed change to the home, and asks for a type when one is missing', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling`);
    const changes = page.getByTestId('home-changes');
    // The recorded window replacement has no type yet, so nothing is measured from it.
    await expect(page.getByTestId('home-changes-empty')).toContainText('En registrerad händelse saknar typ');
    await expect(changes.getByTestId('home-change')).toHaveCount(0);
    await expect(changes.getByRole('link', { name: 'Hantera händelser' })).toHaveAttribute(
      'href',
      `/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=changes`,
    );

    await page.route('**/rest/v1/energy_history_notes*', (route) => route.fulfill({
      json: [{
        id: '40000000-0000-4000-8000-000000000001',
        customer_id: CUSTOMER_ID,
        note_date: '2025-12-03',
        end_date: null,
        event_type: 'renovation',
        event_text: 'Installerade 3-glasfönster och nya ytterdörrar',
      }],
    }));
    await page.reload();
    const change = changes.getByTestId('home-change');
    await expect(change).toHaveCount(1);
    await expect(change).toContainText('Renovering');
    await expect(change).toContainText('3 december 2025');
    await expect(change).toContainText('Installerade 3-glasfönster');
    // A figure only with a year of evidence on both sides; otherwise the reason it is missing.
    await expect(change).toContainText(/kWh per år|Kräver minst 90 dagar|uppvärmningssäsong|Ingen tydlig förändring/);
    await expect(page.getByTestId('home-changes-empty')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/savings-home-changes.png', fullPage: true });
  });

  test('setup gathers devices, thermal, bills and home changes; old links land in the right section', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=data`);
    const sections = page.getByTestId('energy-setup-sections');
    for (const name of ['Enheter', 'Termik', 'Fakturor och data', 'Förändringar i huset']) {
      await expect(sections.getByRole('button', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Besparing', 'Plan', 'Komfort', 'Inställningar']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('tab', { name: 'Enheter' })).toHaveCount(0);
    await expect(page.getByTestId('energy-data-upload')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Månadstäckning' })).toBeVisible();
    await page.screenshot({ path: 'test-results/energy-setup-data.png', fullPage: true });

    await sections.getByRole('button', { name: 'Förändringar i huset' }).click();
    await expect(page).toHaveURL(/tab=setup&section=changes$/);
    await expect(page.getByTestId('energy-events-section')).toBeVisible();

    // Energy history is gone, from the menu and as a page.
    await expect(page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Energihistorik' })).toHaveCount(0);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history?tab=temperature`);
    await expect(page).toHaveURL(new RegExp(`/portal/customers/${CUSTOMER_ID}/energy-modeling$`));

    // Bookmarks to the sections that moved, and to the tabs that became sections.
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history?tab=data`);
    await expect(page).toHaveURL(/\/energy-modeling\?tab=setup&section=data$/);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history?tab=events`);
    await expect(page).toHaveURL(/\/energy-modeling\?tab=setup&section=changes$/);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=thermal`);
    await expect(sections.getByRole('button', { name: 'Termik' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tab', { name: 'Inställningar' })).toHaveAttribute('data-state', 'active');
  });

  test('energy imports expose privacy-safe deletion and parser review', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-history`);
    const staffAlert = page.getByTestId('staff-energy-parse-alert');
    await expect(staffAlert).toContainText('1 energifiler behöver parsergranskning');
    const reviewOldest = staffAlert.getByRole('link', { name: 'Granska äldsta filen' });
    await expect(reviewOldest).toHaveAttribute(
      'href',
      `/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=data`,
    );
    await reviewOldest.click();
    await expect(page.getByTestId('energy-setup-sections').getByRole('button', { name: 'Fakturor och data' }))
      .toHaveAttribute('aria-current', 'page');

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
    await usageImports.locator('summary').click();
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
    // Without a subscription the overview advertises the energy class instead
    // of showing one, and the old shortcut cards are gone.
    const locked = page.getByTestId('energy-class-locked');
    await expect(locked.getByRole('heading', { name: 'Energiklass för ditt hem' })).toBeVisible();
    await expect(locked.getByRole('link', { name: 'Visa prenumeration' })).toHaveAttribute(
      'href',
      '/portal/billing',
    );
    await expect(page.getByTestId('energy-performance')).toHaveCount(0);
    await expect(page.getByText('Besvarade frågor:')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/overview-energy-class-locked.png', fullPage: true });
    for (const label of ['Hemprofil', 'Energioptimering', 'Offerter', 'Fakturor', 'Konto']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    await expect(sidebar.getByText('CRM', { exact: true })).toBeHidden();
    await expect(sidebar.getByText('Bokföring', { exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: 'SKU-katalog' })).toBeHidden();

    await page.screenshot({ path: 'test-results/nav-customer-portal.png', fullPage: false });
  });

  test('customers have no energy history page: its links lead to Energy optimisation', async ({ page }) => {
    await login(page);
    await expect(page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Energihistorik' })).toHaveCount(0);
    await page.goto('/portal/energy-history');
    await expect(page).toHaveURL(/\/portal\/energy-modeling$/);
    await page.goto('/portal/energy-history?tab=temperature');
    await expect(page).toHaveURL(/\/portal\/energy-modeling$/);
    await page.goto('/portal/energy-history?tab=data');
    await expect(page).toHaveURL(/\/portal\/energy-modeling\?tab=setup&section=data$/);
    const sections = page.getByTestId('energy-setup-sections');
    await expect(sections.getByRole('button', { name: 'Fakturor och data' })).toHaveAttribute('aria-current', 'page');
    await expect(sections.getByRole('link', { name: /energihistoriken/ })).toHaveCount(0);
    // Uploading is part of the subscription, as it was on the old page.
    await expect(page.getByText('Aktiv prenumeration krävs')).toBeVisible();
    await expect(page.getByTestId('energy-data-upload')).toHaveCount(0);
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
