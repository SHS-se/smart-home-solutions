/**
 * The planner bench page, fully local — no real backend.
 *
 * Every number here is synthetic: bench test cases come from household replays
 * and stay in the test database, never in the repository. What this covers is
 * the page: runs listed by commit with their score, the current-vs-test totals,
 * both planners drawn for a case with the curves they used and their cost at
 * real prices, a verdict saved against the right commit, a start state saved
 * into its case, and an uploaded replay converted to a test case.
 */
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';
import { planStats } from '../src/lib/planner-bench/stats';
import { storedScore } from '../src/lib/planner-bench/score';
import type { BenchSeries, PlanRecord } from '../src/lib/planner-bench/types';
import type { BenchScenarioData } from '../src/lib/planner-bench/case';
import { LANES } from '../src/lib/planner-bench/lanes';

const STAFF_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CURRENT = { sha: 'c'.repeat(40), short_sha: 'ccccccc', committed_at: '2026-09-27T13:40:00Z', subject: 'Current planner' };
const TEST = { sha: 'd'.repeat(40), short_sha: 'ddddddd', committed_at: '2026-09-29T08:26:00Z', subject: 'Test planner' };
const CASES = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Cheap night', captured_at: '2026-09-19T13:06:00Z' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Dear week', captured_at: '2026-09-24T07:25:00Z' },
];

/** 72 hours of a plausible plan: night-cheap prices and one pool run. */
function series(runStart: number, runQuarters: number): BenchSeries {
  const n = 288, start = Date.parse('2026-09-24T00:00:00Z');
  const s: BenchSeries = {
    start: [], hours: [], published: [], importPrice: [], exportPrice: [], solarW: [], loadW: [], poolW: [],
    hotWaterW: [], carW: [], gridImportW: [], gridExportW: [], batteryChargeW: [], batteryDischargeW: [],
    homeSoc: [], carSoc: [], carConnected: [], poolC: [], costSek: [],
  };
  let temp = 29.5;
  for (let i = 0; i < n; i++) {
    const hour = (i / 4) % 24;
    const price = 1.5 + Math.sin((hour - 6) / 24 * 2 * Math.PI);
    const pool = i >= runStart && i < runStart + runQuarters ? 3500 : 0;
    const solar = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI)) * 4000;
    const load = 900 + pool;
    temp += pool ? 0.04 : -0.012;
    s.start.push(new Date(start + i * 900_000).toISOString());
    s.hours.push(0.25);
    s.published.push(i < 96 ? 1 : 0);
    s.importPrice.push(price);
    s.exportPrice.push(price * 0.5);
    s.solarW.push(solar);
    s.loadW.push(load);
    s.poolW.push(pool);
    s.hotWaterW.push(hour === 5 ? 2000 : 0);
    s.carW.push(0);
    s.gridImportW.push(Math.max(0, load - solar));
    s.gridExportW.push(Math.max(0, solar - load));
    s.batteryChargeW.push(0);
    s.batteryDischargeW.push(0);
    s.homeSoc.push(50);
    s.carSoc.push(null);
    s.carConnected.push(1);
    s.poolC.push(temp);
    s.costSek.push((Math.max(0, load - solar) * price - Math.max(0, solar - load) * price * 0.5) * 0.25 / 1000);
  }
  return s;
}

/** A test case as the page reads it: only what the page shows needs to be real. */
const dataset = (start: string): BenchScenarioData => ({
  format: 'shs-bench-case', version: 1, origin: { kind: 'replay', detail: 'e2e', created_at: start },
  start, timezone: 'Europe/Stockholm', location: { latitude: 59.4, longitude: 18 },
  known_prices: { import_sek_per_kwh: [], export_sek_per_kwh: [] },
  solar_forecast_w: [], base_load_forecast_w: [], other_devices_w: {},
  start_state: { battery_soc: 0.5, pool_water_c: 29.5, ev: { soc: 0.6, target_soc: 0.8 } },
  comfort: null,
});

