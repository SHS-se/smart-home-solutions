import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';

Deno.test('counter correction SQL is scoped, idempotent, preserves source facts and rejects stale or overlapping intervals', async () => {
  const db = new PGlite(), directory = await Deno.makeTempDir();
  const homeId = '11111111-1111-4111-8111-111111111111', customerId = '22222222-2222-4222-8222-222222222222';
  const start = '2026-08-31T08:30:00.000Z', end = '2026-08-31T12:15:00.000Z';
  const actual = Array.from({ length: 15 }, (_, i) => ({ start_ts: new Date(Date.parse(start) + i * 900_000).toISOString(),
    solar_production_kwh: i === 14 ? 9.21 : 0 }));
  const unrelated = { field: 'grid_import_kwh', start, end, kwh: 1, source: 'grid' };
  try {
    await Deno.writeTextFile(`${directory}/capture.json`, JSON.stringify({ homeId, customerId, actual,
      intervals: [{ field: 'solar_production_kwh', start, end, source: 'pv' }] }));
    const result = await new Deno.Command(Deno.execPath(), { args: ['run', '--allow-read', '--allow-write',
      'scripts/correct-roi-counter-intervals.ts', `${directory}/capture.json`, directory], stdout: 'null', stderr: 'piped' }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const sql = await Deno.readTextFile(`${directory}/correction.sql`);
    await db.exec(`CREATE TABLE energy_optimisation_actual_slots(home_id uuid,customer_id uuid,start_ts timestamptz,solar_production_kwh numeric);
      CREATE TABLE energy_roi_history_hours(home_id uuid,customer_id uuid,start_ts timestamptz,actual jsonb,imported_at timestamptz);`);
    for (const row of actual) await db.query('INSERT INTO energy_optimisation_actual_slots VALUES($1,$2,$3,$4)', [homeId, customerId, row.start_ts, row.solar_production_kwh]);
    for (let hour = 8; hour <= 12; hour++) {
      const at = `2026-08-31T${String(hour).padStart(2, '0')}:00:00Z`;
      await db.query('INSERT INTO energy_roi_history_hours VALUES($1,$2,$3,$4,NULL)', [homeId, customerId, at, { solar_production_kwh: 2, reported_intervals: [unrelated] }]);
    }
    await db.query('INSERT INTO energy_roi_history_hours VALUES($1,$2,$3,$4,NULL)', [customerId, customerId, start, { solar_production_kwh: 3 }]);
    const sourcesBefore = (await db.query('SELECT * FROM energy_optimisation_actual_slots ORDER BY start_ts')).rows;
    await db.exec(sql); await db.exec(sql);
    const corrected = (await db.query<{ actual: { solar_production_kwh: number; reported_intervals: object[] } }>('SELECT actual FROM energy_roi_history_hours WHERE home_id=$1', [homeId])).rows;
    assertEquals(corrected.length, 5);
    corrected.forEach(row => { assertEquals(row.actual.solar_production_kwh, 2); assertEquals(row.actual.reported_intervals.length, 2); assertEquals(row.actual.reported_intervals[0], unrelated); });
    assertEquals((await db.query('SELECT * FROM energy_optimisation_actual_slots ORDER BY start_ts')).rows, sourcesBefore);
    assertEquals((await db.query('SELECT actual FROM energy_roi_history_hours WHERE home_id=$1', [customerId])).rows, [{ actual: { solar_production_kwh: 3 } }]);
    await db.exec("UPDATE energy_optimisation_actual_slots SET solar_production_kwh=10 WHERE solar_production_kwh>0");
    await assertRejects(() => db.exec(sql), Error, 'Counter observations changed');
    await db.exec('ROLLBACK');
    await db.exec('UPDATE energy_optimisation_actual_slots SET solar_production_kwh=9.21 WHERE solar_production_kwh>0');
    await db.query("UPDATE energy_roi_history_hours SET actual=jsonb_set(actual,'{reported_intervals}',$1::jsonb) WHERE home_id=$2", [[{ ...unrelated, field: 'solar_production_kwh', end: '2026-08-31T12:00:00Z' }], homeId]);
    await assertRejects(() => db.exec(sql), Error, 'Overlapping stored correction');
    await db.exec('ROLLBACK');
  } finally { await db.close(); await Deno.remove(directory, { recursive: true }); }
});
