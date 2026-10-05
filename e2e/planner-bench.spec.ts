/**
 * The planner bench page, fully local — no real backend.
 *
 * Every number here is synthetic: bench test cases come from household replays
 * and stay in the test database, never in the repository. What this covers is
 * the page: runs listed by commit with their score, the current-vs-test totals,
 * both planners drawn for a case with the curves they used and their cost at
 * real prices, the scoring rules listed for the period shown, a start state
 * saved into its case, and an uploaded replay converted to a test case.
 */
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';
import { planStats } from '../src/lib/planner-bench/stats';
import { OPPORTUNITY_AUDIT_VERSION, OPPORTUNITY_RULES, type OpportunityAudit } from '../src/lib/planner-bench/opportunities';
import { storedScore } from '../src/lib/planner-bench/score';
import { SHORT_GAP_PRICE_TOLERANCE } from '../src/lib/planner-bench/short-gaps';
import type { BenchSeries, PlanRecord } from '../src/lib/planner-bench/types';
import type { BenchScenarioData } from '../src/lib/planner-bench/case';
import { LANES } from '../src/lib/planner-bench/lanes';

const STAFF_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CURRENT = { sha: 'c'.repeat(40), short_sha: 'ccccccc', committed_at: '2026-09-27T13:40:00Z', subject: 'Current planner' };
const TEST = { sha: 'd'.repeat(40), short_sha: 'ddddddd', committed_at: '2026-09-29T08:26:00Z', subject: 'Test planner' };
/** Two versions before the current one whose plans, and so whose scores, are the current planner's. */
const REPEATS = [
  { sha: 'a'.repeat(40), short_sha: 'aaaaaaa', committed_at: '2026-09-25T09:00:00Z', subject: 'Refactor, no change' },
  { sha: 'b'.repeat(40), short_sha: 'bbbbbbb', committed_at: '2026-09-26T09:00:00Z', subject: 'Comments, no change' },
];
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
    homeSoc: [], carSoc: [], carConnected: [], poolC: [], costSek: [], believedImportPrice: [],
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
    s.believedImportPrice!.push(i < 96 ? price : 1.5);
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
  s.carKm = new Array(n).fill(0);
  s.comfort = { pool_target_c: 30.5, ev_target_km: 300, pool_start_c: 29.5, ev_start_km: 0,
    poolReachableC: new Array(n).fill(32), carReachableKm: new Array(n).fill(0) };
  // A synthetic transport fixture for the audit UI, not an optimiser correctness test.
  const before = { poolC: s.poolC.map(v => v!), carKm: [...s.carKm], homeSoc: new Array(n).fill(50) };
  const after = { ...before, homeSoc: before.homeSoc.map((v, i) => i >= 8 && i < 24 ? v + 2 : v) };
  s.audit = {
    version: OPPORTUNITY_AUDIT_VERSION, lane: 'told/nominal', status: 'complete', reason: null,
    overlap: { thresholdW: 2000, overlappingQuarters: [], moves: [] },
    shortGaps: { priceTolerance: { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE }, candidates: [], gaps: [] },
    guard: { pool: [1, 2], ev: [50, 100] }, scaleSek: 100, originalCostSek: 63.2, improvedCostSek: 61.9,
    avoidableSek: 1.25, knownSek: 1.25, hindsightSek: 0, wearSek: .05, trials: 64, limitReached: false,
    violations: [],
    applicability: Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { applicable: r.device !== 'ev', reason: r.device === 'ev' ? 'No car charging demand' : 'Timing can change' }])) as OpportunityAudit['applicability'],
    rules: Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { findings: r.key === 'battery_price_spread' ? 1 : 0, kwh: r.key === 'battery_price_spread' ? 1 : 0, knownSek: r.key === 'battery_price_spread' ? 1.25 : 0, hindsightSek: 0, knownQuarters: r.key === 'battery_price_spread' ? [8, 24] : [] }])) as OpportunityAudit['rules'],
    findings: [{ id: 'k1', rule: 'battery_price_spread', tags: ['battery_price_spread'], device: 'battery',
      from: 24, fromEnd: 24, to: 8, toEnd: 8, kwh: 1, savingSek: 1.25, gridSavingSek: 1.3, wearSek: .05,
      basis: 'known', transfers: 1, before, after }],
  };
  return s;
}

