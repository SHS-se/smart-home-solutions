import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assert, assertEquals, assertRejects } from '@std/assert';

const HOME = '11111111-1111-4111-8111-111111111111';
Deno.test('device colours are assigned once, unique beyond the palette, immutable and retained on inventory updates', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE energy_optimisation_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), home_id uuid NOT NULL, device_key text NOT NULL,
        name text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
        planning_role_override text, UNIQUE(home_id, device_key));
      INSERT INTO energy_optimisation_devices(home_id,device_key,name,retired_at) VALUES
        ('${HOME}', 'guest', 'Guest bedroom heater', null), ('${HOME}', 'retired', 'Retired heater', now());`);
    const migration = await Deno.readTextFile('supabase/migrations/20261023182000_persistent_device_colours.sql');
    await db.exec(migration.split('-- Portal device transport:')[0]);
    const colours = async () => (await db.query<{ device_key: string; colour: string }>(
      'SELECT device_key,colour FROM energy_optimisation_devices WHERE home_id=$1 ORDER BY device_key', [HOME])).rows;
    const before = await colours();
    assertEquals(before.length, 2);
    assert(before.every(device => /^#[0-9a-f]{6}$/.test(device.colour)));
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,device_key,name)
      SELECT $1, 'device-' || i, 'Device ' || i FROM generate_series(1,100) i`, [HOME]);
    const all = await colours();
    assertEquals(new Set(all.map(device => device.colour)).size, 102);
    for (const device of before) assertEquals(all.find(row => row.device_key === device.device_key)?.colour, device.colour);
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,device_key,name) VALUES ($1,'guest','Renamed guest')
      ON CONFLICT(home_id,device_key) DO UPDATE SET name=excluded.name, colour=excluded.colour`, [HOME]);
    await db.query(`UPDATE energy_optimisation_devices SET retired_at=now(), planning_role_override='base_load' WHERE device_key='guest'`);
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,device_key,name) VALUES ($1,'guest','Returned guest')
      ON CONFLICT(home_id,device_key) DO UPDATE SET name=excluded.name, retired_at=null`, [HOME]);
    assertEquals(await colours(), all);
    await assertRejects(() => db.query("UPDATE energy_optimisation_devices SET colour='#123456' WHERE device_key='guest'"), Error, 'immutable');
    await assertRejects(() => db.query(`INSERT INTO energy_optimisation_devices(home_id,device_key,name,colour) VALUES ($1,'supplied','Bad','#123456')`, [HOME]), Error, 'assigned by the catalogue');
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,device_key,name) VALUES ('22222222-2222-4222-8222-222222222222','guest','Other home')`);
    assertEquals((await db.query<{ colour: string }>("SELECT colour FROM energy_optimisation_devices WHERE name='Other home'")).rows[0].colour, before[0].colour);
    await db.exec('SET ROLE authenticated');
    await assertRejects(() => db.query('SELECT next_energy_device_colour($1)', [HOME]), Error, 'permission denied');
  } finally { await db.close(); }
});
