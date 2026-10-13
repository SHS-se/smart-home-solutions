import { expect, type BrowserContext, type Page } from '../../playwright-fixture';
import { CALCULATION_VERSION, type SavedReport } from '../../src/lib/home-baseline/saved-months';
import { baselineFixture, testTariff } from '../../src/lib/home-baseline/fixture';
import { ROI_SUPPLIER_TERMS } from '../../supabase/functions/_shared/roi-supplier-terms';

/** Real native projection inputs, with sensor outages spanning May–August. */
export async function mockRoiHistory(context: BrowserContext, customerId: string, homeId: string, range = { from: '2026-09', to: '2026-10' }) {
  await context.addInitScript(({ key, range }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ ...range, subscription: '320' })); }, { key: `shs-savings-v1:${customerId}`, range });
  const fixture = baselineFixture(), windows: { start: string; end: string }[] = [];
  // Small stores and an insulated pool keep UI month tests cheap. Native physics
  // and optimizer behaviour use the full household in calculation tests.
  fixture.snapshot.device_physics!.battery!.capacity_kwh = .1;
  fixture.snapshot.device_physics!.pool!.store.capacity_kwh_per_c = 1;
  fixture.snapshot.device_physics!.pool!.store.loss = { kind: 'linear', kw_per_c: 0, surroundings_c: 20 };
  const catalogue = testTariff();
  const plans = catalogue.profiles[0].versions[0].definition.plans as Record<string, Record<string, unknown>>;
  plans.three_phase.demand = { top_n: 3, distinct_local_days: true, night_start_hour: 22, night_end_hour: 6, night_factor: .5, rate_sek_per_kw_ex_vat: 65 };
  let reads = 0, priceError = false;
  let reportedIntervals: import('../../src/lib/home-baseline/reported-energy-intervals').ReportedEnergyInterval[] = [];
  let report: SavedReport | null = null;
  await context.route('**/rest/v1/homes*', route => route.fulfill({ json: [{ id: homeId, name: 'Test home', customer_id: customerId, is_primary: true }] }));
  await context.route('**/rest/v1/rpc/get_energy_roi_criteria*', route => route.fulfill({ json: {} }));
  await context.route('**/rest/v1/energy_billing_documents*', route => route.fulfill({ json: ['05','06','07','08','09'].flatMap(month => ['electricity','grid'].map(kind => ({ id: `${month}:${kind}`, customer_id: customerId, document_kind: kind, period_start: `2026-${month}-01`, period_end: `2026-${month}-${['06','09'].includes(month) ? '30' : '31'}`, total_amount_sek: kind === 'electricity' ? 123 : 456, consumption_kwh: 100, exported_kwh: null, peak_demand_kw: null, file_path: null, energy_billing_line_items: [] }))) }));
  await context.route('**/rest/v1/energy_roi_solar_profiles*', route => route.fulfill({ json: null }));
  await context.route('**/rest/v1/energy_roi_pool_seeds*', route => route.fulfill({ json: null }));
  await context.route('**/rest/v1/energy_roi_pool_checkpoints*', route => route.fulfill({ json: [] }));
  await context.route('**/rest/v1/energy_roi_installations*', route => route.fulfill({ json: [
    { equipment: 'solar', installed_month: '2026-05' }, { equipment: 'battery', installed_month: '2026-05' },
    { equipment: 'bergvarme', installed_month: '2026-09' },
  ] }));
  await context.route('**/rest/v1/energy_roi_reports*', route => route.fulfill({ json: report }));
  await context.route('**/rest/v1/rpc/pin_energy_roi_report*', async route => {
    const body = route.request().postDataJSON();
    expect(body.p_home_id).toBe(homeId); expect(body.p_customer_id).toBe(customerId);
    expect(body.p_version).toBe(CALCULATION_VERSION);
    if (!report || body.p_expected_generation === report.generation) report = { generation: (report?.generation ?? 0) + 1, version: CALCULATION_VERSION, model: body.p_model, months: {}, checkpoints: {} };
    await route.fulfill({ json: report });
  });
  await context.route('**/rest/v1/rpc/save_energy_roi_month*', async route => {
    const body = route.request().postDataJSON();
    expect(body.p_home_id).toBe(homeId); expect(body.p_customer_id).toBe(customerId);
    expect(body.p_generation).toBe(report!.generation);
    expect(body.p_input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.p_ledger).not.toHaveProperty('series'); expect(body.p_ledger).not.toHaveProperty('commands');
    const month = body.p_ledger.month, old = report!.months[month];
    expect(body.p_expected_hash).toBe(old?.inputHash ?? null);
    report!.months[month] = { ledger: body.p_ledger, inputHash: body.p_input_hash, computedAt: new Date(Date.parse(fixture.end) + 900_000).toISOString() };
    await route.fulfill({ json: report });
  });
  await context.route('**/rest/v1/energy_roi_history_hours*', async route => {
    const url = new URL(route.request().url()); reads++;
    expect(url.searchParams.get('home_id')).toBe(`eq.${homeId}`);
    expect(url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    const filters = url.searchParams.getAll('start_ts'), from = filters.find(v => v.startsWith('gte.'))?.slice(4), to = filters.find(v => v.startsWith('lt.'))?.slice(3);
    const hours = new Map<string, typeof reportedIntervals>();
    for (const interval of reportedIntervals) for (let at = Math.floor(Date.parse(interval.start) / 3_600_000) * 3_600_000; at < Date.parse(interval.end); at += 3_600_000) {
      const stamp = new Date(at).toISOString();
      if (from && to && stamp >= from && stamp < to) hours.set(stamp, reportedIntervals);
    }
    await route.fulfill({ json: url.searchParams.get('select') === 'start_ts' ? null : [...hours].map(([start_ts, intervals]) => ({
      start_ts, actual: { reported_intervals: intervals }, device_energy_kwh: {}, pool_c: null, outdoor_c: null,
      baseline_load_kwh: null, sources: {}, invalid_readings: 0,
    })) });
  });
  await context.route('**/functions/v1/backfill-energy-prices*', async route => {
    const body = route.request().postDataJSON(); reads++;
    expect(body.mode).toBe('read'); expect(body.home_id).toBe(homeId);
    expect(body.pricing_basis).toBe('roi');
    expect(Date.parse(body.end) - Date.parse(body.start)).toBeLessThanOrEqual(32 * 86_400_000);
    if (priceError || body.start === '2026-03-31T22:00:00.000Z') {
      await route.fulfill({ status: 502, json: { message: `Missing historical market price at ${body.start}` } }); return;
    }
    const prices = baselineFixture({ start: body.start, end: body.end }).prices;
    prices.forEach(p => { p.source = 'reconstructed'; p.supplier_revision = ROI_SUPPLIER_TERMS.revision; });
    await route.fulfill({ json: { prices, actualPrices: prices.map(p => ({ start_ts: p.start_ts, import_price_sek_per_kwh: 2, export_price_sek_per_kwh: .3, source: 'invoice' })), area: 'SE3', catalogue } });
  });
  await context.route('**/rest/v1/energy_optimisation_*', async route => {
    const url = new URL(route.request().url()), table = url.pathname.split('/').pop(), select = url.searchParams.get('select') ?? '';
    if (table === 'energy_optimisation_current') {
      if (select.includes('captured_at:snapshot')) { reads++; await route.fulfill({ json: fixture.snapshot }); }
      else await route.fallback();
      return;
    }
    if (table === 'energy_optimisation_devices') { reads++; await route.fulfill({ json: [...fixture.devices, { id: 'household-id', device_key: 'household', name: 'Other appliances' }] }); return; }
    if (!['energy_optimisation_actual_slots', 'energy_optimisation_pool_slots'].includes(table!)) { await route.fallback(); return; }
    reads++;
    expect(url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    expect(url.searchParams.get('home_id')).toBe(`eq.${homeId}`);
    const filters = url.searchParams.getAll('start_ts'), from = filters.find(v => v.startsWith('gte.'))?.slice(4), end = filters.find(v => v.startsWith('lt.'))?.slice(3), before = filters.find(v => v.startsWith('lte.'))?.slice(4);
    expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(1000);
    if (select === 'start_ts') { await route.fulfill({ json: { start_ts: url.searchParams.get('order')?.includes('desc') ? fixture.actual.at(-1)!.start_ts : '2026-04-30T22:00:00.000Z' } }); return; }
    if (select === 'start_ts,ev_soc') { await route.fulfill({ json: before! < '2026-08-31T21:45:00.000Z' ? null : { start_ts: before, ev_soc: .79 } }); return; }
    if (table === 'energy_optimisation_pool_slots') { await route.fulfill({ json: from! < '2026-08-31T21:45:00.000Z' ? [] : [{ start_ts: from, water_temperature_c: 31 }] }); return; }
    const rows = baselineFixture({ start: new Date(Date.parse(from!) + 900_000).toISOString(), end: end! }).actual;
    // A daily SOC decline exercises withdrawals; midnight charging gains are discarded.
    // Starts remain missing, with one genuine in-period SOC gap per day.
    rows.forEach(row => {
      const hour = new Date(row.start_ts).getUTCHours();
      row.ev_soc = hour < 17 ? .8 : .795;
      if (row.start_ts < '2026-08-31T21:45:00.000Z') { row.battery_soc = null; if (hour === 12) row.ev_soc = null; }
    });
    rows.filter(row => row.start_ts >= '2026-08-31T22:00:00.000Z' && row.start_ts < '2026-09-30T22:00:00.000Z').forEach(row => { row.grid_import_kwh = 1; row.battery_discharge_kwh = .1; row.solar_production_kwh = .05; });
    const offline = rows.find(row => row.start_ts === '2026-08-31T22:00:00.000Z');
    if (offline) { offline.total_load_kwh = null; offline.solar_production_kwh = null; offline.grid_import_kwh = null; }
    await route.fulfill({ json: rows });
  });
  await context.route('**/rest/v1/rpc/get_energy_optimisation_device_slots*', async route => {
    reads++; const request = route.request().postDataJSON(), period = { start: request.p_from, end: request.p_to };
    expect(request.p_customer_id).toBe(customerId); expect(request.p_home_id).toBe(homeId);
    expect(Date.parse(period.end) - Date.parse(period.start)).toBeLessThanOrEqual(7 * 86_400_000);
    windows.push(period);
    const rows = baselineFixture(period).deviceSlots;
    rows.filter(row => row.start_ts >= '2026-08-31T22:00:00.000Z' && row.start_ts < '2026-09-30T22:00:00.000Z').forEach(row => { delete row.device_energy_kwh['heater-id']; row.device_energy_kwh['household-id'] = .25; });
    await route.fulfill({ json: rows });
  });
  return { fixture, windows, reads: () => reads, saved: () => report, failPrices: () => { priceError = true; }, correctIntervals: (intervals: typeof reportedIntervals) => { reportedIntervals = intervals; } };
}

/** Six real monthly projections can exceed a single-control wait on CI's shared CPUs. */
export async function expectRoiMonths(page: Page, expected: string, timeout = 360_000) {
  try { await expect(page.getByTestId('scheduler-totals')).toContainText(expected, { timeout }); }
  catch (error) {
    console.error('Monthly comparison at failure:', await page.getByTestId('scheduler-months').innerText());
    throw error;
  }
}
