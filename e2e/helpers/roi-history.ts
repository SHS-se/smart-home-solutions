import { expect, type BrowserContext, type Page } from '../../playwright-fixture';
import { baselineFixture } from '../../src/lib/home-baseline/fixture';

/** Real native projection inputs, with sensor outages spanning May–August. */
export async function mockRoiHistory(context: BrowserContext, customerId: string, homeId: string) {
  const fixture = baselineFixture(), windows: { start: string; end: string }[] = [];
  let reads = 0, priceError = false;
  await context.route('**/rest/v1/energy_roi_history_hours*', async route => {
    const url = new URL(route.request().url()); reads++;
    expect(url.searchParams.get('home_id')).toBe(`eq.${homeId}`);
    expect(url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    await route.fulfill({ json: url.searchParams.get('select') === 'start_ts' ? null : [] });
  });
  await context.route('**/functions/v1/backfill-energy-prices*', async route => {
    const body = route.request().postDataJSON(); reads++;
    expect(body.mode).toBe('read'); expect(body.home_id).toBe(homeId);
    expect(Date.parse(body.end) - Date.parse(body.start)).toBeLessThanOrEqual(32 * 86_400_000);
    if (priceError || body.start === '2026-03-31T22:00:00.000Z') {
      await route.fulfill({ status: 502, json: { message: `Missing historical market price at ${body.start}` } }); return;
    }
    const prices = baselineFixture({ start: body.start, end: body.end }).prices;
    prices.filter(p => p.start_ts < '2026-08-01T00:00:00Z').forEach(p => { p.source = 'reconstructed'; p.supplier_revision = 'test_assumed'; });
    await route.fulfill({ json: { prices, area: 'SE3' } });
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
    rows.filter(row => row.start_ts < '2026-08-31T21:45:00.000Z').forEach(row => { row.battery_soc = null; row.ev_soc = null; });
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
  return { fixture, windows, reads: () => reads, failPrices: () => { priceError = true; } };
}

/** Six real monthly projections can exceed a single-control wait on CI's shared CPUs. */
export async function expectRoiMonths(page: Page, expected: string) {
  try { await expect(page.getByTestId('scheduler-totals')).toContainText(expected, { timeout: 60_000 }); }
  catch (error) {
    console.error('Monthly comparison at failure:', await page.getByTestId('scheduler-months').innerText());
    throw error;
  }
}