/** A test case as the page reads it: only what the page shows needs to be real. */
const dataset = (start: string): BenchScenarioData => ({
  format: 'shs-bench-case', version: 1, origin: { kind: 'replay', detail: 'e2e', created_at: start },
  start, timezone: 'Europe/Stockholm', location: { latitude: 59.4, longitude: 18 },
  known_prices: { import_sek_per_kwh: [], export_sek_per_kwh: [] },
  solar_forecast_w: [], base_load_forecast_w: [], other_devices_w: {},
  start_state: { battery_soc: 0.5, pool_water_c: 29.5, ev: { soc: 0.6, target_soc: 0.8 } },
  comfort: { pool_c: 30.5, ev_km: 300 },
});

const record = (reference: number): PlanRecord => ({
  status: 'ready', generation: 'snapshot', valuation: { scale: 1, pool: 'urgency_only', ev: 'urgency_only', battery: 'none' },
  decisions: { pool_w: [], ev_w: [], battery_charge_w: [], battery_discharge_w: [] },
  beliefs: { import_sek_per_kwh: [], grid_cost_sek: 41.5 },
  curves: [
    { store: 'pool', unit: 'celsius', points: [{ at: 28.5, sek_per_unit: 30 }, { at: 30.5, sek_per_unit: 30 }], initial_state: 29.5, max_state: 32.5, units_per_kwh: 0.07, reference_sek_per_kwh: reference, mode: 'comfort target' },
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

interface Captured {
  rules: Record<string, unknown>[]; inserted: Record<string, unknown>[]; updated: Record<string, unknown>[]; dispatched: unknown[];
  /** What GitHub reports for the newest bench workflow run; null while none exists. */
  job: { status: string; conclusion: string | null; created_at: string } | null;
}

async function mockBackend(context: BrowserContext, { missingAudit = false, repeats = false, overlap = false, gaps = false } = {}): Promise<Captured> {
  const plans = overlap || gaps ? structuredClone(PLANS) : PLANS;
  if (overlap) {
    for (const [key, plan] of Object.entries(plans)) {
      plan.audit!.overlap = { thresholdW: 2000, overlappingQuarters: [24], moves: [
        { from: 24, to: key.startsWith(TEST.sha) ? 104 : 200, device: 'battery', movedW: 3000 },
      ] };
    }
  }
  if (gaps) {
    for (const plan of Object.values(plans)) {
      plan.audit!.shortGaps = {
        priceTolerance: { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE },
        candidates: [{ device: 'ev', from: 24, to: 26 }, { device: 'pool', from: 28, to: 29 }],
        gaps: [
          { device: 'ev', from: 24, to: 26, changes: [
            { quarter: 23, beforeW: 3450, afterW: 0 }, { quarter: 24, beforeW: 0, afterW: 3450 },
            { quarter: 25, beforeW: 0, afterW: 3450 }, { quarter: 26, beforeW: 3450, afterW: 0 },
          ] },
          { device: 'pool', from: 28, to: 29, changes: [
            { quarter: 27, beforeW: 3764, afterW: 0 }, { quarter: 28, beforeW: 0, afterW: 3764 },
          ] },
        ],
      };
    }
  }
  const captured: Captured = { rules: [], inserted: [], updated: [], dispatched: [], job: null };
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
    const body = route.request().postDataJSON();
    if (body?.action === 'status') {
      await route.fulfill({ json: { run: captured.job && { id: 1, event: 'workflow_dispatch', url: 'https://github.com/example/actions/runs/1', ...captured.job } } });
      return;
    }
    captured.dispatched.push(body);
    await route.fulfill({ json: { ok: true, runs_url: 'https://github.com/example/actions' } });
  });
  await context.route('**/rest/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split('/').pop() || '';
    if (table === 'get_price_estimate_accuracy') {
      const estimate = (issued_on: string, target_day: string, basis: string, estimated: number, actual: number | null) => ({
        home_id: 'home', issued_on, target_day, lead_days: 2, basis,
        quarters: 96, estimated_sek_per_kwh: estimated, actual_sek_per_kwh: actual, quarter_mae_sek_per_kwh: actual === null ? null : 0.4,
      });
      await route.fulfill({ json: [
        estimate('2026-10-03', '2026-10-05', 'wind', 1.5, null),
        estimate('2026-10-02', '2026-10-04', 'wind', 2.1, 1.9),
        estimate('2026-10-01', '2026-10-03', 'wind', 1.2, 1.6),
        estimate('2026-09-30', '2026-10-02', 'recent_norm', 1.0, 2.0),
      ] });
      return;
    }
    if (request.method() !== 'GET') {
      if (table === 'bench_rules') captured.rules.push(request.postDataJSON());
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
        case 'bench_rules': return [{ criteria: {} }];
        case 'bench_runs': return [
          ...(repeats ? REPEATS : []).map(run => ({ ...run, branch: 'dev', is_current: false, status: 'done', error: null, finished_at: nowIso })),
          { ...CURRENT, branch: 'dev', is_current: true, status: 'done', error: null, finished_at: nowIso },
          { ...TEST, branch: null, is_current: false, status: 'done', error: null, finished_at: nowIso },
        ];
        case 'bench_scenarios': return CASES.map(c => ({
          ...c, source_filename: null, notes: null, archived: false, created_at: nowIso,
          dataset: dataset(c.captured_at), recorded_at: nowIso, pending_reason: null,
        }));
        case 'bench_result_summaries': return [
          ...Object.entries(plans),
          ...(repeats ? REPEATS : []).flatMap(run => CASES.map(c => [`${run.sha}/${c.id}`, plans[`${CURRENT.sha}/${c.id}`]] as const)),
        ].map(([key, plan]) => {
          const [sha, scenario_id] = key.split('/');
          // Every lane has a result; the oracle lanes are cheaper, as knowing the real prices would be.
          return LANES.map((lane, k) => ({
            sha, scenario_id, lane, status: 'ok', error: null, cpu_ms: 500, stats: planStats(plan), score: { ...storedScore(plan), ...(missingAudit ? { version: 2 } : {}) },
            outcome: { ...OUTCOME, cost_sek: OUTCOME.cost_sek - (lane.startsWith('oracle') ? 12 : 0) + (k % 3) },
          }));
        }).flat();
        case 'bench_results': {
          const scenario = url.searchParams.get('scenario_id')?.replace('eq.', '');
          return [CURRENT.sha, TEST.sha].map(sha => ({
            sha, series: missingAudit ? { ...plans[`${sha}/${scenario}`], audit: undefined } : plans[`${sha}/${scenario}`], record: record(sha === TEST.sha ? 0.9 : 1.1), outcome: OUTCOME,
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
  test('explains short EV and pool gaps with their times and feasible continuous schedules', async ({ context, page }) => {
    await mockBackend(context, { gaps: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const explanation = page.locator('#bench-quarter-explanation');
    for (const [device, label, start, end, power] of [
      ['ev', 'EV charging', '08:00', '08:30', '3.45'], ['pool', 'pool heating', '09:00', '09:15', '3.76'],
    ]) {
      const row = page.locator(`#bench-rule-${device}_short_gap`);
      await expect(row).toContainText(/1 (q|kv) · −1/);
      await row.getByRole('button').first().click();
      await expect(row).toContainText(/both bordering running quarters|båda angränsande driftkvartarna/);
      await row.getByRole('button', { name: /^Test: 1 / }).click();
      await expect(explanation).toContainText(`−1 Short interruption in ${label}`);
      await expect(explanation).toContainText(`24/09 ${start} → 24/09 ${end}`);
      await expect(explanation).toContainText(/(?:larger of|större av) 10 .*öre/);
      await expect(explanation).toContainText(/10% (?:of each gap quarter's absolute price|av varje avbrottskvarts absoluta pris)/);
      await expect(row).toContainText(/Zero prices use the öre threshold|Nollpris använder öresgränsen/);
      await expect(row).toContainText(/negative prices use their magnitude|vid negativa priser används prisets storlek/);
      await row.locator('details').last().locator('summary').click();
      await expect(row.locator('details').last()).toContainText(`0.00 → ${power} kW`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(explanation).toBeVisible();
    expect(await explanation.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await explanation.screenshot({ path: test.info().outputPath('short-gap-mobile.png') });
  });

  test('names the cheaper quarter for an overlap in the selected planner', async ({ context, page }) => {
    await mockBackend(context, { overlap: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const rule = page.locator('#bench-rule-large_load_overlap');
    await rule.getByRole('button').first().click();
    await rule.getByRole('button', { name: /^Test: 1 / }).click();
    const explanation = page.locator('#bench-quarter-explanation');
    const overlap = explanation.getByRole('listitem').filter({ hasText: 'Large workloads overlap' });
    await expect(overlap).toContainText(/−1 Large workloads overlap.*(cheaper quarter|billigare kvart): 25\/09 04:00/);
    // The destination is on the next day, in the home's time zone. Switching
    // planners must explain that planner's own witness for the same source.
    await page.locator('#bench-show-current').click();
    await expect(overlap).toContainText(/(cheaper quarter|billigare kvart): 26\/09 04:00/);
    await expect(overlap).not.toContainText('25/09');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(overlap).toBeVisible();
    expect(await explanation.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await explanation.screenshot({ path: test.info().outputPath('overlap-quarter-mobile.png') });
  });

  test('shows staff how far the price estimate was from the published prices', async ({ context, page }) => {
    await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    const card = page.getByTestId('price-estimate-accuracy');
    // Two days ahead on wind: off by 0.2 and 0.4, and too low by 0.1 on average.
    await expect(card.getByRole('row', { name: /^2 (wind|vind) 2 0\.30 -0\.10 0\.40$/ })).toBeVisible();
    await expect(card.getByRole('row', { name: /^2 norm 1 1\.00 -1\.00 0\.40$/ })).toBeVisible();
    // A day the market has not published yet waits, and is left out of the means.
    await expect(card.getByRole('row', { name: /2026-10-05 2026-10-03 (wind|vind) 1\.50 – (waiting|väntar)/ })).toBeVisible();
  });

  test('lists only the newest of consecutive versions with the same score', async ({ context, page }) => {
    await mockBackend(context, { repeats: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await page.locator('#bench-test-run').click();
    // The two older versions scored what the current planner does, so the changes in them moved nothing.
    await expect(page.getByRole('option')).toHaveText([/^ccccccc · /, /^ddddddd · /]);
    await page.getByRole('listbox').screenshot({ path: test.info().outputPath('planner-options.png') });
  });

  test('compares the test planner with the current one', async ({ context, page }) => {
    const captured = await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    // The two planner boxes sit side by side, level and the same height.
    const [current, test_] = await Promise.all([page.locator('#bench-current-run').boundingBox(), page.locator('#bench-test-run').boundingBox()]);
    expect(Math.abs(current!.y - test_!.y)).toBeLessThan(1);
    expect(Math.abs(current!.height - test_!.height)).toBeLessThan(1);
    await page.locator('#bench-current-run').locator('xpath=ancestor::div[contains(@class,"grid")][1]').screenshot({ path: test.info().outputPath('planner-boxes.png') });
    await page.goto('/portal/planner-bench');

    // Runs are named by commit, time and score; the newest is the default test run.
    await expect(page.locator('#bench-test-run')).toContainText(/ddddddd · .* · -?\d+ (pts|p)/);
    await expect(page.getByText(/ccccccc · .* · -?\d+ (pts|p) · (current|nuvarande)/)).toBeVisible();

    // Totals over every case, current against test.
    await expect(page.locator('#bench-total-score')).toContainText(/Test planner is (better|worse)|No score difference|Testplaneraren är (bättre|sämre)|Ingen skillnad i poäng/);
    const caseTexts = await page.locator('[id^="bench-case-"]').allTextContents();
    const caseTotal = (side: 'C' | 'N' | 'T') => caseTexts.reduce((sum, text) => {
      const match = text.match(new RegExp(`${side} ([−-]?\\d+)`));
      return sum + (match ? Number(match[1].replace('−', '-')) : 0);
    }, 0);
    expect(Number(await page.locator('#bench-score-current').textContent())).toBe(caseTotal('N'));
    expect(Number(await page.locator('#bench-score-test').textContent())).toBe(caseTotal('T'));
    await expect(page.locator('#bench-total-grid_cost_sek')).toContainText(/-?\d+\.\d.*-?\d+\.\d\s*kr/);

    // Each case has a chip with a pass/fail dot, its name and planning time.
    await expect(page.locator(`#bench-case-${CASES[1].id}`)).toContainText('Dear week');
    await expect(page.locator('#bench-day-all')).toHaveAttribute('aria-pressed', 'true');

    // Every quarter of the shown plan carries its score in a strip above the chart.
    await expect(page.getByText(/comfort loss per quarter|komfortförlust per kvart/)).toBeVisible();

    // Clicking a quarter explains its score.
    const plan = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    const box = (await plan.boundingBox())!;
    await plan.click({ position: { x: box.width * 0.2, y: box.height * 0.5 } });
    await expect(page.getByText(/No rule fired|Ingen regel slog till|Flexible load|Pool/).first()).toBeVisible();

    // Both planners are drawn for the case; the toggle swaps the full plan chart.
    await expect(page.getByRole('img', { name: /Cost for both planners|Kostnad för båda planerarna/ })).toBeVisible();
    // The pool's temperature is a panel of the plan chart itself, with the owner's target drawn in.
    await expect(page.locator('#plan-pool-temperature')).toContainText(/30\.5 °C (target|mål)/);
    await page.getByRole('img', { name: /power flows|effektflöden/i }).first().screenshot({ path: test.info().outputPath('plan-chart.png') });
    const chart = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await expect(chart).toBeVisible();
    const drawn = await chart.innerHTML();
    await page.locator('#bench-show-current').click();
    await expect(async () => expect(await chart.innerHTML()).not.toBe(drawn)).toPass({ timeout: 10_000 });

    // Each planner's cost at real prices, beside what it expected, and the curves it planned with.
    await expect(page.locator('#bench-real-cost')).toContainText(/63\.2 kr/);
    await expect(page.locator('#bench-real-cost')).toContainText(/41\.5 kr/);
    const poolCurve = page.locator('#bench-curve-pool').getByRole('img');
    await expect(poolCurve).toBeVisible();
    await expect(page.locator('#bench-curve-pool')).toContainText('comfort target');
    // The positive target endpoint drops vertically, then stays at zero to the
    // reachable ceiling. A sloping line would invent utility above the target.
    await expect(poolCurve.locator('path').last()).toHaveAttribute('d', /L153\.0,8\.0 L153\.0,102\.0 L272\.0,102\.0$/);
    await poolCurve.screenshot({ path: test.info().outputPath('target-value-curve.png') });
    await expect(page.locator('#bench-curve-battery')).toContainText('balanced');
    await expect(page.locator('#bench-curve-ev')).toContainText(/reported no curve|rapporterade ingen kurva/);

    // The lanes say why: what knowing the real prices would have saved, and which valuation did best.
    await expect(page.locator('#bench-diagnosis-test')).toContainText(/price estimate cost 12 kr|prisgissningen kostade 12 kr/);
    // Planned from the starting prices, the planner's own estimate is drawn against the real price; given the real prices, there is none.
    await expect(page.locator('#plan-planner-price')).toHaveCount(1);
    await page.locator('#bench-lane-oracle-high').click();
    await expect(page.locator('#bench-lane-oracle-high')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#plan-planner-price')).toHaveCount(0);

    // The start state belongs to the case: an edit is saved into it and the case is run again.
    await page.locator('#bench-start-pool').fill('27');
    await page.getByRole('button', { name: /Save and re-run|Spara och kör om/ }).click();
    await expect.poll(() => captured.updated.length).toBe(1);
    expect((captured.updated[0].dataset as BenchScenarioData).start_state.pool_water_c).toBe(27);
    await expect.poll(() => captured.dispatched.length).toBe(1);

  });

  test('lists triggered rules for the shown period, explains them on click, and saves rules for every case', async ({ context, page }) => {
    const captured = await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    const rules = page.locator('#bench-rules');
    const row = (key: string) => page.locator(`#bench-rule-${key}`);

    // Triggered rules are rows with their points per quarter and the quarters they fired in.
    await expect(row('battery_price_spread')).toContainText(/2 (q|kv) · −2/);
    await expect(row('pool_low')).toContainText(/\d+ (q|kv) · −\d+/);
    // Flexible load in a very cheap quarter earns two points, in a cheap one a single point.
    await expect(row('cheapest_buy')).toContainText(/\d+ (q|kv) · \+\d+/);
    await expect(row('cheapest_buy')).toContainText('+2');
    // The same load in a very dear quarter loses two; the explanation names flexible loads, not the devices.
    await expect(row('dearest_load')).toContainText(/\d+ (q|kv) · −\d+/);
    await expect(row('dearest_load')).toContainText('−2');
    await row('dearest_load').getByRole('button').first().click();
    await expect(row('dearest_load')).toContainText(/Flexible loads together draw at least 500 W from the grid .* dearest 10 %|Flexibla laster drar tillsammans minst 500 W från nätet .* dyraste 10 %/);
    await row('dearest_load').getByRole('button').first().click();
    await expect(row('missed_cheap_quarter')).toContainText(/\d+ (q|kv) · −\d+/);
    await row('missed_cheap_quarter').getByRole('button').first().click();
    await expect(row('missed_cheap_quarter')).toContainText(/purchase price is below 1 SEK\/kWh|inköpspriset är under 1 SEK\/kWh/);
    await expect(row('missed_cheap_quarter')).toContainText(/home battery target is 100%|hembatteriets mål är 100%/);
    await expect(page.locator('#bench-missed_cheap_quarter-threshold')).toHaveValue('1');
    await expect(page.getByLabel(/Purchase price below \(SEK\/kWh\)|Inköpspris under \(SEK\/kWh\)/)).toBeVisible();
    await row('missed_cheap_quarter').getByRole('button').first().click();
    // Rules that did not fire are kept out of the way.
    await expect(row('ev_low')).toHaveCount(0);
    await page.locator('#bench-untriggered-rules > button').click();
    await expect(row('ev_low')).toContainText('N/A');
    await expect(row('ev_timing')).toContainText('N/A');
    await row('ev_from_home_battery').getByRole('button').first().click();
    await expect(row('ev_from_home_battery')).toContainText(/battery may supply base load, pool and other loads|Batteriet får försörja baslast, pool och andra laster/);
    await expect(page.locator('#bench-ev_from_home_battery-threshold')).toHaveValue('0');
    await row('ev_from_home_battery').getByRole('button').first().click();

    // The list follows the day the chart shows: the battery finding sits in the first hours only.
    await page.locator('#bench-day-2').click();
    await expect(row('battery_price_spread')).not.toContainText(/−2/);
    await page.locator('#bench-day-all').click();

    // A click opens the explanation; a second click closes it.
    await row('battery_price_spread').getByRole('button').first().click();
    await expect(row('battery_price_spread')).toContainText(/Charging from the grid when cheap/);
    const evidence = row('battery_price_spread').getByRole('button', { name: /1.00 kWh/ }).last();
    await evidence.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#bench-witness')).toBeFocused();
    await expect(page.locator('#bench-witness')).toContainText('1.25 SEK');
    await expect(page.locator('#bench-witness').getByRole('img')).toBeVisible();
    await rules.screenshot({ path: test.info().outputPath('rules-desktop.png') });
    await page.locator('#bench-witness').getByRole('button', { name: /^(To|Till):/ }).click();
    await expect(page.locator('#bench-show-test')).toHaveAttribute('aria-pressed', 'true');
    await row('battery_price_spread').getByRole('button').first().click();
    await expect(row('battery_price_spread')).not.toContainText(/Charging from the grid when cheap/);

    await expect(page.locator('#bench-pool_low-threshold')).toHaveCount(0);
    await row('pool_low').getByRole('button').first().click();
    await expect(row('pool_low')).toContainText('29.5 °C');
    await page.locator('#bench-pool_low-threshold').fill('1.5');
    await expect(row('pool_low')).toContainText('29 °C');
    // Rules are saved once for the whole bench, never into a case.
    await row('pool_low').getByRole('button', { name: /^(Save rules|Spara regler)$/ }).click();
    await expect.poll(() => captured.rules.length).toBe(1);
    expect(captured.rules[0]).toMatchObject({ id: true, criteria: { pool_low: { threshold: 1.5 } } });
    expect(captured.updated).toEqual([]);
    await expect.poll(() => captured.dispatched.length).toBe(1);
    expect(captured.dispatched[0]).toMatchObject({ shas: 'none' });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rules).toBeVisible();
    expect(await rules.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await rules.screenshot({ path: test.info().outputPath('rules-mobile.png') });
  });

  test('withholds stale scores and witnesses until older results are rescored', async ({ context, page }) => {
    await mockBackend(context, { missingAudit: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-test-run')).toContainText(/— (pts|p)/);
    await expect(page.locator('#bench-rules')).toContainText(/Missing evidence|Saknar underlag/);
    await page.locator('#bench-untriggered-rules > button').click();
    await expect(page.locator('#bench-rule-battery_price_spread')).toContainText(/Awaiting rescore|Väntar på omräkning/);
    await page.locator('#bench-rule-battery_price_spread').getByRole('button').first().click();
    await expect(page.locator('#bench-rule-battery_price_spread').getByRole('button', { name: /1.00 kWh/ })).toHaveCount(0);
  });

  test('shows a rescore queued, then running on the plan it is at, then done', async ({ context, page }) => {
    const captured = await mockBackend(context, { missingAudit: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await page.getByRole('button', { name: /Recompute scores|Räkna om poäng/ }).click();
    const banner = page.getByRole('status').filter({ hasText: /Recomputing scores|Räknar om poäng/ });
    await expect(banner).toContainText(/Waiting for GitHub Actions|Väntar på att GitHub Actions/);
    await expect(page.getByRole('button', { name: /Run missing results|Kör saknade/ })).toBeDisabled();

    captured.job = { status: 'in_progress', conclusion: null, created_at: new Date().toISOString() };
    await expect(banner).toContainText(/0 of 4 scores recomputed|0 av 4 poäng omräknade/, { timeout: 10_000 });
    await expect(banner).toContainText('ccccccc · Current planner');
    await banner.screenshot({ path: test.info().outputPath('rescore-banner.png') });

    captured.job = { ...captured.job, status: 'completed', conclusion: 'success' };
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
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
