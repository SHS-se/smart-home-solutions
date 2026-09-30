/**
 * The planner bench page, fully local — no real backend.
 *
 * Every number here is synthetic: bench test cases are household replays and
 * stay in the test database, never in the repository. What this covers is the
 * page: runs listed by commit with their score, the current-vs-test totals,
 * both planners drawn for a case, a verdict saved against the right commit,
 * and an uploaded replay stripped to the planner's input before it is stored.
 */
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';
import { planStats } from '../src/lib/planner-bench/stats';
import { storedScore } from '../src/lib/planner-bench/score';
import type { BenchSeries } from '../src/lib/planner-bench/types';

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

interface Captured { verdicts: unknown[]; inserted: Record<string, unknown>[]; dispatched: unknown[] }

async function mockBackend(context: BrowserContext): Promise<Captured> {
  const captured: Captured = { verdicts: [], inserted: [], dispatched: [] };
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
        case 'bench_scenarios': return CASES.map(c => ({ ...c, source_filename: null, criteria: {}, notes: null, archived: false, created_at: nowIso }));
        case 'bench_result_summaries': return Object.entries(PLANS).map(([key, plan]) => {
          const [sha, scenario_id] = key.split('/');
          return { sha, scenario_id, status: 'ok', error: null, cpu_ms: 500, stats: planStats(plan), score: storedScore(plan) };
        });
        case 'bench_verdicts': return [];
        case 'bench_results': {
          const scenario = url.searchParams.get('scenario_id')?.replace('eq.', '');
          return [CURRENT.sha, TEST.sha].map(sha => ({ sha, series: PLANS[`${sha}/${scenario}`] }));
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
    const totals = page.locator('tr', { hasText: /Total grid cost|Total nätkostnad/ });
    await expect(totals).toContainText(/kr.*kr/);

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

    // A verdict is saved against the commit it was given for.
    await page.locator(`#bench-note-${TEST.sha}`).fill('Heats in the cheap night, as it should');
    await page.getByRole('button', { name: /^(Pass|Godkänd)$/ }).last().click();
    await expect.poll(() => captured.verdicts.length).toBe(1);
    expect(captured.verdicts[0]).toMatchObject({ sha: TEST.sha, verdict: 'pass', note: 'Heats in the cheap night, as it should' });
  });

  test('stores only the planner input of an uploaded replay and starts a run for it', async ({ context, page }) => {
    const captured = await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator(`#bench-case-${CASES[0].id}`)).toBeVisible();

    const replay = {
      format: 'shs-energy-optimisation-quarter-replay',
      schema_version: 2,
      input_hash: 'hash-1',
      entrypoint: { arguments: { snapshot: { captured_at: '2026-09-30T06:00:00Z', slots: [] }, now: '2026-09-30T06:00:05Z', price_archive: [] } },
      expected: { plans: 'x'.repeat(50_000) },
      history: [{ big: 'y'.repeat(50_000) }],
    };
    await page.locator('#bench-replay-file').setInputFiles({ name: 'plan-replay-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
    await page.locator('#bench-case-name').fill('Cold morning');
    await page.getByRole('button', { name: /Save and run every planner|Spara och kör alla planerare/ }).click();

    await expect.poll(() => captured.inserted.length).toBe(1);
    const row = captured.inserted[0];
    expect(row).toMatchObject({ name: 'Cold morning', source_filename: 'plan-replay-test.json', input_hash: 'hash-1' });
    expect(Object.keys(row.input as object).sort()).toEqual(['now', 'price_archive', 'snapshot']);
    expect(JSON.stringify(row)).not.toContain('x'.repeat(100));
    await expect.poll(() => captured.dispatched.length).toBe(1);
    expect(captured.dispatched[0]).toMatchObject({ shas: 'all', scenario: '33333333-3333-4333-8333-333333333333' });
  });
});
