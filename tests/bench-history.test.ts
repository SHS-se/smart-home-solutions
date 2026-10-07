import { assertEquals } from '@std/assert';
import { completeCase } from '../bench/history.ts';
import { hasMeasuredOutcome, QUARTERS, QUARTER_MS } from '../src/lib/planner-bench/case.ts';
import { world } from '../src/lib/planner-bench/world.fixture.ts';

const source = { url: 'https://bench.invalid', key: 'test-key', homeId: 'home' };
const c = world();
const end = Date.parse(c.start) + QUARTERS * QUARTER_MS;

Deno.test('a measured case waits for its full window even when future prices and forecasts exist', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('No history read is needed before maturity'); };
  try {
    const result = await completeCase(source, c, end - 1);
    assertEquals(result.recorded, null);
    assertEquals(result.missing, 'measurement window ends 2026-09-27T00:00:00.000Z');
    assertEquals(calls, 0);
  } finally { globalThis.fetch = original; }
});

Deno.test('complete price and temperature data do not substitute forecasts for missing actuals', async () => {
  const original = globalThis.fetch;
  let actualsComplete = false;
  globalThis.fetch = input => {
    const url = new URL(String(input));
    if (url.searchParams.get('start_ts') !== `gte.${new Date(Date.parse(c.start)).toISOString()}`) return Promise.resolve(Response.json([]));
    const start = Number(url.searchParams.get('offset') ?? 0);
    const fields = url.pathname.endsWith('price_slots') ? { import_price_sek_per_kwh: 1, export_price_sek_per_kwh: 0.5 }
      : url.pathname.endsWith('outdoor_slots') ? { temperature_c: 20, solar_w_per_m2: 100 }
      : { total_load_kwh: 0.25, solar_production_kwh: 0.1, pool_heating_kwh: 0, ev_charging_kwh: 0 };
    const count = url.pathname.endsWith('actual_slots') && !actualsComplete ? QUARTERS - 1 : QUARTERS;
    return Promise.resolve(Response.json(start ? [] : Array.from({ length: count }, (_, i) => ({ start_ts: new Date(Date.parse(c.start) + i * QUARTER_MS).toISOString(), ...fields }))));
  };
  try {
    const waiting = await completeCase(source, c, end);
    assertEquals(waiting.recorded, null);
    assertEquals(waiting.missing, 'not yet recorded: complete measured load and solar');
    actualsComplete = true;
    const done = await completeCase(source, c, end);
    assertEquals(done.missing, null);
    assertEquals(done.recorded?.actual?.base_load_w, Array(QUARTERS).fill(1000));
    assertEquals(done.recorded?.actual?.solar_w, Array(QUARTERS).fill(400));
    assertEquals(hasMeasuredOutcome(done.recorded), true);
    assertEquals(hasMeasuredOutcome({ ...done.recorded!, synthetic_quarters: { prices: [1] } } as typeof done.recorded), false);
    assertEquals(hasMeasuredOutcome(c.recorded), false);
  } finally { globalThis.fetch = original; }
});
