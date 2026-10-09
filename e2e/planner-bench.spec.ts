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
import { readFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page } from '../playwright-fixture';
import { planStats } from '../src/lib/planner-bench/stats';
import { OPPORTUNITY_AUDIT_VERSION, OPPORTUNITY_RULES, type OpportunityAudit } from '../src/lib/planner-bench/opportunities';
import { REFEREE_VERSION } from '../src/lib/planner-bench/referee';
import { storedScore } from '../src/lib/planner-bench/score';
import { SHORT_GAP_PRICE_TOLERANCE } from '../src/lib/planner-bench/short-gaps';
import { EARLY_CHARGE_PRICE_TOLERANCE } from '../src/lib/planner-bench/early-charge';
import type { BenchSeries, PlanRecord } from '../src/lib/planner-bench/types';
import type { BenchScenarioData } from '../src/lib/planner-bench/case';
import { BASE_LANE, LANES } from '../src/lib/planner-bench/lanes';
import { priceEstimates, summariseEstimates, type EstimateSeries } from '../src/lib/planner-bench/price-estimates';
import { evaluate } from '../src/lib/planner-bench/evaluate';
import { shortEvRestartFixture } from '../src/lib/planner-bench/world.fixture';

const STAFF_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CURRENT = { sha: 'c'.repeat(40), short_sha: 'ccccccc', committed_at: '2026-09-27T13:40:00Z', subject: 'Current planner' };
const TEST = { sha: 'd'.repeat(40), short_sha: 'ddddddd', committed_at: '2026-09-29T08:26:00Z', subject: 'Test planner' };
/** Two versions before the current one whose plans, and so whose scores, are the current planner's. */
const REPEATS = [
  { sha: 'a'.repeat(40), short_sha: 'aaaaaaa', committed_at: '2026-09-25T09:00:00Z', subject: 'Refactor, no change' },
  { sha: 'b'.repeat(40), short_sha: 'bbbbbbb', committed_at: '2026-09-26T09:00:00Z', subject: 'Comments, no change' },
];
/** Later historical runs with the same score as dev, but no environment mark. */
const LATER_REPEATS = [
  { sha: 'e'.repeat(40), short_sha: 'eeeeeee', committed_at: '2026-09-30T09:00:00Z', subject: 'Later equivalent planner' },
  { sha: 'f'.repeat(40), short_sha: 'fffffff', committed_at: '2026-10-01T09:00:00Z', subject: 'Newest equivalent planner' },
];
const SAVED_HISTORY = Array.from({ length: 30 }, (_, i) => ({
  sha: (i + 1).toString(16).padStart(40, '0'), short_sha: `saved-${i + 1}`,
  committed_at: `2026-09-28T${String(i % 24).padStart(2, '0')}:00:00Z`, subject: 'Executed historical planner',
}));
const CASES = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Cheap night', captured_at: '2026-09-19T13:06:00Z' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Dear week', captured_at: '2026-09-24T07:25:00Z' },
];

/**
 * Three days of price estimates beside what the market then published: a day
 * with a morning and an evening peak, estimated at another level and with a
 * lower evening peak than it had.
 */
const PRICE_SERIES: EstimateSeries = (() => {
  const day = (level: number, evening: number, from = 0, to = 96) => Array.from({ length: 96 }, (_, q) => q < from || q >= to ? null
    : Math.round(level * (0.8 + 0.3 * Math.exp(-(((q - 32) / 8) ** 2)) + evening * Math.exp(-(((q - 74) / 9) ** 2))) * 1e4) / 1e4);
  const estimate = (issued_on: string, target_day: string, basis: string, quarters: (number | null)[]) => ({
    home_id: 'home', home_name: 'Test home', issued_on, issued_at: `${issued_on}T09:47:00Z`, target_day, basis, timezone: 'Europe/Stockholm', quarters,
  });
  return {
    estimates: [
      estimate('2026-10-01', '2026-10-02', 'recent_norm', day(1.0, 0.5)),
      estimate('2026-10-01', '2026-10-03', 'recent_norm', day(1.1, 0.5)),
      estimate('2026-10-02', '2026-10-04', 'wind', day(2.4, 0.5)),
      estimate('2026-10-02', '2026-10-05', 'wind', day(1.6, 0.5, 0, 52)),
      estimate('2026-10-03', '2026-10-05', 'wind', day(1.5, 0.5)),
    ],
    actuals: [
      { home_id: 'home', day: '2026-10-01', quarters: day(1.3, 0.6) },
      { home_id: 'home', day: '2026-10-02', quarters: day(2.0, 0.9) },
      { home_id: 'home', day: '2026-10-03', quarters: day(1.6, 0.4) },
      { home_id: 'home', day: '2026-10-04', quarters: day(1.9, 1.1) },
    ],
  };
})();

