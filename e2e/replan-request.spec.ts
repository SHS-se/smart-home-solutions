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
import { generateOptimisationPlan } from '../supabase/functions/_shared/planner/energy-optimisation';
import { mixedModeSnapshot } from '../scripts/generate-ha-plan-fixture';
import { readFileSync } from 'node:fs';
const mixedModeFixture = JSON.parse(readFileSync(new URL('../contracts/ha-api/fixtures/schema-9-mixed-mode-plan.json', import.meta.url), 'utf8'));
import { baselineFixture } from '../src/lib/home-baseline/fixture';
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

  test('customer ROI shows separate unavailable scheduler savings without presenting bench cases as home results', async ({ context, page }) => {
    await context.route('**/rest/v1/energy_supplier_daily_costs*', route => route.fulfill({ json: [{ cost_date: '2026-09-24', priced_hours: 24, import_kwh: 20, import_cost_sek: 10 }] }));
    await page.goto('/portal/energy-modeling?tab=roi');
    const contract = page.getByTestId('roi-period-saving');
    await expect(contract).toContainText('SEK');
    const saving = await contract.textContent();
    await page.locator('#roi-subscription').fill('999');
    await expect(contract).toHaveText(saving!);
    await expect(page.getByTestId('roi-scheduler')).toContainText(/have not yet been calculated|ännu inte beräknad/);
    await expect(page.getByTestId('scheduler-comparison')).toHaveCount(0);
  });

  test('ROI generates home historical defaults lazily, navigates72h frames and reuses cached charts', async ({ context, page }, testInfo) => {
    const fixture = baselineFixture();
    await page.clock.setFixedTime(new Date(Date.parse(fixture.end) + 900_000));
    let historicalReads = 0;
    let holdHistory = false, historyReleased = false;
    let releaseHistory: (() => void) | null = null;
    const writes: string[] = [];
    page.on('request', req => {
      if (req.url().includes('/rest/v1/energy_optimisation_') && !['GET', 'HEAD'].includes(req.method())) writes.push(req.url());
    });
    const atEnd = (end: string) => {
      const rows = baselineFixture(), offset = Date.parse(end) - Date.parse(rows.end);
      const shift = (at: string) => new Date(Date.parse(at) + offset).toISOString();
      rows.end = end;
      rows.evInitial!.start_ts = shift(rows.evInitial!.start_ts);
      for (const series of [rows.actual, rows.prices, rows.pool, rows.outdoor, rows.deviceSlots]) series.forEach(row => { row.start_ts = shift(row.start_ts); });
      rows.actual.slice(1).forEach((row, i) => { row.ev_soc = i < 20 ? .79 : i < 40 ? .69 : i < 100 ? .89 : .79; });
      return rows;
    };
    await context.route('**/rest/v1/energy_optimisation_*', async route => {
      const url = new URL(route.request().url()), table = url.pathname.split('/').pop();
      const select = url.searchParams.get('select') ?? '';
      if (table === 'energy_optimisation_current') {
        if (select.includes('captured_at:snapshot')) { await route.fulfill({ json: fixture.snapshot }); return; }
        await route.fallback(); return;
      }
      if (table === 'energy_optimisation_devices') {
        historicalReads++; await route.fulfill({ json: fixture.devices }); return;
      }
      if (!['energy_optimisation_actual_slots', 'energy_optimisation_price_slots', 'energy_optimisation_pool_slots'].includes(table!)) {
        await route.fallback(); return;
      }
      historicalReads++;
      const filters = url.searchParams.getAll('start_ts');
      const until = filters.find(v => v.startsWith('lt.'))?.slice(3);
      const before = filters.find(v => v.startsWith('lte.'))?.slice(4);
      let response: unknown;
      if (table === 'energy_optimisation_actual_slots' && select === 'start_ts') response = { start_ts: fixture.actual.at(-1)!.start_ts };
      else if (select === 'start_ts,ev_soc') response = atEnd(new Date(Date.parse(before!) + 900_000 + 72 * 3_600_000).toISOString()).evInitial;
      else if (table === 'energy_optimisation_pool_slots') response = atEnd(new Date(Date.parse(until!) + 72 * 3_600_000).toISOString()).pool;
      else response = table === 'energy_optimisation_actual_slots' ? atEnd(until!).actual : atEnd(until!).prices;
      expect(url.searchParams.get('customer_id')).toBe(`eq.${CUSTOMER_ID}`);
      expect(url.searchParams.get('home_id')).toBe(`eq.${HOME_ID}`);
      if (holdHistory && table === 'energy_optimisation_actual_slots' && select.includes('total_load_kwh')) {
        await new Promise<void>(resolve => { releaseHistory = resolve; });
      }
      await route.fulfill({ json: response });
      if (holdHistory && releaseHistory) historyReleased = true;
    });
    await context.route('**/rest/v1/rpc/get_energy_optimisation_device_slots*', async route => {
      historicalReads++;
      const request = route.request().postDataJSON();
      expect(request.p_customer_id).toBe(CUSTOMER_ID); expect(request.p_home_id).toBe(HOME_ID);
      expect(Date.parse(request.p_to) - Date.parse(request.p_from)).toBe(72 * 3_600_000);
      await route.fulfill({ json: atEnd(request.p_to).deviceSlots });
    });
    await page.goto('/portal/energy-modeling?tab=roi');
    const viewer = page.getByTestId('roi-baseline');
    await expect(viewer).toBeVisible();
    await expect(page.getByTestId('baseline-generate')).toBeEnabled();
    expect(historicalReads).toBe(0);
    await page.getByTestId('baseline-generate').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    await expect(page.getByTestId('baseline-assumptions')).toContainText(/recorded SOC declines|SOC-minskningar/i);
    await expect(page.getByTestId('baseline-details')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('baseline-assumptions')).not.toBeVisible();
    await expect(viewer.getByRole('group', { name: /Day|Dag/ })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: /Full 72 h|Hela 72 h/ })).toHaveCount(0);
    await expect(page.getByTestId('baseline-previous')).toHaveText(/Previous period|Föregående period/);
    await expect(page.getByTestId('baseline-next')).toHaveText(/Next period|Nästa period/);
    await viewer.locator('summary').click();
    await expect(page.getByTestId('baseline-assumptions')).toBeVisible();
    await expect(page.getByTestId('baseline-models')).toContainText(/80% from midnight|80% från midnatt/);
    await viewer.locator('summary').click();
    const chart = viewer.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await expect(chart).toBeVisible();
    await chart.focus(); await chart.press('ArrowRight'); await chart.press('Enter');
    await expect(page.getByTestId('baseline-quarter')).toContainText(/Driving demand|Körbehov/);
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /Export model|Exportera modell/ }).click();
    const capture = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
    expect(capture.result.series.start).toHaveLength(288);
    expect(capture.engineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.input.evDemandKwh.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(.2 * 75.6);
    expect(capture.result.projectionMs).toBeLessThan(1000);
    await expect(page.getByTestId('baseline-next')).toBeDisabled();
    const reads = historicalReads;
    await page.getByTestId('baseline-previous').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    expect(historicalReads).toBeGreaterThan(reads);
    const olderReads = historicalReads;
    await page.getByTestId('baseline-next').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    expect(historicalReads).toBe(olderReads);
    // Moving away aborts an in-flight older-frame read and restores the cached frame.
    await page.getByTestId('baseline-previous').click();
    const cachedFrame = await page.getByTestId('baseline-frame').textContent();
    holdHistory = true;
    await page.getByTestId('baseline-previous').click();
    await expect.poll(() => releaseHistory !== null).toBe(true);
    await page.getByTestId('baseline-next').click();
    await expect(page.getByTestId('baseline-frame')).toHaveText(cachedFrame!);
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    releaseHistory!();
    await expect.poll(() => historyReleased).toBe(true);
    await expect(page.getByTestId('baseline-frame')).toHaveText(cachedFrame!);
    await expect(page.getByTestId('baseline-generate')).toBeEnabled();
    expect(writes).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await viewer.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await viewer.screenshot({ path: testInfo.outputPath('home-baseline-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await viewer.screenshot({ path: testInfo.outputPath('home-baseline-desktop.png') });
  });

  test('ROI month view auto-loads complete calendar ranges in bounded reads and reuses shared charts', async ({ context, page }, testInfo) => {
    const fixture = baselineFixture(), rpcWindows: { start: string; end: string }[] = [];
    let reads = 0;
    const writes: string[] = [];
    await page.clock.setFixedTime(new Date(Date.parse(fixture.end) + 900_000));
    page.on('request', req => {
      if (req.url().includes('/rest/v1/energy_optimisation_') && !['GET', 'HEAD'].includes(req.method())) writes.push(req.url());
    });
    await context.route('**/rest/v1/energy_optimisation_*', async route => {
      const url = new URL(route.request().url()), table = url.pathname.split('/').pop(), select = url.searchParams.get('select') ?? '';
      if (table === 'energy_optimisation_current') {
        if (select.includes('captured_at:snapshot')) { reads++; await route.fulfill({ json: fixture.snapshot }); }
        else await route.fallback();
        return;
      }
      if (table === 'energy_optimisation_devices') { reads++; await route.fulfill({ json: fixture.devices }); return; }
      if (!['energy_optimisation_actual_slots', 'energy_optimisation_price_slots', 'energy_optimisation_pool_slots'].includes(table!)) { await route.fallback(); return; }
      reads++;
      const filters = url.searchParams.getAll('start_ts');
      const from = filters.find(v => v.startsWith('gte.'))?.slice(4);
      const end = filters.find(v => v.startsWith('lt.'))?.slice(3);
      const before = filters.find(v => v.startsWith('lte.'))?.slice(4);
      const limit = Number(url.searchParams.get('limit'));
      expect(limit).toBeLessThanOrEqual(1000);
      if (select === 'start_ts') { await route.fulfill({ json: { start_ts: fixture.actual.at(-1)!.start_ts } }); return; }
      if (select === 'start_ts,ev_soc') { await route.fulfill({ json: { start_ts: before, ev_soc: .79 } }); return; }
      if (table === 'energy_optimisation_pool_slots') { await route.fulfill({ json: [{ start_ts: from, water_temperature_c: 31 }] }); return; }
      const range = { start: table === 'energy_optimisation_actual_slots' ? new Date(Date.parse(from!) + 900_000).toISOString() : from!, end: end! };
      const rows = baselineFixture(range);
      if (table === 'energy_optimisation_actual_slots') {
        const offline = rows.actual.find(row => row.start_ts === '2026-08-31T22:00:00.000Z');
        if (offline) { offline.total_load_kwh = null; offline.solar_production_kwh = null; }
      }
      await route.fulfill({ json: (table === 'energy_optimisation_actual_slots' ? rows.actual : rows.prices).slice(0, Math.min(limit, 1000)) });
    });
    await context.route('**/rest/v1/rpc/get_energy_optimisation_device_slots*', async route => {
      reads++;
      const request = route.request().postDataJSON();
      const period = { start: request.p_from, end: request.p_to };
      expect(Date.parse(period.end) - Date.parse(period.start)).toBeLessThanOrEqual(7 * 24 * 3_600_000);
      rpcWindows.push(period);
      const rows = baselineFixture(period).deviceSlots;
      rows.filter(row => row.start_ts >= '2026-08-31T22:00:00.000Z' && row.start_ts < '2026-09-30T22:00:00.000Z').forEach(row => {
        delete row.device_energy_kwh['heater-id'];
        row.device_energy_kwh['household-id'] = .25;
      });
      await route.fulfill({ json: rows });
    });
    await page.goto('/portal/energy-modeling?tab=roi');
    const viewer = page.getByTestId('roi-baseline');
    await page.getByTestId('baseline-view-month').click();
    expect(reads).toBe(0);
    await page.getByTestId('baseline-view-frame').click();
    await page.getByTestId('baseline-generate').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    const count = rpcWindows.length;
    await page.getByTestId('baseline-view-month').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    await expect(page.getByTestId('baseline-next')).toBeDisabled();
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /Export model|Exportera modell/ }).click();
    const current = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
    expect(current.input.start).toBe('2026-09-30T22:00:00.000Z');
    expect(current.input.end).toBe(fixture.end);
    expect(current.result.series.start.length).toBe((Date.parse(fixture.end) - Date.parse(current.input.start)) / 900_000);
    const windows = rpcWindows.slice(count).sort((a, b) => a.start.localeCompare(b.start));
    expect(windows[0].start).toBe(current.input.start);
    expect(windows.at(-1)!.end).toBe(current.input.end);
    windows.slice(1).forEach((window, i) => expect(window.start).toBe(windows[i].end));
    await page.getByTestId('baseline-previous').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    await expect(page.getByTestId('baseline-frame')).toContainText(/September|september/);
    const previousDownload = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /Export model|Exportera modell/ }).click();
    const previous = JSON.parse(readFileSync((await (await previousDownload).path())!, 'utf8'));
    expect(previous.input.start).toBe('2026-08-31T22:00:00.000Z');
    expect(previous.input.end).toBe(current.input.start);
    expect(previous.result.series.start).toHaveLength(2880);
    expect(previous.input.energyGaps).toEqual({ householdQuarters: 1, solarQuarters: 1, deviceReadings: 2880 });
    expect(previous.input.problem.slots[0].base_w).toBe(1060);
    await expect(viewer.getByRole('alert')).toHaveCount(0);
    await viewer.locator('summary').click();
    await expect(page.getByTestId('baseline-energy-gaps')).toContainText('2880');
    await viewer.locator('summary').click();
    const historicalReads = reads;
    await page.getByTestId('baseline-next').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    expect(reads).toBe(historicalReads);
    const chart = viewer.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await chart.focus(); await chart.press('End'); await chart.press('Enter');
    await expect(page.getByTestId('baseline-quarter')).toContainText(/Electricity cost|Elkostnad/);
    await page.getByTestId('baseline-view-frame').click();
    await expect(page.getByTestId('baseline-net-cost')).toContainText('SEK');
    await expect(page.getByTestId('baseline-quarter')).toHaveCount(0);
    expect(reads).toBe(historicalReads);
    await page.getByTestId('baseline-view-month').click();
    await expect(chart).toBeVisible();
    await viewer.screenshot({ path: testInfo.outputPath('home-baseline-month.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await viewer.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(writes).toEqual([]);
  });

  test('ROI historical baseline reports missing recorded inputs without generating a plan', async ({ context, page }) => {
    const fixture = baselineFixture();
    await page.clock.setFixedTime(new Date(Date.parse(fixture.end) + 900_000));
    await context.route('**/rest/v1/energy_optimisation_current*', async route => {
      if (new URL(route.request().url()).searchParams.get('select')?.includes('captured_at:snapshot')) await route.fulfill({ json: fixture.snapshot });
      else await route.fallback();
    });
    await context.route('**/rest/v1/energy_optimisation_actual_slots*', async route => {
      const select = new URL(route.request().url()).searchParams.get('select');
      await route.fulfill({ json: select === 'start_ts' ? { start_ts: fixture.actual.at(-1)!.start_ts } : select === 'start_ts,ev_soc' ? fixture.evInitial : fixture.actual });
    });
    await context.route('**/rest/v1/energy_optimisation_devices*', route => route.fulfill({ json: fixture.devices }));
    await context.route('**/rest/v1/energy_optimisation_pool_slots*', route => route.fulfill({ json: fixture.pool }));
    await context.route('**/rest/v1/rpc/get_energy_optimisation_device_slots*', route => route.fulfill({ json: fixture.deviceSlots }));
    await context.route('**/rest/v1/energy_optimisation_price_slots*', route => route.fulfill({ json: fixture.prices.slice(1) }));
    await page.goto('/portal/energy-modeling?tab=roi');
    await page.getByTestId('baseline-generate').click();
    await expect(page.getByTestId('roi-baseline').getByRole('alert')).toContainText('import price');
    await expect(page.getByTestId('baseline-net-cost')).toHaveCount(0);
    await expect(page.getByTestId('baseline-generate')).toBeEnabled();
    await expect(page.getByTestId('baseline-previous')).toBeEnabled();
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

  test('a plan made by rules shows its score under the chart and explains the picked quarter', async ({ page }, testInfo) => {
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

  test('a rejected delivery explains the mismatch without inventing stale live battery readings', async ({ page }) => {
    replan.reportedPlanId = REQUEST_ID;
    replan.acknowledgement = { status: 'rejected', message: 'optimisation plan was not issued recently', version: '0.9.0-beta.86' };
    // Frozen sources cover six hours; the actual plan covers seventy-two.
    await page.clock.setFixedTime(new Date(Date.parse(CAPTURED_AT) + 7 * 60 * 60_000));
    await page.goto('/portal/energy-modeling?tab=plan');
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
    await expect(page.getByText(/Senast rapporterad redo i HA|Last reported ready in HA/, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /batteriets mätvärden|battery readings|avvisade|rejected/ })).toHaveCount(0);
  });

  test('a newer unreadable cloud plan cannot confirm the retained older chart', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.goto('/portal/energy-modeling?tab=plan');
    await expect(page.getByTestId('ha-plan-identity')).toContainText(/Samma plan|Same plan/);
    replan.publishedPlan = { ...PLAN, plan_id: REQUEST_ID };
    replan.reportedPlanId = REQUEST_ID;
    replan.unsupportedPlan = true;
    replan.acknowledgement = { status: 'rejected', message: 'Rejection belongs to the newer unreadable plan', version: 'newer-version' };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('alert')).toContainText(/Webbplatsen kan inte visa det mottagna planformatet|The website cannot display the received plan format/);
    await expect(page.locator(`code[title="${PLAN.plan_id}"]`).first()).toBeVisible();
    await expect(page.getByTestId('ha-plan-identity')).toContainText(/Annan plan|Different plan/);
    await expect(page.getByText(/Senast rapporterad redo i HA|Last reported ready in HA/, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).not.toContainText('Rejection belongs to the newer unreadable plan');
  });

  test('configuration refresh retains the plan, locks saves and recovers automatically', async ({ page }) => {
    replan.reportedPlanId = PLAN.plan_id;
    await page.goto('/portal/energy-modeling?tab=thermal');
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