const record = (reference: number): PlanRecord => ({
  status: 'ready', generation: 'snapshot', valuation: { scale: 1, pool: 'urgency_only', ev: 'urgency_only', battery: 'none' },
  decisions: { pool_w: [], ev_w: [], battery_charge_w: [], battery_discharge_w: [] },
  beliefs: { import_sek_per_kwh: [], grid_cost_sek: 41.5 },
  curves: [
    { store: 'pool', unit: 'celsius', points: [{ at: 28, sek_per_unit: 30 }, { at: 30, sek_per_unit: 15 }, { at: 32, sek_per_unit: 0 }], initial_state: 29.5, max_state: 32, units_per_kwh: 0.07, reference_sek_per_kwh: reference, mode: null },
    { store: 'battery', unit: 'kwh', points: [{ at: 0, sek_per_unit: 2 }, { at: 17, sek_per_unit: 0.4 }], initial_state: 8, max_state: 17, units_per_kwh: 1, reference_sek_per_kwh: null, mode: 'balanced' },
  ],
});

const OUTCOME = { violations: [], cost_sek: 63.2, published_cost_sek: 20, terminal: { battery_kwh: 1, pool_c: -0.2, ev_kwh: 0, credit_sek: -3.4, reference_sek_per_kwh: 1.4 } };

const PLANS: Record<string, BenchSeries> = {
  [`${CURRENT.sha}/${CASES[0].id}`]: series(160, 40),
  [`${TEST.sha}/${CASES[0].id}`]: series(8, 48),
  [`${CURRENT.sha}/${CASES[1].id}`]: series(200, 30),
  [`${TEST.sha}/${CASES[1].id}`]: series(20, 16),
};

function fakeJwt(sub: string, email: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [enc({ alg: 'HS256', typ: 'JWT' }), enc({ sub, email, aud: 'authenticated', role: 'authenticated', exp: now + 3600, iat: now }), 'x'.repeat(43)].join('.');
}

interface Captured { verdicts: unknown[]; inserted: Record<string, unknown>[]; updated: Record<string, unknown>[]; dispatched: unknown[] }

async function mockBackend(context: BrowserContext): Promise<Captured> {
  const captured: Captured = { verdicts: [], inserted: [], updated: [], dispatched: [] };
  const nowIso = new Date().toISOString();
  const user = {
    id: STAFF_ID, email: 'staff@example.com', aud: 'authenticated', role: 'authenticated', email_confirmed_at: nowIso,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: nowIso, updated_at: nowIso,
  };
  await context.route('**/auth/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/token')) {
      await route.fulfill({ json: {
        access_token: fakeJwt(STAFF_ID, user.email), token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh-token', user,
      } });
    } else if (url.pathname.endsWith('/user')) await route.fulfill({ json: user });
    else await route.fulfill({ json: {} });
  });
  await context.route('**/functions/v1/**', async route => {
    captured.dispatched.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, runs_url: 'https://github.com/example/actions' } });
  });
  await context.route('**/rest/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split('/').pop() || '';
    if (request.method() !== 'GET') {
      if (table === 'bench_verdicts') captured.verdicts.push(request.postDataJSON());
      if (table === 'bench_scenarios' && request.method() === 'POST') {
        captured.inserted.push(request.postDataJSON());
        await route.fulfill({ json: { id: '33333333-3333-4333-8333-333333333333' } });
        return;
      }
      if (table === 'bench_scenarios' && request.method() === 'PATCH') captured.updated.push(request.postDataJSON());
      await route.fulfill({ status: 201, body: '' });
      return;
    }
    const rows: unknown[] = (() => {
      switch (table) {
        case 'staff_users': return [{ role: 'admin' }];
        case 'bench_runs': return [
          { ...CURRENT, branch: 'dev', is_current: true, status: 'done', error: null, finished_at: nowIso },
          { ...TEST, branch: null, is_current: false, status: 'done', error: null, finished_at: nowIso },
        ];
        case 'bench_scenarios': return CASES.map(c => ({
          ...c, source_filename: null, criteria: {}, notes: null, archived: false, created_at: nowIso,
          dataset: dataset(c.captured_at), recorded_at: nowIso, pending_reason: null,
        }));
        case 'bench_result_summaries': return Object.entries(PLANS).map(([key, plan]) => {
          const [sha, scenario_id] = key.split('/');
          // Every lane has a result; the oracle lanes are cheaper, as knowing the real prices would be.
          return LANES.map((lane, k) => ({
            sha, scenario_id, lane, status: 'ok', error: null, cpu_ms: 500, stats: planStats(plan), score: storedScore(plan),
            outcome: { ...OUTCOME, cost_sek: OUTCOME.cost_sek - (lane.startsWith('oracle') ? 12 : 0) + (k % 3) },
          }));
        }).flat();
        case 'bench_verdicts': return [];
        case 'bench_results': {
          const scenario = url.searchParams.get('scenario_id')?.replace('eq.', '');
          return [CURRENT.sha, TEST.sha].map(sha => ({
            sha, series: PLANS[`${sha}/${scenario}`], record: record(sha === TEST.sha ? 0.9 : 1.1), outcome: OUTCOME,
          }));
        }
        default: return [];
      }
    })();
    const single = (request.headers().accept || '').includes('vnd.pgrst.object');
    await route.fulfill({ status: single && rows.length === 0 ? 406 : 200, contentType: 'application/json', body: JSON.stringify(single ? rows[0] ?? null : rows) });
  });
  return captured;
}