/** 72 hours of a plausible plan: night-cheap prices and one pool run. */
function series(runStart: number, runQuarters: number): BenchSeries {
  const n = 288, start = Date.parse('2026-09-24T00:00:00Z');
  const s: BenchSeries = {
    devices: [{ key: 'pool', name: 'Pool', schedulable: true }, { key: 'hotWater', name: 'Hot water', schedulable: true }, { key: 'car', name: 'Car', schedulable: true }],
    deviceW: {},
    start: [], hours: [], published: [], importPrice: [], exportPrice: [], solarW: [], loadW: [], poolW: [],
    hotWaterW: [], carW: [], gridImportW: [], gridExportW: [], batteryChargeW: [], batteryDischargeW: [], baseLoadBatteryCoverW: [],
    poolStart: [],
    poolThermal: {
      store: { capacity_kwh_per_c: 1, loss: { kind: 'measured', points: [{ at_c: 30, c_per_h: -.048 }] } },
      outdoorC: new Array(n).fill(20), localMonth: new Array(n).fill(9),
    },
    homeSoc: [], homeStartSoc: 50, carSoc: [], carConnected: [], poolC: [], costSek: [], believedImportPrice: [],
  };
  let temp = 29.5;
  for (let i = 0; i < n; i++) {
    const hour = (i / 4) % 24;
    const price = 1.5 + Math.sin((hour - 6) / 24 * 2 * Math.PI);
    const pool = i >= runStart && i < runStart + runQuarters ? 3500 : 0;
    const solar = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI)) * 4000;
    const load = 900 + pool + (hour === 5 ? 2000 : 0);
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
    s.poolStart!.push(i === runStart ? { off_seconds: null } : null);
    s.hotWaterW.push(hour === 5 ? 2000 : 0);
    s.carW.push(0);
    s.gridImportW.push(Math.max(0, load - solar));
    s.gridExportW.push(Math.max(0, solar - load));
    s.batteryChargeW.push(0);
    s.batteryDischargeW.push(0);
    s.baseLoadBatteryCoverW.push(0);
    s.homeSoc.push(50);
    s.carSoc.push(null);
    s.carConnected.push(1);
    s.poolC.push(temp);
    s.costSek.push((Math.max(0, load - solar) * price - Math.max(0, solar - load) * price * 0.5) * 0.25 / 1000);
  }
  s.deviceW = { pool: s.poolW, hotWater: s.hotWaterW, car: s.carW };
  s.carKm = new Array(n).fill(0);
  // The bill the score is made of: this fixture's grid cost, no wear and nothing left in the stores.
  s.wearSek = new Array(n).fill(0);
  const grid = Math.round(s.costSek.reduce((a, b) => a + b, 0) * 10_000) / 10_000;
  // The battery ends 2.3 kWh below its start: a debit of 3.4 kr at 1.40 kr/kWh.
  const battery = { start: 8, end: 5.7, cap: 17, counted: -2.3, grid_kwh: -2.4286, credit_sek: -3.4 };
  s.bill = { grid_sek: grid, wear_sek: 0, net_sek: Math.round((grid + 3.4) * 10_000) / 10_000, credit: { reference_sek_per_kwh: 1.4, battery, pool: null, ev: null, credit_sek: -3.4 } };
  s.comfort = { pool_target_c: 30.5, ev_target_km: 300, pool_start_c: 29.5, ev_start_km: 0,
    poolReachableC: new Array(n).fill(32), carReachableKm: new Array(n).fill(0) };
  // A synthetic transport fixture for the audit UI, not an optimiser correctness test.
  const before = { poolC: s.poolC.map(v => v!), carKm: [...s.carKm], homeSoc: new Array(n).fill(50) };
  const after = { ...before, homeSoc: before.homeSoc.map((v, i) => i >= 8 && i < 24 ? v + 2 : v) };
  s.audit = {
    version: OPPORTUNITY_AUDIT_VERSION, lane: 'told/nominal', status: 'complete', reason: null,
    overlap: { thresholdW: 2000, overlappingQuarters: [], moves: [] },
    shortGaps: { priceTolerance: { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE }, candidates: [], gaps: [] },
    earlyCharge: { priceTolerance: EARLY_CHARGE_PRICE_TOLERANCE, candidates: [], moves: [] },
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
  format: 'shs-bench-case', version: 2, origin: { kind: 'replay', detail: 'e2e', created_at: start },
  start, timezone: 'Europe/Stockholm', location: { latitude: 59.4, longitude: 18 },
  known_prices: { import_sek_per_kwh: [], export_sek_per_kwh: [] },
  solar_forecast_w: [], base_load_forecast_w: [], other_devices_w: {},
  start_state: { battery_soc: 0.5, pool_water_c: 29.5, pool_heater: { kind: 'off_unobserved' }, ev: { soc: 0.6, target_soc: 0.8 } },
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

async function mockBackend(context: BrowserContext, { missingAudit = false, repeats = false, history = false, savedHistory = false, noCurrentPlanner = false, overlap = false, gaps = false, shortEvRestart = false, arbitrage = false, baseLoad = false, batterySupplied = false, heatingAtTarget = false, thermalBuffer = false, manyResults = false, missingResult = false, waitingCase = false, changedCase = false } = {}): Promise<Captured> {
  const plans = overlap || gaps || shortEvRestart || arbitrage || baseLoad || batterySupplied || heatingAtTarget || thermalBuffer ? structuredClone(PLANS) : PLANS;
  if (shortEvRestart) {
    const { c, decisions } = shortEvRestartFixture();
    const result = evaluate(c, { ...record(1), decisions,
      beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh, grid_cost_sek: null },
    }, {}, 'told/low');
    for (const plan of Object.values(plans)) Object.assign(plan, result.series);
  }
  if (heatingAtTarget) {
    for (const plan of Object.values(plans)) {
      plan.importPrice = plan.importPrice.map((_, i) => i >= 24 && i < 44 ? 0.95 : 1.5);
      plan.poolW = plan.poolW.map((_, i) => i >= 24 && i < 40 ? 3764 : 0);
      plan.poolC.fill(31.2);
      plan.homeSoc.fill(46);
      plan.carKm!.fill(300);
    }
  }
  if (batterySupplied) {
    for (const plan of Object.values(plans)) {
      plan.importPrice = plan.importPrice.map((_, i) => 1 + i / 1000);
      plan.importPrice[27] = 2.15;
      plan.poolW[27] = 3764;
      plan.loadW[27] = 5884;
      plan.solarW[27] = 664;
      plan.batteryDischargeW[27] = 4610;
      plan.gridImportW[27] = 610;
      plan.gridExportW[27] = 0;
    }
  }
  if (baseLoad) {
    for (const plan of Object.values(plans)) {
      plan.importPrice = plan.importPrice.map((_, i) => i >= 240 ? 5 : 1 + i / 1000);
      for (const [i, price] of [[27, 3.93], [28, 6.11]]) {
        plan.importPrice[i] = price;
        plan.poolW[i] = 0;
        plan.hotWaterW[i] = 0;
        plan.carW[i] = 0;
        plan.loadW[i] = 2440;
        plan.solarW[i] = 480;
        plan.gridImportW[i] = 1960;
        plan.baseLoadBatteryCoverW[i] = 1960;
      }
    }
  }
  if (arbitrage) {
    for (const [key, plan] of Object.entries(plans)) {
      for (const i of [24, 25, 27]) {
        plan.exportPrice[i] = i === 25 ? 6 : 4.25;
        plan.gridExportW[i] = key.startsWith(TEST.sha) ? (i === 25 ? 5000 : 0.1) : 0;
      }
      if (key.startsWith(TEST.sha)) {
        plan.batteryChargeW[8] = 2000;
        plan.homeSoc[8] = 100;
      }
    }
  }
  if (overlap) {
    for (const [key, plan] of Object.entries(plans)) {
      const testPlan = key.startsWith(TEST.sha);
      const to = testPlan ? 104 : 200;
      plan.importPrice[24] = 0.94;
      plan.importPrice[to] = testPlan ? 0.84 : 0.74;
      plan.poolW[24] = 3764;
      plan.batteryChargeW[24] = testPlan ? 3000 : 0;
      plan.carW[24] = testPlan ? 0 : 3450;
      plan.loadW[24] = 900 + plan.poolW[24] + plan.carW[24];
      plan.gridImportW[24] = Math.max(0, plan.loadW[24] + plan.batteryChargeW[24] - plan.solarW[24]);
      plan.audit!.overlap = { thresholdW: 2000, overlappingQuarters: [24], moves: [
        { from: 24, to, device: testPlan ? 'battery' : 'ev', movedW: testPlan ? 3000 : 3450 },
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
  if (thermalBuffer) {
    for (const plan of Object.values(plans)) {
      plan.poolC.fill(32.6);
      plan.solarW = plan.solarW.map((_, i) => i < 96 ? 1000 : 100);
      plan.poolStart = plan.poolStart!.map(() => null);
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
    if (table === 'get_price_estimate_series') {
      await route.fulfill({ json: PRICE_SERIES });
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
      // As PostgREST answers a write that returns no row: an update with 204, an insert with 201.
      await route.fulfill({ status: request.method() === 'PATCH' ? 204 : 201, body: '' });
      return;
    }
    const rows: unknown[] = (() => {
      switch (table) {
        case 'staff_users': return [{ role: 'admin' }];
        case 'bench_rules': return [{ criteria: {} }];
        case 'bench_runs': return [
          ...(repeats || history ? REPEATS : []).map(run => ({ ...run, branch: 'dev', is_current: false, is_test: false, status: 'done', error: null, finished_at: nowIso })),
          { ...CURRENT, branch: 'main', is_current: true, is_test: false, status: noCurrentPlanner ? 'unavailable' : 'done', error: noCurrentPlanner ? 'This commit does not contain a planner entry point.' : null, finished_at: nowIso },
          { ...TEST, branch: 'dev', is_current: false, is_test: true, status: 'done', error: null, finished_at: nowIso },
          ...(history ? LATER_REPEATS : []).map(run => ({ ...run, branch: 'dev', is_current: false, is_test: false, status: 'done', error: null, finished_at: nowIso })),
          ...(savedHistory ? SAVED_HISTORY : []).map(run => ({ ...run, branch: 'dev', is_current: false, is_test: false, status: 'done', error: null, finished_at: nowIso })),
        ];
        case 'bench_scenarios': return CASES.map(c => ({
          ...c, revision: c.id, source_filename: null, notes: 'Synthetic evaluation: load and solar use forecasts.', archived: false, created_at: nowIso,
          dataset: dataset(c.captured_at), recorded_at: waitingCase && c.id === CASES[1].id ? null : nowIso, pending_reason: waitingCase && c.id === CASES[1].id ? 'measurement window ends tomorrow' : null,
        }));
        case 'bench_result_summaries': return [
          ...Object.entries(plans).filter(([key]) => !noCurrentPlanner || !key.startsWith(CURRENT.sha)),
          ...(repeats || history ? REPEATS : []).flatMap(run => CASES.map(c => [`${run.sha}/${c.id}`, plans[`${history ? TEST.sha : CURRENT.sha}/${c.id}`]] as const)),
          ...(history ? LATER_REPEATS : []).flatMap(run => CASES.map(c => [`${run.sha}/${c.id}`, plans[`${TEST.sha}/${c.id}`]] as const)),
          ...(savedHistory ? SAVED_HISTORY : []).flatMap(run => CASES.map(c => [`${run.sha}/${c.id}`, plans[`${TEST.sha}/${c.id}`]] as const)),
        ].map(([key, plan]) => {
          const [sha, scenario_id] = key.split('/');
          // Every lane has a result; the oracle lanes are cheaper, as knowing the real prices would be.
          return LANES.map((lane, k) => ({
            sha, scenario_id, lane, case_revision: changedCase && sha === TEST.sha && scenario_id === CASES[1].id ? 'old' : scenario_id, has_record: true, has_evaluation: true, referee_version: REFEREE_VERSION, status: 'ok', error: null, cpu_ms: 500, stats: planStats(plan), score: { ...storedScore(plan), ...(missingAudit ? { version: 2 } : {}), ...(savedHistory && SAVED_HISTORY.some(r => r.sha === sha) ? { version: 24 } : {}) },
            outcome: { ...OUTCOME, cost_sek: OUTCOME.cost_sek - (lane.startsWith('oracle') ? 12 : 0) + (k % 3) },
          }));
        }).flat();
        case 'bench_results': {
          const scenario = url.searchParams.get('scenario_id')?.replace('eq.', '');
          return [CURRENT.sha, TEST.sha].filter(sha => !noCurrentPlanner || sha !== CURRENT.sha).map(sha => ({
            sha, series: missingAudit ? { ...plans[`${sha}/${scenario}`], audit: undefined } : plans[`${sha}/${scenario}`], record: record(sha === TEST.sha ? 0.9 : 1.1), outcome: OUTCOME,
          }));
        }
        default: return [];
      }
    })();
    let resultRows = rows;
    if (table === 'bench_result_summaries') {
      if (manyResults) resultRows = [...Array.from({ length: 1200 }, (_, i) => ({
        ...(rows[0] as Record<string, unknown>), lane: BASE_LANE, sha: `0${String(i).padStart(39, '0')}`,
      })), ...rows];
      if (missingResult) resultRows = resultRows.filter(row => {
        const r = row as Record<string, unknown>;
        return !(r.sha === TEST.sha && r.scenario_id === CASES[1].id);
      });
      for (const [field, query] of url.searchParams) {
        if (query.startsWith('eq.')) resultRows = resultRows.filter(row => (row as Record<string, unknown>)[field] === query.slice(3));
        if (query.startsWith('in.')) resultRows = resultRows.filter(row => query.slice(4, -1).split(',').includes(String((row as Record<string, unknown>)[field])));
      }
      const from = Number(url.searchParams.get('offset') ?? request.headers().range?.split('-')[0] ?? 0);
      const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 1000));
      resultRows = resultRows.slice(from, from + limit);
    }
    const single = (request.headers().accept || '').includes('vnd.pgrst.object');
    await route.fulfill({ status: single && resultRows.length === 0 ? 406 : 200, contentType: 'application/json', body: JSON.stringify(single ? resultRows[0] ?? null : resultRows) });
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
  test('explains a thermal buffer event with cause and bounds in both rule and quarter details', async ({ context, page }) => {
    await mockBackend(context, { thermalBuffer: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const rule = page.locator('#bench-rule-pool_buffer');
    await rule.getByRole('button', { name: /Warm thermal buffer/ }).click();
    await expect(rule).toContainText(/low solar event between|låg solproduktion under händelsen/);
    await expect(rule).toContainText(/25.*02:00.*26.*02:00/);
    await rule.getByRole('button', { name: /Show the first in the chart|Visa den första i diagrammet/ }).first().click();
    await expect(page.locator('#bench-quarter-explanation')).toContainText(/low solar event between|låg solproduktion under händelsen/);
  });

  test('scores the C-0616 03:00–04:00 EV restart gap using the real evaluator', async ({ context, page }) => {
    await mockBackend(context, { shortEvRestart: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const row = page.locator('#bench-rule-ev_short_gap');
    await expect(row).toContainText(/4 (q|kv) · −4/);
    await row.getByRole('button').first().click();
    await row.getByRole('button', { name: /^dev: 4 / }).click();
    const explanation = page.locator('#bench-quarter-explanation');
    await expect(explanation).toContainText('16/06 03:00');
    await expect(explanation).toContainText('−1 Short interruption in EV charging');
    await expect(explanation).toContainText('16/06 03:00 → 16/06 04:00');
    await row.locator('details').last().locator('summary').click();
    await expect(row.locator('details').last()).toContainText('16/06 03:00: 0.00 → 3.45 kW');
    await expect(row.locator('details').last()).toContainText('16/06 04:00: 3.45 → 0.00 kW');
  });

  test('explains short EV and pool gaps with their times and feasible continuous schedules', async ({ context, page }) => {
    await mockBackend(context, { gaps: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const explanation = page.locator('#bench-quarter-explanation');
    for (const [device, label, start, end, power, quarters] of [
      ['ev', 'EV charging', '08:00', '08:30', '3.45', 2], ['pool', 'pool heating', '09:00', '09:15', '3.76', 1],
    ]) {
      const row = page.locator(`#bench-rule-${device}_short_gap`);
      // Neither pause has a restart the restart rule charges here, so each gap takes its own points.
      await expect(row).toContainText(new RegExp(`${quarters} (q|kv) · −${quarters}`));
      await row.getByRole('button').first().click();
      await expect(row).toContainText(/dearer than a bordering running quarter|dyrare än en angränsande driftkvart/);
      await expect(row).toContainText(/(?:larger of|större av) 10 öre\/kWh (?:or|eller) 10% (?:of its own absolute price|av sitt eget absoluta pris)/);
      await row.getByRole('button', { name: new RegExp(`^dev: ${quarters} `) }).click();
      await expect(explanation).toContainText(`−1 Short interruption in ${label}`);
      await expect(explanation).toContainText(`24/09 ${start} → 24/09 ${end}`);
      await expect(explanation).toContainText(/a continuous run was possible|sammanhängande drift var möjlig/);
      await expect(row).toContainText(/Zero prices use the öre threshold|Nollpris använder öresgränsen/);
      await expect(row).toContainText(/negative prices use their magnitude|vid negativa priser används prisets storlek/);
      await row.locator('details').last().locator('summary').click();
      await expect(row.locator('details').last()).toContainText(`0.00 → ${power} kW`);
    }
    // Selecting the second gap quarter must retain the full gap explanation.
    const chart = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await page.mouse.click(box.x + box.width * (58 + (25.5 / 288) * 1010) / 1160, box.y + 150);
    await expect(explanation).toContainText('24/09 08:15');
    await expect(explanation).toContainText('−1 Short interruption in EV charging');
    await expect(explanation).toContainText('24/09 08:00 → 24/09 08:30');
    await expect(explanation).toContainText(/2 (quarters|kvartar)/);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(explanation).toBeVisible();
    expect(await explanation.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await explanation.screenshot({ path: test.info().outputPath('short-gap-mobile.png') });
  });

  test('running pool heating above target takes the cheap quarter even while the battery is short', async ({ context, page }) => {
    await mockBackend(context, { heatingAtTarget: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const missed = page.locator('#bench-rule-missed_cheap_quarter');
    // Sixteen heating quarters avoid a penalty; only the four idle cheap
    // quarters after the run are missed, despite the battery staying at 46%.
    await expect(missed).toContainText(/4 (q|kv) · (noted|noteras)/);
    await missed.getByRole('button').first().click();
    await expect(missed).toContainText(/already at or above target|redan är vid eller över målet/);
    await missed.getByRole('button', { name: /^dev: 4 / }).click();
    const explanation = page.locator('#bench-quarter-explanation');
    await expect(explanation).toContainText('24/09 12:00');
    await expect(explanation).toContainText('Missed cheap charging or heating quarter');
    const taken = page.locator('#bench-rule-cheapest_buy');
    await taken.getByRole('button').first().click();
    await taken.getByRole('button', { name: /^dev: 16 / }).click();
    await expect(explanation).toContainText('24/09 08:00');
    await expect(explanation).not.toContainText('Missed cheap charging or heating quarter');
  });

  test('explains the moved load and both real prices, and opens its cheaper destination day', async ({ context, page }) => {
    await mockBackend(context, { overlap: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const rule = page.locator('#bench-rule-large_load_overlap');
    await rule.getByRole('button').first().click();
    await rule.getByRole('button', { name: /^dev: 1 / }).click();
    const explanation = page.locator('#bench-quarter-explanation');
    const overlap = explanation.getByRole('listitem').filter({ hasText: 'Large workloads overlap' });
    await expect(overlap).toContainText(/(noted|noteras) Large workloads overlap.*(cheaper quarter|billigare kvart): 25\/09 04:00/);
    await expect(overlap).toContainText(/Home battery charging.*3.00 kW|Hembatteriladdning.*3.00 kW/);
    await expect(overlap).toContainText(/24\/09 08:00 · (real price|verkligt pris): 0.94 SEK\/kWh/);
    await expect(overlap).toContainText(/25\/09 04:00 · (real price|verkligt pris): 0.84 SEK\/kWh/);
    await expect(rule).toContainText(/pool heating cycle stays fixed|Poolens värmecykel hålls oförändrad/);
    await expect(rule).toContainText(/distinct cheaper quarter|egen billigare kvart/);
    // Start on the source day. The destination button must switch days and
    // select the actual destination rather than the same clock time today.
    await page.locator('#bench-day-0').click();
    await overlap.getByRole('button', { name: /(?:Show cheaper quarter|Visa billigare kvart): 25\/09 04:00/ }).click();
    await expect(page.locator('#bench-day-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(explanation).toContainText('25/09 04:00');
    await expect(explanation).toContainText('0.84 kr/kWh');
    await page.locator('#bench-day-0').click();
    await rule.getByRole('button', { name: /(?:Show source quarter|Visa från kvart): 24\/09 08:00/ }).last().click();
    // The destination is on the next day, in the home's time zone. Switching
    // planners must explain that planner's own witness for the same source.
    await page.locator('#bench-show-current').click();
    await expect(overlap).toContainText(/(cheaper quarter|billigare kvart): 26\/09 04:00/);
    await expect(overlap).toContainText(/EV charging.*3.45 kW|Billaddning.*3.45 kW/);
    await expect(overlap).toContainText(/26\/09 04:00 · (real price|verkligt pris): 0.74 SEK\/kWh/);
    await expect(overlap).not.toContainText('25/09');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(overlap).toBeVisible();
    expect(await explanation.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await explanation.screenshot({ path: test.info().outputPath('overlap-quarter-mobile.png') });
  });

  test('explains each price estimate on its own tab: a chart against the real prices and a table of the same days', async ({ context, page }) => {
    await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    // The bench tab carries no price estimate; the accuracy view has its own tab, kept in the URL.
    await expect(page.getByTestId('price-estimate-accuracy')).toHaveCount(0);
    await page.locator('#bench-tab-prices').click();
    await expect(page).toHaveURL(/tab=prices/);
    const view = page.getByTestId('price-estimate-accuracy');
    const made = priceEstimates(PRICE_SERIES);
    const two = (value: number) => value.toFixed(2);

    // It opens on the newest estimate with a published day to judge it by: the second of three.
    await expect(view.locator('#price-estimate-title')).toContainText(/2 (Oct|okt)/);
    await expect(view.getByText(/^2 (of|av) 3$/)).toBeVisible();
    await expect(view.locator('#price-estimate-chart #price-estimate-line')).toHaveAttribute('d', /M/);
    await expect(view.locator('#price-estimate-chart #price-estimate-gap')).toHaveAttribute('d', /M/);
    // The table lists exactly the days the chart marks a level for, with the figures drawn.
    const rows = view.locator('#price-estimate-days tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(view.locator('#price-estimate-chart [data-level]')).toHaveCount(2);
    const [dayA, dayB] = made[1].days;
    await expect(rows.nth(0)).toContainText(new RegExp(`${two(dayA.believed)}\\s*${two(dayA.was!)}\\s*[+-]${two(Math.abs(dayA.levelError!))}\\s*${two(dayA.quarterError!)}`));
    await expect(view.locator('#price-estimate-chart')).toContainText(new RegExp(`(level error|nivåfel) [+-]${two(Math.abs(dayA.levelError!))}`));
    // The plan's last day is estimated in part and not published yet: it waits.
    await expect(rows.nth(1)).toContainText(new RegExp(`${dayB.quarters} (of|av) 96`));
    await expect(rows.nth(1)).toContainText(/waiting|väntar/);
    await expect(view.locator('#price-estimate-method')).toContainText(/wind forecast|vindprognosen/);
    await view.screenshot({ path: test.info().outputPath('price-estimate-desktop.png') });
    await page.screenshot({ path: test.info().outputPath('price-estimate-desktop-page.png') });

    // Previous and next step through the days estimates were made on, by button or arrow key.
    await view.locator('#price-estimate-previous').click();
    await expect(view.locator('#price-estimate-title')).toContainText(/1 (Oct|okt)/);
    await expect(page).toHaveURL(/estimate=2026-10-01/);
    await expect(view.locator('#price-estimate-previous')).toBeDisabled();
    await expect(view.locator('#price-estimate-method')).toContainText(/median/);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(view.locator('#price-estimate-title')).toContainText(/3 (Oct|okt)/);
    await expect(view.locator('#price-estimate-next')).toBeDisabled();
    await expect(view.locator('#price-estimate-days tbody tr')).toHaveCount(1);

    // Every estimate together: one day ahead on the norm, two days ahead on wind.
    const summary = summariseEstimates(made);
    const totals = view.locator('#price-estimate-summary tbody tr');
    await expect(totals).toHaveCount(summary.length);
    await expect(totals.nth(0)).toContainText(new RegExp(`${summary[0].days}\\s*${two(summary[0].levelError)}\\s*${two(summary[0].quarterError)}`));

    // Hovering the chart reads one quarter-hour: real, estimate and the gap between them.
    await view.locator('#price-estimate-previous').click();
    const box = (await view.locator('#price-estimate-chart').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await expect(view.locator('#price-estimate-tooltip')).toContainText(/(Error|Fel): [+-]\d\.\d\d/);

    // The link opens the same tab and estimate.
    await page.goto('/portal/planner-bench?tab=prices&estimate=2026-10-01');
    await expect(page.getByTestId('price-estimate-accuracy').locator('#price-estimate-title')).toContainText(/1 (Oct|okt)/);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#price-estimate-chart')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('price-estimate-mobile-page.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByTestId('price-estimate-accuracy').screenshot({ path: test.info().outputPath('price-estimate-mobile.png') });
  });

  test('loads every result beyond the API cap before showing suite scores', async ({ context, page }) => {
    const offsets: number[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/bench_result_summaries') && url.searchParams.get('scenario_id') === null) offsets.push(Number(url.searchParams.get('offset') ?? 0));
    });
    await mockBackend(context, { manyResults: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-total-score')).toBeVisible();
    await expect(page.locator(`#bench-case-${CASES[1].id}`)).toContainText(/dev [−-]?\d+/);
    expect(offsets).toContain(1000);
  });

  test('downloads the data the chart shows: the whole period, or only the day in view', async ({ context, page }) => {
    await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    const button = page.locator('#bench-chart-download');
    const saved = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
      return { name: download.suggestedFilename(), file: JSON.parse(readFileSync(await download.path(), 'utf8')) };
    };
    // The button closes the score section, beside the quarter's explanation.
    const why = (await page.locator('#bench-quarter-explanation').boundingBox())!, at = (await button.boundingBox())!;
    expect(Math.abs(at.y - why.y)).toBeLessThan(8);

    const all = await saved();
    expect(all.file.format).toBe('shs-planner-bench-chart');
    expect(all.file.case.name).toBe('Cheap night');
    expect(all.file.plans.map((p: { name: string; shown: boolean }) => [p.name, p.shown])).toEqual([['main', false], ['dev', true]]);
    const whole = PLANS[`${TEST.sha}/${CASES[0].id}`].start.length;
    expect(all.file.period.quarters).toBe(whole);
    expect(all.file.plans[1].quarters).toHaveLength(whole);
    expect(all.name).toMatch(/^bench-Cheap-night-dev-.*\.json$/);

    // One day in view: that day only, for the planner now shown.
    await page.locator('#bench-day-1').click();
    await page.locator('#bench-show-current').click();
    const day = await saved();
    expect(day.file.period.quarters).toBeLessThan(whole);
    expect(day.file.period.from_quarter).toBeGreaterThan(0);
    for (const plan of day.file.plans) {
      expect(plan.quarters).toHaveLength(day.file.period.quarters);
      expect(plan.quarters[0].index).toBe(day.file.period.from_quarter);
      expect(plan.quarters[0].start).toBe(day.file.period.start);
    }
    expect(day.file.plans.map((p: { name: string; shown: boolean }) => [p.name, p.shown])).toEqual([['main', true], ['dev', false]]);
    expect(day.name).toMatch(/^bench-Cheap-night-main-/);
  });

  test('withholds a suite comparison when one measured case has no result', async ({ context, page }) => {
    await mockBackend(context, { missingResult: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-incomplete')).toBeVisible();
    await expect(page.locator('#bench-total-score')).toHaveCount(0);
    await expect(page.locator(`#bench-case-${CASES[1].id}`)).toContainText(/missing result|saknar resultat/);
  });

  test('pending measurements exclude old scores on both sides', async ({ context, page }) => {
    await mockBackend(context, { waitingCase: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-coverage')).toContainText(/1 measured cases.*1 waiting|1 uppmätta testfall.*1 väntar/);
    await expect(page.locator('#bench-total-score')).toBeVisible();
    const pending = page.locator(`#bench-case-${CASES[1].id}`);
    await expect(pending).not.toContainText(/dev [−-]?\d+|main [−-]?\d+/);
    await pending.click();
    await expect(page.getByText(/measurement window ends tomorrow/)).toBeVisible();
    await expect(page.getByRole('img', { name: /power flows|effektflöden/i })).toHaveCount(0);
  });

  test('changed case inputs cannot enter an otherwise current suite score', async ({ context, page }) => {
    await mockBackend(context, { changedCase: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-incomplete')).toBeVisible();
    await expect(page.locator(`#bench-case-${CASES[1].id}`)).toContainText(/inputs changed|ändrade indata/);
  });

  test('lists only the newest of consecutive versions with the same score', async ({ context, page }) => {
    await mockBackend(context, { repeats: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await page.locator('#bench-test-run').click();
    // The two older versions scored what the current planner does, so the changes in them moved nothing.
    await expect(page.getByRole('option')).toHaveText([/^main · ccccccc · /, /^dev · ddddddd · /]);
    await page.getByRole('listbox').screenshot({ path: test.info().outputPath('planner-options.png') });
  });

  test('keeps exact main and dev heads and the newest equal-score historical commits', async ({ context, page }) => {
    await mockBackend(context, { history: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-current-run')).toContainText('ccccccc');
    await expect(page.locator('#bench-test-run')).toContainText('ddddddd');
    await page.locator('#bench-test-run').click();
    await expect(page.getByText(/^(Branches|Grenar)$/)).toBeVisible();
    await expect(page.getByText(/^(Earlier commits|Tidigare commits)$/)).toBeVisible();
    // A branch head goes by its branch; any other commit by its hash, the date and its points, nothing else.
    const options = [/^main · ccccccc · .* · -?\d+\.\d (pts|p)$/, /^dev · ddddddd · .* · -?\d+\.\d (pts|p)$/, /^bbbbbbb · .* · -?\d+\.\d (pts|p)$/, /^fffffff · .* · -?\d+\.\d (pts|p)$/];
    await expect(page.getByRole('option')).toHaveText(options);
    await page.getByRole('option').filter({ hasText: /^bbbbbbb · / }).click();
    await expect(page.locator('#bench-test-run')).toContainText('bbbbbbb');
    await expect(page.locator('#bench-current-run')).toContainText('ccccccc');
    await page.locator('#bench-test-run').click();
    // Dev stays available even after selecting history and a newer run has its score.
    await expect(page.getByRole('option')).toHaveText(options);
    await page.getByRole('option').filter({ hasText: /^dev · ddddddd · / }).click();
    await expect(page.locator('#bench-test-run')).toContainText('ddddddd');
  });

  test('gives a commit scored by an older scorer no points and scrolls a long picker without moving or skipping rows', async ({ context, page }) => {
    await mockBackend(context, { savedHistory: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await page.locator('#bench-test-run').click();
    const list = page.getByRole('listbox');
    const viewport = list.locator('[data-radix-select-viewport]');
    await expect(viewport).toHaveCSS('scrollbar-width', 'thin');
    await expect(page.getByRole('option')).toHaveCount(SAVED_HISTORY.length + 2);
    // Points from another scorer cannot be compared, so the commit asks for a rerun instead of showing them.
    await expect(page.getByRole('option').filter({ hasText: /^saved-1 · / })).toHaveText(/^saved-1 · .* · (needs a rerun|behöver köras om)$/);
    await list.screenshot({ path: test.info().outputPath('saved-history-picker.png') });
    const bounds = (await list.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(320);
    await viewport.hover();
    let previous = await viewport.evaluate(el => el.scrollTop);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 100);
      await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(previous);
      previous = await viewport.evaluate(el => el.scrollTop);
      const nextBounds = (await list.boundingBox())!;
      expect(nextBounds.y).toBeCloseTo(bounds.y, 0);
      expect(nextBounds.height).toBeCloseTo(bounds.height, 0);
    }
    await page.keyboard.press('End');
    await expect(page.getByRole('option').last()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#bench-test-run')).toContainText('saved-30');
    await expect(page.locator('#bench-incomplete')).toBeVisible();
    await expect(page.locator('#bench-total-score')).toHaveCount(0);
    await page.locator('#bench-test-run').click();
    await page.keyboard.press('Home');
    await expect(page.getByRole('option').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#bench-test-run')).toBeFocused();
  });

  test('shows a branch commit with no planner as unavailable without inventing a comparison score', async ({ context, page }) => {
    await mockBackend(context, { noCurrentPlanner: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-current-run')).toContainText('ccccccc');
    await expect(page.locator('#bench-current-run')).toContainText(/no planner|saknar planerare/);
    await expect(page.getByRole('status').filter({ hasText: /This commit does not contain a planner|Den här commiten innehåller ingen planerare/ })).toBeVisible();
    await expect(page.locator('#bench-test-run')).toContainText('ddddddd');
    await expect(page.locator('#bench-total-score')).toHaveCount(0);
    await expect(page.locator('#bench-incomplete')).toContainText(/one does not contain a planner|saknar planerare/);
    await page.locator('#bench-test-run').click();
    await page.getByRole('option').filter({ hasText: /^main · ccccccc · / }).click();
    await expect(page.locator('#bench-test-run')).toContainText(/no planner|saknar planerare/);
    await expect(page.locator('#bench-total-score')).toHaveCount(0);
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

    // Branch heads are named by branch, then commit, time and score; dev is the default to compare.
    await expect(page.locator('#bench-test-run')).toHaveText(/^dev · ddddddd · .* · -?\d+\.\d (pts|p)$/);
    await expect(page.locator('#bench-current-run')).toHaveText(/^main · ccccccc · .* · -?\d+\.\d (pts|p)$/);

    // Totals over every case, current against test.
    await expect(page.locator('#bench-total-score')).toContainText(/dev is (better|worse) than main|No score difference|dev är (bättre|sämre) än main|Ingen skillnad i poäng/);
    const caseTexts = await page.locator('[id^="bench-case-"]').allTextContents();
    const caseTotal = (side: 'main' | 'dev') => caseTexts.reduce((sum, text) => {
      const match = text.match(new RegExp(`${side} ([−-]?\\d+\\.\\d)`));
      return sum + (match ? Number(match[1].replace('−', '-')) : 0);
    }, 0);
    // A point is a krona: the suite's score is the sum of its cases', each shown to a decimal.
    expect(Math.abs(Number(await page.locator('#bench-score-current').textContent()) - caseTotal('main'))).toBeLessThan(0.1 * caseTexts.length);
    expect(Math.abs(Number(await page.locator('#bench-score-test').textContent()) - caseTotal('dev'))).toBeLessThan(0.1 * caseTexts.length);
    await expect(page.locator('#bench-total-grid_cost_sek')).toContainText(/-?\d+\.\d.*-?\d+\.\d\s*kr/);

    // Each case has a chip with a pass/fail dot, its name and planning time.
    await expect(page.locator(`#bench-case-${CASES[1].id}`)).toContainText('Dear week');
    await expect(page.getByText('Synthetic evaluation: load and solar use forecasts.', { exact: true })).toBeVisible();
    await expect(page.locator('#bench-day-all')).toHaveAttribute('aria-pressed', 'true');

    // Every quarter of the shown plan carries its score in a strip under the chart, with its explanation below it.
    await expect(page.locator('#plan-score')).toContainText(/rule points per quarter|regelpoäng per kvart/);
    const strip = (await page.locator('#plan-score').boundingBox())!, axis = (await page.locator('#plan-cost').boundingBox())!;
    const why = (await page.locator('#bench-quarter-explanation').boundingBox())!;
    expect(strip.y).toBeGreaterThan(axis.y + axis.height);
    expect(why.y).toBeGreaterThan(strip.y);
    expect(why.y - (strip.y + strip.height)).toBeLessThan(40);

    // Clicking a quarter explains its score.
    const plan = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    const box = (await plan.boundingBox())!;
    await plan.click({ position: { x: box.width * 0.2, y: box.height * 0.5 } });
    await expect(page.getByText(/No rule fired|Ingen regel slog till|Flexible load|Pool/).first()).toBeVisible();

    // Both planners' costs are a panel of the plan chart itself; the toggle swaps the rest of it.
    await expect(page.locator('#plan-cost')).toContainText(/What it costs|Kostnad/);
    await expect(page.locator('#plan-cost path')).toHaveCount(2);
    // It follows the period shown, like every other panel.
    const testCost = page.locator('#plan-cost path').last();
    const wholeCase = await testCost.getAttribute('d');
    await page.locator('#bench-day-1').click();
    await expect(testCost).not.toHaveAttribute('d', wholeCase!);
    await page.locator('#plan-cost').screenshot({ path: test.info().outputPath('plan-cost-day.png') });
    await page.locator('#bench-day-all').click();
    await expect(testCost).toHaveAttribute('d', wholeCase!);
    // So is the pool's temperature, with the owner's target drawn in.
    await expect(page.locator('#plan-temperature')).toContainText(/30\.5 °C (target|mål)/);
    // The test plan is drawn against the current planner's battery and pool, dashed.
    const compared = page.locator('#plan-storage path[stroke-dasharray="5 3"], #plan-temperature path[stroke-dasharray="5 3"]');
    await expect(compared).toHaveCount(2);
    await expect(page.locator('#plan-storage')).toContainText(/(dashed|streckat) = main/);
    await expect(page.locator('#plan-temperature')).toContainText(/(dashed|streckat) = main/);
    await page.getByRole('img', { name: /power flows|effektflöden/i }).first().screenshot({ path: test.info().outputPath('plan-chart.png') });
    const chart = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    await expect(chart).toBeVisible();
    const drawn = await chart.innerHTML();
    await page.locator('#bench-show-current').click();
    await expect(async () => expect(await chart.innerHTML()).not.toBe(drawn)).toPass({ timeout: 10_000 });
    // The current plan shown on its own has nothing to be dashed against.
    await expect(compared).toHaveCount(0);

    // Case costs live in the top summary, labelled separately from totals across all cases.
    const summary = page.locator('#bench-summary');
    await expect(summary.locator('#bench-real-cost')).toContainText(/63\.2 kr/);
    await expect(summary.locator('#bench-real-cost')).toContainText(/41\.5 kr/);
    await expect(summary.locator('#bench-real-cost')).toContainText(/−3\.4/);
    await expect(summary.locator('#bench-selected-cost-title')).toContainText('Cheap night');
    await expect(page.locator('#bench-real-cost')).toHaveCount(1);
    const caseCard = page.locator('#bench-show-current').locator('xpath=ancestor::*[contains(@class,"rounded-lg")][1]');
    await expect(caseCard.locator('#bench-real-cost')).toHaveCount(0);
    await summary.screenshot({ path: test.info().outputPath('cost-summary-desktop.png') });
    await expect(page.getByText(/Value curves used|Värdekurvor som användes/)).toHaveCount(0);

    // Every planner on the bench is given the real prices, so no estimate is drawn beside them.
    await expect(page.locator('#plan-planner-price')).toHaveCount(0);
    await expect(page.locator('#bench-lanes')).toHaveCount(0);

    // The start state belongs to the case: an edit is saved into it and the case is run again.
    await page.locator('#bench-start-pool').fill('27');
    await page.getByRole('button', { name: /Save and re-run|Spara och kör om/ }).click();
    await expect.poll(() => captured.updated.length).toBe(1);
    expect((captured.updated[0].dataset as BenchScenarioData).start_state.pool_water_c).toBe(27);
    await expect.poll(() => captured.dispatched.length).toBe(1);

    await page.locator(`#bench-case-${CASES[1].id}`).click();
    await expect(summary.locator('#bench-selected-cost-title')).toContainText('Dear week');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(summary.locator('#bench-real-cost')).toBeVisible();
    expect(await summary.locator('#bench-real-cost').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await summary.screenshot({ path: test.info().outputPath('cost-summary-mobile.png') });

  });

  test('does not penalize battery-supplied flexible load while base load still imports in a dear quarter', async ({ context, page }) => {
    await mockBackend(context, { batterySupplied: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const chart = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    const box = (await chart.boundingBox())!;
    // Quarter 27 in the full 288-quarter chart, inside the plotted area.
    await chart.click({ position: { x: box.width * (58 + 27.5 / 288 * 1010) / 1160, y: box.height * 0.2 } });
    const explanation = page.locator('#bench-quarter-explanation');
    await expect(explanation).toContainText('2.15');
    await expect(explanation).toContainText(/No rule fired|Ingen regel slog till/);
    await expect(explanation).not.toContainText(/Flexible load bought in a (very )?dear quarter/);
  });

  test('shows the two battery-coverable base-load price tiers in the chart and rule settings', async ({ context, page }) => {
    await mockBackend(context, { baseLoad: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const chart = page.getByRole('img', { name: /power flows|effektflöden/i }).first();
    const box = (await chart.boundingBox())!;
    const explanation = page.locator('#bench-quarter-explanation');
    for (const [quarter, price, key, points] of [
      [27, '3.93', 'base_load_dear_import', 'noted'],
      [28, '6.11', 'base_load_dearest_import', 'noted'],
    ] as const) {
      await chart.click({ position: { x: box.width * (58 + (quarter + 0.5) / 288 * 1010) / 1160, y: box.height * 0.2 } });
      await expect(explanation).toContainText(price);
      await expect(explanation).toContainText(new RegExp(`(${points}|noteras) .*base-load import the battery could cover`));
      const row = page.locator(`#bench-rule-${key}`);
      await expect(row).toContainText(new RegExp(`1 (q|kv) · (${points}|noteras)`));
      await row.getByRole('button').first().click();
      await expect(row).toContainText(/remaining discharge power|återstående urladdningseffekt/);
      await expect(page.locator(`#bench-${key}-threshold`)).toHaveValue(key === 'base_load_dear_import' ? '0.25' : '0.1');
      await row.getByRole('button').first().click();
    }
    const row = page.locator('#bench-rule-base_load_dearest_import');
    await row.getByRole('button').first().click();
    await page.locator('#bench-base_load_dearest_import-on').click();
    await expect(explanation).toContainText(/(noted|noteras) Dear base-load import/);
    await expect(explanation).not.toContainText('Very dear base-load import');
  });

  test('shows independent high-sale export and full-charge preparation penalties', async ({ context, page }) => {
    await mockBackend(context, { arbitrage: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    const row = (key: string) => page.locator(`#bench-rule-${key}`);
    for (const key of ['arbitrage_no_export', 'arbitrage_not_full']) {
      await expect(row(key)).toContainText(/3 (q|kv) · (noted|noteras)/);
      await row(key).getByRole('button').first().click();
      await expect(page.locator(`#bench-${key}-threshold`)).toHaveValue('4');
      await expect(row(key).getByLabel(/Sale price above \(SEK\/kWh\)|Säljpris över \(SEK\/kWh\)/)).toBeVisible();
      if (key === 'arbitrage_no_export') {
        await expect(row(key)).toContainText(/Any positive export counts|All positiv export räknas/);
      } else {
        await expect(row(key)).toContainText(/Discharge after that full charge is allowed|Urladdning efter den fulla laddningen är tillåten/);
        await expect(row(key)).toContainText(/Prepared · 100%|Förberett · 100%/);
        await expect(row(key)).toContainText(/Not prepared · 50%|Inte förberett · 50%/);
        await page.locator('#bench-rules').screenshot({ path: test.info().outputPath('arbitrage-rules-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await row(key).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await row(key).screenshot({ path: test.info().outputPath('arbitrage-rule-mobile.png') });
      }
      await row(key).getByRole('button').first().click();
    }
  });

  test('lists triggered rules for the shown period, explains them on click, and saves rules for every case', async ({ context, page }) => {
    const captured = await mockBackend(context);
    await login(page);
    await page.goto('/portal/planner-bench');
    const rules = page.locator('#bench-rules');
    const row = (key: string) => page.locator(`#bench-rule-${key}`);

    // Triggered rules are rows with their points per quarter and the quarters they fired in.
    // Energy timing is evidence in kronor: the quarters it would change, and no points.
    await expect(row('battery_price_spread')).toContainText(/2 (q|kv) · 1\.25 kr/);
    await expect(row('pool_low')).toContainText(/\d+ (q|kv) · −\d+/);
    // Flexible load in a very cheap quarter earns two points, in a cheap one a single point.
    // The price rules are measured and noted; they take and give no points.
    await expect(row('cheapest_buy')).toContainText(/\d+ (q|kv) · (noted|noteras)/);
    // The same load in a very dear quarter loses two; the explanation names flexible loads, not the devices.
    await expect(row('dearest_load')).toContainText(/\d+ (q|kv) · (noted|noteras)/);
    await row('dearest_load').getByRole('button').first().click();
    await expect(row('dearest_load')).toContainText(/Flexible loads together draw at least 500 W from the grid .* dearest 10 %|Flexibla laster drar tillsammans minst 500 W från nätet .* dyraste 10 %/);
    await row('dearest_load').getByRole('button').first().click();
    await expect(row('missed_cheap_quarter')).toContainText(/\d+ (q|kv) · (noted|noteras)/);
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
    await expect(row('battery_price_spread')).not.toContainText(/1\.25 kr/);
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
    expect(captured.dispatched[0]).toMatchObject({ shas: 'all' });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rules).toBeVisible();
    expect(await rules.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await rules.screenshot({ path: test.info().outputPath('rules-mobile.png') });
  });

  test('shows no points for a run from an older scorer and withholds its comparison and stale witnesses', async ({ context, page }) => {
    await mockBackend(context, { missingAudit: true });
    await login(page);
    await page.goto('/portal/planner-bench');
    await expect(page.locator('#bench-test-run')).toHaveText(/^dev · ddddddd · .* · (needs a rerun|behöver köras om)$/);
    await expect(page.locator('#bench-total-score')).toHaveCount(0);
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
    await page.getByRole('button', { name: /Save and run current planners|Spara och kör aktuella planerare/ }).click();

    await expect.poll(() => captured.inserted.length).toBe(1);
    const row = captured.inserted[0];
    expect(row).toMatchObject({ name: 'Cold morning', source_filename: 'plan-replay-test.json', captured_at: '2026-09-30T06:00:00.000Z' });
    const data = row.dataset as BenchScenarioData;
    // The moment is kept: known prices, corrected solar, devices the household does not plan as base load, readings.
    expect(data.known_prices.import_sek_per_kwh.filter(v => v !== null)).toHaveLength(72);
    expect(data.solar_forecast_w[0]).toBeCloseTo(800);
    expect(data.base_load_forecast_w[0]).toBe(700);
    expect(data.start_state).toEqual({ battery_soc: 0.42, pool_water_c: 28.4, pool_heater: { kind: 'off_unobserved' }, ev: { soc: 0.7, target_soc: 0.8 } });
    // Nothing of another planner's work or the replay's bulk is.
    expect(JSON.stringify(row)).not.toMatch(/secret|frozen|value_curves|xxxxxxxx/);
    await expect.poll(() => captured.dispatched.length).toBe(1);
    expect(captured.dispatched[0]).toMatchObject({ shas: 'all', scenario: '33333333-3333-4333-8333-333333333333' });
  });
});
