/** Independently generated synthetic evidence. No household forecasts or measured prices. */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { priceExperimentDb } from './helpers/price-experiment-db.ts';

const HOME = '11111111-1111-4111-8111-111111111111';
const STAFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUARTER = 900_000, HOUR = 3_600_000, DAY = 86_400_000;
const iso = (at: number) => new Date(at).toISOString();
const stockholmDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
const lead = (at: number, origin: number) => Math.round((Date.parse(stockholmDay.format(at)) - Date.parse(stockholmDay.format(origin))) / DAY);
type DB = Awaited<ReturnType<typeof priceExperimentDb>>;
interface Context { status: string; baselineId: string; truthCutoff: number; history: { start: string; price: number }[]; targets: string[]; weather: { id: string; sites: unknown[] } | null }
interface Score { lead_day: number; scored_quarters: number; reduced_mae: number; full_mae: number; day_wins: number; baseline_quarters: number; target_day_count: number }
interface Comparison { enabled: boolean; kind: string; holdout: { from: string; to: string } | null; report: { pair_count: number; scores: Score[]; days: unknown[]; pairs: { id: string; status: string; scored_count: number }[] };
  selected: { id: string; eligible_count: number; target_count: number } | null; targets: { reduced: number; full: number; actual: number | null }[] }

async function setup() {
  const db = await priceExperimentDb(HOME);
  await db.exec(await Deno.readTextFile('supabase/migrations/20261110100000_test_weather_price_experiment.sql'));
  return db;
}
async function enable(db: DB) {
  await db.query('SELECT private.enable_test_price_experiment($1)', [HOME]);
  await db.exec('SELECT private.enable_test_weather_price()');
}
/** A deployed forecast of 96 hours from its generation time; the first 30 hours were already published. */
async function baseline(db: DB, id: string, generated: number) {
  const first = Math.ceil(generated / QUARTER) * QUARTER;
  const starts = Array.from({ length: 384 }, (_, slot) => first + slot * QUARTER);
  await db.query('INSERT INTO energy_price_forecast_generations(id,home_id,generated_at,inputs,outlook) VALUES($1,$2,$3,$4,$5)', [id, HOME, iso(generated),
    { slot_starts: starts.map(iso), published_import_sek_per_kwh: starts.map((_, slot) => slot < 120 ? 1.5 : null) }, { shadowImportSekPerKwh: starts.map(() => 2) }]);
  return starts;
}
const ledger = (db: DB, start: number, price: number, recorded: number) => db.query(
  `INSERT INTO energy_test_price_observations(home_id,start_ts,import_price_sek_per_kwh,event,source,recorded_at) VALUES($1,$2,$3,'insert','integration',$4)`, [HOME, iso(start), price, iso(recorded)]);
const weather = (db: DB, id: string, recorded: number, pastDays = 28) => db.query(
  'INSERT INTO energy_market_forecast_observations(id,dataset,result,recorded_at) VALUES($1,$2,$3,$4)', [id, 'weather_medium_range',
    { status: 'data', request: { past_days: pastDays }, document: { sites: [{ grid: { latitude: 1 }, times: ['2026-01-01T00:00:00.000Z'],
      series: { wind_speed_10m: [1], wind_speed_120m: [5], temperature_2m: [2], shortwave_radiation: [0] } }] } }, iso(recorded)]);
const context = async (db: DB, tick: number | null) => (await db.query<{ value: Context }>('SELECT read_test_weather_price_context($1) value', [tick === null ? null : iso(tick)])).rows[0].value;
const record = async (db: DB, id: string, forecast: object) => (await db.query<{ value: { status: string; id?: string; kind?: string } }>('SELECT record_test_weather_price($1,$2) value', [id, forecast])).rows[0].value;
async function comparison(db: DB, kind: string, run: string | null = null) {
  await db.exec(`SET request.jwt.claim.sub='${STAFF}'`);
  return (await db.query<{ value: Comparison }>('SELECT get_test_weather_price_comparison($1,$2) value', [run, kind])).rows[0].value;
}
const forecast = (targets: string[], candidate: (start: string, index: number) => number | null, weatherId: string | null) => ({ algorithm: 'se3-weather-price-v1',
  status: 'forecast', reason: null, weatherObservationId: weatherId, trainingQuarters: 700, anchor: 0, targets: targets.map((start, index) => ({ start, candidate: candidate(start, index), reason: null })) });