async function login(page: Page) {
  // Auth is intercepted, so the form only tells the app a session exists.
  await page.goto('/login');
  await page.fill('#email', 'staff@example.com');
  await page.fill('#password', 'mock-password');
  await page.getByRole('button', { name: 'Logga in' }).click();
  await page.waitForURL(url => !url.pathname.endsWith('/login'));
}

test.describe('planner bench', () => {
  test('compares the test planner with the current one and records a verdict', async ({ context, page }) => {
    const captured = await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');

    // Runs are named by commit, time and score; the newest is the default test run.
    await expect(page.locator('#bench-test-run')).toContainText(/ddddddd · .* · \d+ (pts|p)/);
    await expect(page.getByText(/ccccccc · .* · \d+ (pts|p) · (current|nuvarande)/)).toBeVisible();

    // Totals over every case, current against test.
    await expect(page.locator('#bench-total-score')).toContainText(/Test planner is (better|worse)|No score difference|Testplaneraren är (bättre|sämre)|Ingen skillnad i poäng/);
    await expect(page.locator('#bench-total-grid_cost_sek')).toContainText(/-?\d+\.\d.*-?\d+\.\d\s*kr/);

    // Each case has a chip with a pass/fail dot, its name and planning time.
    await expect(page.locator(`#bench-case-${CASES[1].id}`)).toContainText('Dear week');

    // Every quarter of the shown plan carries its score in a strip above the chart.
    await expect(page.getByText(/per quarter, −2 to \+2|per kvart, −2 till \+2/)).toBeVisible();

    // Clicking a quarter explains its score.
    const plan = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    const box = (await plan.boundingBox())!;
    await plan.click({ position: { x: box.width * 0.2, y: box.height * 0.5 } });
    await expect(page.getByText(/No rule fired|Ingen regel slog till|Flexible load|Pool/).first()).toBeVisible();

    // Both planners are drawn for the case; the toggle swaps the full plan chart.
    await expect(page.getByRole('img', { name: /Pool temperature|Pooltemperatur/ })).toBeVisible();
    const chart = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await expect(chart).toBeVisible();
    const drawn = await chart.innerHTML();
    await page.locator('#bench-show-current').click();
    await expect(async () => expect(await chart.innerHTML()).not.toBe(drawn)).toPass({ timeout: 10_000 });

    // Each planner's cost at real prices, beside what it expected, and the curves it planned with.
    await expect(page.locator('#bench-real-cost')).toContainText(/63\.2 kr/);
    await expect(page.locator('#bench-real-cost')).toContainText(/41\.5 kr/);
    await expect(page.locator('#bench-curve-pool').getByRole('img')).toBeVisible();
    await expect(page.locator('#bench-curve-battery')).toContainText('balanced');
    await expect(page.locator('#bench-curve-ev')).toContainText(/reported no curve|rapporterade ingen kurva/);

    // The lanes say why: what knowing the real prices would have saved, and which valuation did best.
    await expect(page.locator('#bench-diagnosis-test')).toContainText(/price estimate cost 12 kr|prisgissningen kostade 12 kr/);
    await page.locator('#bench-lane-oracle-high').click();
    await expect(page.locator('#bench-lane-oracle-high')).toHaveAttribute('aria-pressed', 'true');

    // The start state belongs to the case: an edit is saved into it and the case is run again.
    await page.locator('#bench-start-pool').fill('27');
    await page.getByRole('button', { name: /Save and re-run|Spara och kör om/ }).click();
    await expect.poll(() => captured.updated.length).toBe(1);
    expect((captured.updated[0].dataset as BenchScenarioData).start_state.pool_water_c).toBe(27);
    await expect.poll(() => captured.dispatched.length).toBe(1);

    // A verdict is saved against the commit it was given for.
    await page.locator(`#bench-note-${TEST.sha}`).fill('Heats in the cheap night, as it should');
    await page.getByRole('button', { name: /^(Pass|Godkänd)$/ }).last().click();
    await expect.poll(() => captured.verdicts.length).toBe(1);
    expect(captured.verdicts[0]).toMatchObject({ sha: TEST.sha, verdict: 'pass', note: 'Heats in the cheap night, as it should' });
  });

  test('converts an uploaded replay to a test case and starts a run for it', async ({ context, page }) => {
    const captured = await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator(`#bench-case-${CASES[0].id}`)).toBeVisible();

    const start = Date.parse('2026-09-30T06:00:00Z');
    const replay = {
      format: 'shs-energy-optimisation-quarter-replay',
      schema_version: 2,
      entrypoint: { arguments: { now: '2026-09-30T06:00:05Z', price_archive: [], resolved_price_outlook: { secret: 'another planner\'s estimate' }, snapshot: {
        captured_at: '2026-09-30T06:00:03Z', timezone: 'Europe/Stockholm', location: { latitude: 59.4, longitude: 18 },
        slots: Array.from({ length: 288 }, (_, i) => ({
          start: new Date(start + i * 900_000).toISOString(), pv_forecast_w: 1000, base_load_forecast_w: 500,
          import_price_sek_per_kwh: i < 72 ? 1.2 : null, export_price_sek_per_kwh: i < 72 ? 0.4 : null,
        })),
        pv_calibration: { correction_factor_by_lead_day: [0.8, 0.9, 1, 1] },
        battery: { soc: 0.42 }, pool: { water_temperature_c: 28.4 }, ev_battery: { soc: 0.7, connected: true, departure_target_soc: 0.8 },
        device_models: [
          { key: 'sensor.hot_water_energy', category: 'hot_water', forecast_w_by_slot: new Array(288).fill(200) },
          { key: 'sensor.pool_heater_energy', category: 'pool_heating', planning_service: 'pool', forecast_w_by_slot: new Array(288).fill(900) },
        ],
        value_curves: { pool: { points: [] } }, battery_cost_curve: { key: 'frozen' },
      } } },
      expected: { plans: 'x'.repeat(50_000) },
    };
    await page.locator('#bench-replay-file').setInputFiles({ name: 'plan-replay-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
    await page.locator('#bench-case-name').fill('Cold morning');
    await page.getByRole('button', { name: /Save and run every planner|Spara och kör alla planerare/ }).click();

    await expect.poll(() => captured.inserted.length).toBe(1);
    const row = captured.inserted[0];
    expect(row).toMatchObject({ name: 'Cold morning', source_filename: 'plan-replay-test.json', captured_at: '2026-09-30T06:00:00.000Z' });
    const data = row.dataset as BenchScenarioData;
    // The moment is kept: known prices, corrected solar, devices the household does not plan as base load, readings.
    expect(data.known_prices.import_sek_per_kwh.filter(v => v !== null)).toHaveLength(72);
    expect(data.solar_forecast_w[0]).toBeCloseTo(800);
    expect(data.base_load_forecast_w[0]).toBe(700);
    expect(data.start_state).toEqual({ battery_soc: 0.42, pool_water_c: 28.4, ev: { soc: 0.7, target_soc: 0.8 } });
    // Nothing of another planner's work or the replay's bulk is.
    expect(JSON.stringify(row)).not.toMatch(/secret|frozen|value_curves|xxxxxxxx/);
    await expect.poll(() => captured.dispatched.length).toBe(1);
    expect(captured.dispatched[0]).toMatchObject({ shas: 'all', scenario: '33333333-3333-4333-8333-333333333333' });
  });
});
