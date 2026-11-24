import { TEST_DEVICE_COLOURS } from './helpers/device-colours';
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
const LINKED_HOME_ID = 'cccccccc-dddd-4eee-8fff-222222222222';
const COMFORT_LINK = `/portal/energy-modeling?tab=comfort&home=${LINKED_HOME_ID}&room=studio`;
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

async function mockComfortLink(context: BrowserContext) {
  const homes = [
    { id: PRIMARY_HOME_ID, customer_id: CUSTOMER_ID, name: 'Primary home' },
    { id: LINKED_HOME_ID, customer_id: CUSTOMER_ID, name: 'Linked home' },
  ];
  await context.route('**/rest/v1/homes?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: id ? homes.filter(home => `eq.${home.id}` === id) : homes });
  });
  await context.route('**/rest/v1/energy_optimisation_comfort_schedules?**', route => {
    const home = new URL(route.request().url()).searchParams.get('home_id');
    return route.fulfill({ json: home === `eq.${LINKED_HOME_ID}` ? ['Library', 'Studio'].map(name => ({
      id: name,
      room_key: name.toLowerCase(), room_name: name,
      weekday_modes: Array(96).fill('high-temp'), weekend_modes: Array(96).fill('low-temp'),
      off_temperature_c: 12, low_temperature_c: 18, high_temperature_c: 21,
      source: 'portal', updated_at: '2026-01-01T00:00:00Z',
    })) : [] });
  });
}