Deno.test('applying the schema starts nothing: the study is disabled until TEST enables it', async () => {
  const db = await setup();
  try {
    assertEquals((await context(db, null)).status, 'disabled');
    assertEquals((await comparison(db, 'prospective')).enabled, false);
    assertEquals((await db.query('SELECT 1 FROM cron.jobs')).rows.length, 0);
    await enable(db);
    assertEquals((await db.query<{ schedule: string }>("SELECT schedule FROM cron.jobs WHERE name='test-energy-price-weather'")).rows[0].schedule, '50 */6 * * *');
    assertEquals((await context(db, null)).status, 'no_household_forecast');
  } finally { await db.close(); }
});

Deno.test('the context holds only what TEST had when the deployed forecast was generated', async () => {
  const db = await setup();
  try {
    await enable(db);
    const generated = Date.now() - 20 * 60_000, base = '21111111-1111-4111-8111-111111111111';
    const starts = await baseline(db, base, generated);
    const expected = starts.filter((start, slot) => slot >= 120 && [2, 3].includes(lead(start, generated)));
    await ledger(db, generated - 2 * DAY, 1, generated - 2 * DAY);
    await ledger(db, generated - 2 * DAY, 1.25, generated - DAY); // a revision known at the origin replaces the first value
    await ledger(db, generated - 40 * DAY, 9, generated - 39 * DAY); // older than the 28-day window
    await ledger(db, expected[0], 3, generated - HOUR); // the ledger already knew this quarter: not a target
    await ledger(db, expected[1], 3, generated + 60_000); // arrived after the forecast: still a target, never history
    await weather(db, '41111111-1111-4111-8111-111111111111', generated - 7 * HOUR);
    await weather(db, '42222222-2222-4222-8222-222222222222', generated - HOUR, 0); // newer, but without the training history
    await weather(db, '43333333-3333-4333-8333-333333333333', generated + 60_000); // acquired after the origin
    const frozen = await context(db, generated + 60_000);
    assertEquals(frozen.status, 'ready');
    assertEquals(frozen.baselineId, base);
    assertEquals(frozen.history.map(row => row.price), [1.25, 3]);
    assertEquals(frozen.targets.length, expected.length - 1);
    assert(!frozen.targets.some(start => Date.parse(start) === expected[0]) && frozen.targets.some(start => Date.parse(start) === expected[1]));
    assertEquals(frozen.weather?.id, '41111111-1111-4111-8111-111111111111');
    assertEquals(Object.keys((frozen.weather!.sites[0] as { series: object }).series).sort(), ['shortwave_radiation', 'temperature_2m', 'wind_speed_120m']);
    // No deployed forecast in the 30 minutes before a tick: nothing to compare with, so no forecast.
    assertEquals((await context(db, generated - 60_000)).status, 'no_household_forecast');
    await assertRejects(() => context(db, Date.now() + HOUR));
    await assertRejects(() => record(db, base, forecast(frozen.targets, () => 2.5, '43333333-3333-4333-8333-333333333333')), Error, 'not available at the forecast origin');
  } finally { await db.close(); }
});

Deno.test('a forecast saved before any target price is prospective, immutable, and scored on identical quarters as prices arrive', async () => {
  const db = await setup();
  try {
    await enable(db);
    const generated = Date.now() - 20 * 60_000, base = '21111111-1111-4111-8111-111111111111';
    await baseline(db, base, generated);
    await weather(db, '41111111-1111-4111-8111-111111111111', generated - HOUR);
    const frozen = await context(db, null);
    // The worker's own baseline or extra quarters are ignored; one quarter has no candidate.
    const saved = await record(db, base, forecast([...frozen.targets, iso(generated + 5 * DAY)], (_, index) => index === 0 ? null : 2.5, frozen.weather!.id));
    assertEquals([saved.status, saved.kind], ['forecast', 'prospective']);
    assertEquals((await record(db, base, forecast(frozen.targets, () => 9, null))).status, 'already_saved');
    assertEquals((await context(db, null)).status, 'already_saved');
    await assertRejects(() => db.query('UPDATE energy_test_weather_price_targets SET candidate=1'));
    await assertRejects(() => db.query('DELETE FROM energy_test_weather_price_runs'));
    let view = await comparison(db, 'prospective');
    assertEquals([view.report.pair_count, view.report.scores.length, view.selected!.target_count, view.selected!.eligible_count], [1, 0, frozen.targets.length, frozen.targets.length - 1]);
    assert(view.targets.every(row => row.reduced === 2 && row.full === 2.5 && row.actual === null));
    // Truth for every target arrives: deployed error 1, candidate error 0.5, one uncovered quarter reported as coverage.
    for (const start of frozen.targets) await ledger(db, Date.parse(start), 3, Date.now());
    view = await comparison(db, 'prospective');
    const total = view.report.scores.reduce((sum, score) => sum + score.scored_quarters, 0), covered = view.report.scores.reduce((sum, score) => sum + score.baseline_quarters, 0);
    assertEquals([total, covered], [frozen.targets.length - 1, frozen.targets.length]);
    for (const score of view.report.scores) {
      assertEquals([Number(score.reduced_mae), Number(score.full_mae), score.day_wins, score.target_day_count], [1, 0.5, 1, 1]);
    }
    assertEquals(view.report.pairs[0].scored_count, frozen.targets.length - 1);
    assertEquals((await comparison(db, 'replay')).report.pair_count, 0);
    await db.exec("SET request.jwt.claim.sub='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'");
    await assertRejects(() => db.query("SELECT get_test_weather_price_comparison(NULL,'prospective')"), Error, 'staff-only');
  } finally { await db.close(); }
});

Deno.test('a forecast computed after its target prices were published is recorded as a replay, with origin-time eligibility', async () => {
  const db = await setup();
  try {
    await enable(db);
    const generated = Date.now() - 5 * DAY, base = '21111111-1111-4111-8111-111111111111';
    const starts = await baseline(db, base, generated);
    for (const start of starts) await ledger(db, start, 3, start - DAY); // each quarter published a day ahead of delivery
    await weather(db, '41111111-1111-4111-8111-111111111111', generated - HOUR);
    const requested = (await db.query<{ value: number }>('SELECT private.replay_test_weather_price($1,$2) value', [iso(generated + 60_000), iso(generated + 60_000)])).rows[0].value;
    assertEquals(requested, 1);
    const frozen = await context(db, generated + 60_000);
    assert(frozen.targets.length > 0 && frozen.targets.every(start => Date.parse(start) - DAY > generated));
    const saved = await record(db, base, forecast(frozen.targets, () => 2.5, frozen.weather!.id));
    assertEquals(saved.kind, 'replay');
    assertEquals((await db.query<{ value: number }>('SELECT private.replay_test_weather_price($1,$2) value', [iso(generated + 60_000), iso(generated + 60_000)])).rows[0].value, 0);
    // Replay results are reported only for the fixed holdout delivery days; synthetic days count only if the clock puts them there.
    const view = await comparison(db, 'replay');
    const inHoldout = new Set(frozen.targets.filter(start => { const day = stockholmDay.format(Date.parse(start)); return day >= '2026-11-03' && day <= '2026-11-10'; })
      .map(start => lead(Date.parse(start), generated)));
    assertEquals([view.report.pair_count, view.report.scores.length, view.holdout], [1, inHoldout.size, { from: '2026-11-03', to: '2026-11-10' }]);
    assert(view.targets.every(row => row.actual === 3));
    assertEquals((await comparison(db, 'prospective')).report.pair_count, 0);
  } finally { await db.close(); }
});