test.describe('staff navigation shell', () => {
  test.beforeEach(async ({ context }) => {
    await mockSupabase(context, 'staff');
  });

  test('opens the app-linked room in the linked home under the staff customer view', async ({ page, context }) => {
    await mockComfortLink(context);
    await login(page);
    await page.goto(COMFORT_LINK);
    const customerUrl = `/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=comfort&home=${LINKED_HOME_ID}&room=studio`;
    await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === customerUrl);
    await expect(page.getByRole('combobox').filter({ hasText: 'Linked home' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Valt rum' }).getByRole('heading', { name: 'Studio' })).toBeVisible();

    await page.goto(COMFORT_LINK.replace('room=studio', 'room=missing'));
    await expect(page.getByText('Rummet i länken har inget komfortschema här.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Valt rum' }).getByRole('heading')).toHaveCount(0);
  });

  for (const kind of ['device'] as const) {
    test(`${kind} heating Model labels use fixed five-degree bands with separate observed coverage`, async ({ page, context }) => {
      // Independently generated model metadata; no household measurements.
      await mockComfortLink(context);
      const bands = [-15, -10].map((band_c, i) => ({ band_c,
        revision: `60000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        observed_min_c: band_c + 1.2, observed_max_c: band_c + 2.4,
        training_from: '2026-01-01T00:00:00Z', training_to: '2026-01-05T00:00:00Z',
      }));
      const physics = { gain_c_per_wh: .002, cooling_constant_per_h: .03, background_gain_c_per_h: 0,
        thermal_capacity_wh_per_c: 500, heat_loss_w_per_c: 15, time_constant_h: 1 / .03,
        r2: .9, sample_count: 50, residual_std_c: .1, heat_lag_h: 0 };
      await context.route('**/rest/v1/rpc/get_energy_room_model_scenario', route => route.fulfill({ json: {
        room: { trained: false, rejection_reason: null, temperature_bands: bands.map(b => ({ ...b, model: physics })) }, connections: [],
      } }));
      const devices = [{ id: 'synthetic-heater', device_key: 'synthetic-heater', statistic_id: 'synthetic-heater',
        name: 'Synthetic heater', colour: TEST_DEVICE_COLOURS[0], retired_at: null, category: 'heating',
        load_type_override: 'duty_cycle', planning_role_override: 'controllable', control_type_override: 'setpoint',
        planning_choice_at: null, mapping_status: 'ready', mapped_control_type: 'setpoint', mapping_error: null,
        mapping_summary: { room_key: 'studio', room_name: 'Studio' }, active_power_w: 500, profile_sample_count: 50 }];
      await context.route('**/rest/v1/rpc/get_energy_portal_delta', route => route.fulfill({
        json: portalDelta(route.request().postDataJSON().p_known, { devices }),
      }));
      await context.route('**/rest/v1/energy_optimisation_device_operating_points?**', route => route.fulfill({ json: {
        points: bands.map(b => ({ ...b, min_c: b.observed_min_c, max_c: b.observed_max_c,
          outdoor_c: b.band_c + 2, watts: 500, spread_w: 20, days: 3, hours: 6 })),
      } }));
      await login(page);
      if (kind === 'room') {
        await page.goto(COMFORT_LINK);
        await page.getByRole('region', { name: 'Valt rum' }).getByRole('button', { name: 'Modell', exact: true }).click();
      } else {
        await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=devices&home=${LINKED_HOME_ID}`);
        await page.getByRole('navigation', { name: 'Enheter', exact: true }).getByRole('button', { name: /^Synthetic heater/ }).click();
        await page.getByRole('region', { name: 'Synthetic heater', exact: true }).getByRole('tab', { name: 'Modell' }).click();
      }
      const select = page.getByLabel('Utomhustemperaturintervall', { exact: true });
      const normalize = (s: string) => s.replaceAll('−', '-');
      await expect(select).toBeVisible();
      expect((await select.locator('option').allTextContents()).map(normalize)).toEqual(['-15 – -10 °C', '-10 – -5 °C']);
      await select.selectOption(bands[1].revision);
      await expect(page.getByText('Observerat intervall', { exact: kind === 'room' })).toBeVisible();
      const panel = page.getByRole('region', { name: kind === 'room' ? 'Valt rum' : 'Synthetic heater', exact: true });
      expect(normalize(await panel.innerText())).toContain('-8,8 – -7,6 °C');
    });
  }

  test('room Model draws the one shared response through every heating run and explains each run', async ({ page, context }, testInfo) => {
    // Independently generated runs and response; no household measurements.
    await mockComfortLink(context);
    const noise = (i: number) => { const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v) - .5; };
    const dispositions = ['assessed', 'assessed', 'assessed', 'uninformative', 'assessed', 'suspect_change'] as const;
    const runs = Array.from({ length: 58 }, (_, i) => {
      const outdoor = -16 + (i % 24) * 1.3 + noise(i), start = Date.UTC(2026, 3, 30 - i, 1);
      const disposition = dispositions[i % dispositions.length];
      const se = disposition === 'uninformative' ? .0012 : .0003;
      return { id: String(start), from_ms: start, to_ms: start + 7 * 3_600_000, measured_wh: 1600 + 40 * i, transitions: 7,
        gain: (2 + noise(i + 40) * .6) / 1000, gain_se: se, change_at_ms: disposition === 'suspect_change' ? start + 3 * 3_600_000 : null,
        change_size: disposition === 'suspect_change' ? .4 : null, change_phase: disposition === 'suspect_change' ? 'heating' : null,
        disposition, on_from_ms: start + 3_600_000, off_from_ms: start + 3 * 3_600_000, outdoor_c: outdoor, house_c: 20.2,
        room_start_c: 19.4, room_peak_c: 21.1, room_end_c: 19.8, cooldown: i % 7 === 6 ? null
          : { hours: 2.5, c_per_h: .045 * (20 - outdoor), room_c: 20.4, outdoor_c: outdoor, house_c: 20.2, residual_c_per_h: noise(i + 80) * .08 } };
    });
    const model = { response_family: 'finite', gain_c_per_wh: .002, cooling_constant_per_h: .045, house_coupling_per_h: .02,
      background_gain_c_per_h: 0, thermal_capacity_wh_per_c: 500, heat_loss_w_per_c: 32.5, time_constant_h: 15.4,
      heating_rate_c_per_h: 1, r2: .9, sample_count: 700, residual_std_c: .05, heat_lag_h: .5 };
    let shared = true, assessed = runs;
    await context.route('**/rest/v1/rpc/get_energy_room_response_evidence', route => {
      expect(route.request().postDataJSON()).toEqual({ p_home_id: LINKED_HOME_ID, p_room_key: 'studio' });
      return route.fulfill({ json: shared ? {
        room: { trained: true, rejection_reason: null, last_fit_attempt: null, shared_attempt: { status: 'fitted', attempted_at: '2026-03-01T00:00:00Z' } },
        response: { revision: 'shared-revision', model, training_from: '2026-01-03T00:00:00Z', training_to: '2026-04-30T00:00:00Z',
          warnings: [], transition_calibration: { policy: 'shared_interval_transitions_v1', fitted_transitions: 700 } },
        ledgers: [{ scope_key: 'shared', created_at: '2026-03-01T00:00:00Z', evidence: { assessed_against: 'shared-revision',
          policy: 'shared_interval_transitions_v1', observed_runs: assessed.length, runs: assessed.slice(0, 50) } }],
      } : {
        room: { trained: true, rejection_reason: null, last_fit_attempt: null, shared_attempt: null }, response: null,
        ledgers: [{ scope_key: '-15', created_at: '2026-03-01T00:00:00Z', evidence: { runs: runs.slice(0, 12).map(run => ({ ...run, disposition: 'fitted' })) } }],
      } });
    });
    await context.route('**/rest/v1/rpc/get_energy_room_run_assessments', route => {
      expect(route.request().postDataJSON()).toEqual({ p_home_id: LINKED_HOME_ID, p_room_key: 'studio',
        p_revision: 'shared-revision', p_offset: 50, p_limit: 50 });
      return route.fulfill({ json: runs.slice(50) });
    });
    await login(page);
    await page.goto(COMFORT_LINK);
    const panel = page.getByRole('region', { name: 'Valt rum' });
    await panel.getByRole('button', { name: 'Modell', exact: true }).click();
    const heating = panel.getByRole('img', { name: 'Värmerespons per förlopp' });
    const cooling = panel.getByRole('img', { name: 'Avsvalning per förlopp' });
    await expect(heating.locator('[data-run]')).toHaveCount(58);
    await expect(cooling.locator('[data-run]')).toHaveCount(runs.filter(run => run.cooldown).length);
    await expect(panel.getByTestId('fitted-transitions')).toHaveText('700');
    await expect(panel.getByTestId('assessed-heating-runs')).toHaveText('58');
    await expect(panel.getByRole('button', { name: 'Äldre förlopp' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Nyare förlopp' })).toHaveCount(0);
    await expect(panel.getByText('Planeraren använder den här enda responsen vid varje prognostiserad utetemperatur.')).toBeVisible();
    await expect(panel.getByText(/Modell: 2 °C\/kWh/)).toBeVisible();
    await expect(panel.getByText(/Svalnar inte utan värme över/)).toBeVisible();
    await expect(panel.getByText('Effekt som håller rummets temperatur (uppskattning)')).toBeVisible();
    // The band selector, band summary and warm-up scenario are gone.
    await expect(panel.getByLabel('Utomhustemperaturintervall', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('Uppskattad uppvärmning och avsvalning')).toHaveCount(0);
    // The model line: solid over the measured runs, dashed beyond them.
    await expect(heating.locator('.recharts-line-curve')).toHaveCount(2);
    // All runs share one plot, so individual markers can overlap. Each remains
    // keyboard-accessible even when a later marker covers its pointer target.
    await heating.locator(`[data-run="${runs[5].id}"]`).press('Enter');
    const detail = panel.getByTestId('room-run-detail');
    await expect(detail).toContainText('2026');
    await expect(detail).toContainText('Orsaken är inte fastställd.');
    await expect(detail).toContainText('Rummets gemensamma modell');
    await expect(cooling.locator(`[data-run="${runs[5].id}"][aria-pressed="true"]`)).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('room-run-charts.png'), fullPage: true });
    await detail.getByRole('button', { name: 'Stäng' }).click();
    await expect(detail).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await heating.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // Eligible transitions can identify a model even without a complete on/off run.
    assessed = [];
    await page.reload();
    await panel.getByRole('button', { name: 'Modell', exact: true }).click();
    await expect(panel.getByTestId('assessed-heating-runs')).toHaveText('0');
    for (const chart of [heating, cooling]) {
      await expect(chart.locator('[data-run]')).toHaveCount(0);
      await expect(chart.locator('.recharts-line-curve[stroke-dasharray="5 4"]')).toHaveAttribute('d', /^M.*L/);
    }
    // A room still on its earlier band responses shows its points without a line.
    shared = false;
    await page.reload();
    await panel.getByRole('button', { name: 'Modell', exact: true }).click();
    await expect(panel.getByText(/gemensamma modell lärs fortfarande in/)).toBeVisible();
    await expect(heating.locator('[data-run]')).toHaveCount(12);
    await expect(heating.locator('.recharts-line-curve')).toHaveCount(0);
  });

  test('room Model flags heating and cooling points separately, without reference or date paging controls', async ({ page, context }, testInfo) => {
    // Independently generated measurements and published lines, never household data.
    await mockComfortLink(context);
    const revision = 'synthetic-measured-revision';
    const runs = Array.from({ length: 305 }, (_, i) => {
      const start = Date.UTC(2026, 5, 30 - i), outdoor = -10 + i % 20;
      return { id: `synthetic-${i}`, from_ms: start, on_ms: start + 900_000, off_ms: start + 4_500_000,
        to_ms: start + 7_200_000, energy_kwh: 1,
        heating: i === 1 ? null : { on_ms: start + 900_000, peak_ms: start + 4_500_000, peak_end_ms: start + 5_400_000,
          energy_kwh: 1, hours: 1.25, rise_c: .8 + outdoor * .02, c_per_kwh: .8 + outdoor * .02 + (i === 0 ? .5 : 0),
          room_start_c: 19, room_peak_c: 19.8 + outdoor * .02, room_mean_c: 19.4,
          outdoor_c: outdoor, house_c: 19, native_seconds: [900] },
        cooling: i === 1 ? null : { from_ms: start + 5_400_000, to_ms: start + 7_200_000, hours: .5,
          c_per_h: .4 - outdoor * .02 - (i === 2 ? .5 : 0), room_c: 19.7, outdoor_c: outdoor, house_c: 19, energy_kwh: 0 },
        reference_heating_c_per_kwh: i === 1 ? null : 1.1 + outdoor * .02,
        reference_cooling_c_per_h: i === 1 ? null : .5 - outdoor * .02,
        heating_residual: i === 1 ? null : i === 0 ? .5 : 0, cooling_residual: i === 1 ? null : i === 2 ? -.5 : 0,
        heating_status: i === 1 ? null : i === 0 ? 'above_line' : 'consistent',
        cooling_status: i === 1 ? null : i === 2 ? 'below_line' : 'consistent',
        reasons: i === 1 ? ['heating_window_incomplete', 'cooling_window_incomplete'] : [],
      };
    });
    const line = (heating: boolean, reference: boolean) => ({ reference_outdoor_c: 0,
      intercept: heating ? reference ? 1.1 : .8 : reference ? .5 : .4, slope_per_c: heating ? .02 : -.02,
      robust_scale: .02, points: 304, effective_points: 303, constraint: heating ? 'rises' : 'falls', units: heating ? 'c_per_kwh' : 'c_per_h' });
    await context.route('**/rest/v1/rpc/get_energy_room_response_evidence', route => route.fulfill({ json: {
      room: { trained: true, rejection_reason: null, last_fit_attempt: null },
      response: { revision, model: { response_family: 'finite', gain_c_per_wh: .002, cooling_constant_per_h: .04,
        house_coupling_per_h: .02, background_gain_c_per_h: 0, thermal_capacity_wh_per_c: 500, heat_loss_w_per_c: 30,
        time_constant_h: 16.7, heating_rate_c_per_h: 1, r2: .9, sample_count: 800, residual_std_c: .05 },
        measured_runs: { policy: 'measured_room_runs_v1', measurement_method: 'native_mean_onset_peak_v1', fitted_observations: 800,
          residual_degrees_of_freedom: 796, observed_runs: 305, heating_runs: 304, cooling_runs: 304, heating_flagged_runs: 1, cooling_flagged_runs: 1, unmeasured_runs: 1,
          reference: { room_c: 20, house_c: 20 }, lines: { heating: line(true, false), cooling: line(false, false),
            reference_heating: line(true, true), reference_cooling: line(false, true) },
          validation: { training_to: '2026-07-01T00:00:00Z', observations: 20, trajectory_mae_c: .12, trajectory_bias_c: -.01, projected_trajectory_mae_c: .2, projected_trajectory_bias_c: -.08 } } },
      ledgers: [{ scope_key: 'shared', created_at: '2026-07-01T00:00:00Z', evidence: {
        policy: 'measured_room_runs_v1', assessed_against: revision, observed_runs: 305, runs: runs.slice(0, 100) } }],
    } }));
    const requestedOffsets: number[] = [];
    await context.route('**/rest/v1/rpc/get_energy_room_run_assessments', route => {
      const request = route.request().postDataJSON();
      expect(request).toEqual({ p_home_id: LINKED_HOME_ID, p_room_key: 'studio', p_revision: revision, p_offset: expect.any(Number), p_limit: 100 });
      requestedOffsets.push(request.p_offset);
      return route.fulfill({ json: runs.slice(request.p_offset, request.p_offset + 100) });
    });
    await login(page);
    await page.goto(COMFORT_LINK);
    const panel = page.getByRole('region', { name: 'Valt rum' });
    await panel.getByRole('button', { name: 'Modell', exact: true }).click();
    const heating = panel.getByRole('img', { name: 'Nettoökning per förlopp', exact: true });
    const cooling = panel.getByRole('img', { name: 'Avsvalning per förlopp', exact: true });
    await expect(heating.locator('[data-run]')).toHaveCount(304);
    await expect(cooling.locator('[data-run]')).toHaveCount(304);
    expect(requestedOffsets).toEqual([100, 200, 300]);
    await expect(panel.getByTestId('measured-run-counts')).toHaveText('305 visade förlopp');
    await expect(panel.getByTestId('measured-run-counts-heating')).toHaveText('303 nära linjen · 1 flaggade · 1 utan uppvärmningspunkt');
    await expect(panel.getByTestId('measured-run-counts-cooling')).toHaveText('303 nära linjen · 1 flaggade · 1 utan avsvalningspunkt');
    // A run flagged in one chart is an ordinary point in the other.
    await expect(heating.locator('[data-run="synthetic-0"] rect')).toHaveCount(1);
    await expect(cooling.locator('[data-run="synthetic-0"] rect')).toHaveCount(0);
    await expect(cooling.locator('[data-run="synthetic-2"] rect')).toHaveCount(1);
    await expect(heating.locator('[data-run="synthetic-2"] rect')).toHaveCount(0);
    await expect(heating.locator('[data-run] rect')).toHaveCount(1);
    await expect(cooling.locator('[data-run] rect')).toHaveCount(1);
    await expect(panel.getByRole('group', { name: 'Förloppens temperaturvillkor' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Nyare förlopp|Äldre förlopp|Vid referenstemperatur|Uppmätt/ })).toHaveCount(0);
    await expect(panel.getByTestId('room-prediction-error')).toContainText('Medelabsolut prognosfel för temperatur');
    await expect(panel.getByTestId('room-prediction-error').locator('dd')).toHaveText(['0,12 °C', '0,2 °C']);
    await expect(panel.getByTestId('room-prediction-error')).toContainText('Planerarens prognos');
    await expect(panel.getByText(/Publicerad linje: 0,8 °C\/kWh/)).toContainText('304 förlopp i anpassningen');
    // Details open beside the clicked point, for that chart's measure only.
    await expect(panel.getByLabel('Visa detaljer för ett förlopp')).toHaveCount(0);
    await expect(panel.getByTestId('room-run-detail')).toHaveCount(0);
    const detail = page.getByTestId('room-point-detail');
    await heating.locator('[data-run="synthetic-0"]').click();
    await expect(detail).toHaveCount(1);
    await expect(detail).toContainText('Uppvärmning');
    await expect(detail).toContainText('Flaggad: över linjen');
    await expect(detail).toContainText('Start → topp (intervallmedel)');
    await expect(detail).not.toContainText('Avsvalning');
    await expect(detail).not.toContainText('annan källa');
    await expect(cooling.locator('[data-run="synthetic-0"] circle[r="9"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await cooling.locator('[data-run="synthetic-2"]').click();
    await expect(detail).toContainText('Avsvalning');
    await expect(detail).toContainText('Flaggad: under linjen');
    await expect(detail).not.toContainText('nettoökning');
    await expect(heating.locator('[data-run="synthetic-2"] circle[r="9"]')).toHaveCount(0);
    // Choosing a point in the other chart replaces the open details.
    await heating.locator('[data-run="synthetic-304"]').click();
    await expect(detail).toHaveCount(1);
    await expect(detail).toContainText('2025');
    await expect(detail).toContainText('Nära linjen');
    await expect(heating.locator('[data-run="synthetic-304"]')).toHaveAttribute('aria-label', /0,68 °C\/kWh/);
    await expect(heating.locator('[data-run]')).toHaveCount(304);
    await expect(panel.getByText(/Publicerad linje: 1,1 °C\/kWh/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('measured-room-runs-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await heating.locator('[data-run="synthetic-304"]').scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const box = await detail.boundingBox();
      return !!box && box.x >= 0 && box.x + box.width <= 390;
    }, { message: 'point details stay on a narrow screen' }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('measured-room-runs-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('planning toggles preserve methods across Monitoring and reload without rewriting existing choices', async ({ page, context }) => {
    const methods = [null, 'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'];
    const devices = methods.map((method, index) => ({
      id: `device-${index}`, device_key: `sensor.device_${index}`, statistic_id: `sensor.device_${index}`,
      name: `Device ${index}`, colour: TEST_DEVICE_COLOURS[index], retired_at: null, category: 'heating', load_type_override: 'duty_cycle',
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
    await context.route('**/rest/v1/energy_optimisation_devices?**', route => route.fulfill({ json: { model: null } }));
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
      } else battery.battery_included = body.p_included;
      await route.fulfill({ json: device ?? battery });
    });
    const toggle = (i: number) => page.getByRole('switch', { name: `Planera Device ${i}`, exact: true });
    const devicePanel = (i: number) => page.getByRole('region', { name: `Device ${i}`, exact: true });
    const selectDevice = (i: number) => page.getByRole('navigation', { name: 'Enheter', exact: true })
      .getByRole('button', { name: new RegExp(`^Device ${i}(?: |$)`) }).click();
    const selectBattery = () => page.getByRole('navigation', { name: 'Enheter', exact: true })
      .getByRole('button', { name: 'Husbatteri', exact: true }).click();
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=devices`);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < methods.length; i++) {
        await selectDevice(i);
        await expect(devicePanel(i).getByText('Termostat / driftcykel', { exact: true })).toHaveCount(0);
        await expect(devicePanel(i).getByRole('combobox')).toHaveCount(0);
        await expect(toggle(i)).toBeChecked({ checked: i > 0 });
      }
      await selectBattery();
      await expect(page.getByRole('switch', { name: 'Planera husbatteriet', exact: true })).not.toBeChecked();
      expect(writes).toEqual([]);
      if (pass === 0) await page.reload();
    }
    // Every existing method survives off → reload → on.
    for (let i = 1; i < methods.length; i++) {
      await selectDevice(i);
      await toggle(i).click();
      await expect(toggle(i)).not.toBeChecked();
      await page.reload();
      await expect(toggle(i)).not.toBeChecked();
      await expect(toggle(i)).toBeEnabled();
      await toggle(i).click();
      await expect(toggle(i)).toBeChecked();
      expect(writes.slice(-2)).toEqual([
        { p_device_id: `device-${i}`, p_planning_role: 'base_load' },
        { p_device_id: `device-${i}`, p_planning_role: 'controllable' },
      ]);
    }
    // The website waits for the app to provide a method.
    await selectDevice(0);
    await expect(toggle(0)).toBeDisabled();
    devices[0].control_type_override = 'setpoint';
    devices[1].mapping_status = 'invalid';
    devices[1].mapping_summary = { setup_fields: ['temperature_entity_id'] };
    await page.reload();
    await selectDevice(1);
    await expect(devicePanel(1).getByRole('heading', { name: 'Utanför planen' })).toBeVisible();
    await expect(devicePanel(1).getByText(/Kontrollera Rumstemperatur/)).toBeVisible();
    await devicePanel(1).getByRole('tab', { name: 'Modell' }).click();
    await expect(devicePanel(1).getByText('—', { exact: true })).toBeVisible();
    await expect(devicePanel(1).getByText('Samlar in mätningar av effekt vid uppvärmning.', { exact: true })).toBeVisible();
    await selectDevice(0);
    await expect(toggle(0)).toBeEnabled();
    await expect(toggle(0)).not.toBeChecked();
    // Keyboard operation and failed-save state are both truthful.
    failNextSave = true;
    await toggle(0).focus();
    await page.keyboard.press('Space');
    await expect(page.getByText('Save failed').first()).toBeVisible();
    await expect(toggle(0)).not.toBeChecked();
    await selectBattery();
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

  test('staff can open the paired home, see probe data and add and remove a doorway', async ({ page, context }) => {
    const rooms = [{ key: 'hall', name: 'Example hall', has_probe: true,
      latest: { start: '2026-11-17T08:00:00Z', temperature_c: 19.5 } },
    { key: 'office', name: 'Example office', has_probe: false, latest: null }];
    const writes: unknown[] = [];
    let connections: unknown[] = [];
    await context.route('**/rest/v1/homes*', route => route.fulfill({
      json: [{ id: PRIMARY_HOME_ID, name: 'Example home', customer_id: CUSTOMER_ID }],
    }));
    await context.route('**/rest/v1/rpc/get_energy_room_profile', route => route.fulfill({
      json: { revision: writes.length, rooms, connections },
    }));
    await context.route('**/rest/v1/rpc/set_energy_room_connections', route => {
      const request = route.request().postDataJSON();
      writes.push(request);
      connections = request.p_connections;
      return route.fulfill({ json: 1 });
    });
    await login(page);
    await page.goto(`/portal/home-profile?home=${PRIMARY_HOME_ID}&section=room-connections&room=hall`);
    const editor = page.locator('#room-connections');
    await expect(editor.getByText(/19,5 °C/)).toBeVisible();
    await editor.getByLabel('Anslutet rum').selectOption('office');
    await editor.getByRole('button', { name: 'Lägg till dörröppning' }).click();
    expect(writes).toEqual([]);
    await editor.getByRole('button', { name: 'Spara', exact: true }).click();
    await expect(editor.getByText('Rumsanslutningar sparade.')).toBeVisible();
    expect(writes).toEqual([{ p_home_id: PRIMARY_HOME_ID, p_expected_revision: 0,
      p_connections: [{ rooms: ['hall', 'office'], mode: 'usually_open' }] }]);
    await page.reload();
    await editor.getByLabel('Rum', { exact: true }).selectOption('office');
    await expect(editor.getByRole('listitem').getByText('Example hall', { exact: true })).toBeVisible();
    await expect(editor.getByRole('listitem').getByRole('combobox')).toHaveCount(0);
    await editor.getByRole('button', { name: 'Ta bort', exact: true }).click();
    await editor.getByRole('button', { name: 'Spara', exact: true }).click();
    await expect(editor.getByText('Rumsanslutningar sparade.')).toBeVisible();
    await page.reload();
    await expect(editor.getByRole('listitem')).toHaveCount(0);
    await editor.getByLabel('Rum', { exact: true }).selectOption('office');
    await expect(editor.getByRole('listitem')).toHaveCount(0);
    expect(writes.slice(1)).toEqual([
      { p_home_id: PRIMARY_HOME_ID, p_expected_revision: 1, p_connections: [] },
    ]);
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

  test('devices has its own view and old setup links still land in the right section', async ({ page }) => {
    await login(page);
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=data`);
    const sections = page.getByTestId('energy-setup-sections');
    for (const name of ['Termik', 'Fakturor och data', 'Förändringar i huset']) {
      await expect(sections.getByRole('button', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Besparing', 'Plan', 'Enheter', 'Komfort', 'Inställningar']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
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
    await page.goto(`/portal/customers/${CUSTOMER_ID}/energy-modeling?tab=setup&section=devices`);
    await expect(page.getByRole('tab', { name: 'Enheter' })).toHaveAttribute('data-state', 'active');
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

  test('opens an owned home link and shows when a home is unavailable', async ({ page, context }) => {
    await mockComfortLink(context);
    await login(page);
    await page.goto(COMFORT_LINK);
    await expect(page.getByRole('region', { name: 'Valt rum' }).getByRole('heading', { name: 'Studio' })).toBeVisible();

    await page.goto(COMFORT_LINK.replace(LINKED_HOME_ID, 'cccccccc-dddd-4eee-8fff-333333333333'));
    await expect(page.getByText('Det länkade hemmet är inte tillgängligt för ditt konto.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Valt rum' })).toHaveCount(0);
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
