import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';

/** Stored status returned by this migration, independent of the removed editor. */
interface FixedPlanStatus {
  fixed_plan: { id: string; starts_at: string; ends_at: string } | null;
  revision: number;
  generated_revision: number;
  generated_fixed_plan_id: string | null;
  ha_ack_status: string;
  ha_ack_error: unknown;
  valid_until: string;
  error: string | null;
  pending: boolean;
}

interface CurrentEnergyRow {
  fixed_plan: FixedPlanStatus['fixed_plan'];
  fixed_plan_revision: number;
  fixed_plan_generation_revision: number;
  plan: { fixed_plan: { id: string } };
  ha_ack_status: string;
  ha_ack_error: unknown;
  replan_error: string | null;
  replan_request_id: string | null;
  replan_completed_request_id: string | null;
}

interface RoomTemperatureRow {
  room_key: string;
  room_temperature_c: number;
  start_ts: Date;
}

const home = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

Deno.test('narrow reads preserve status, latest temperatures, freshness and access isolation', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE energy_optimisation_current (
        home_id uuid, customer_id uuid, snapshot jsonb, plan jsonb, fixed_plan jsonb,
        fixed_plan_revision int, fixed_plan_generation_revision int, ha_ack_status text,
        ha_ack_error jsonb, valid_until timestamptz, replan_error text,
        replan_request_id uuid, replan_completed_request_id uuid);
      ALTER TABLE energy_optimisation_current ENABLE ROW LEVEL SECURITY;
      CREATE POLICY read_own ON energy_optimisation_current FOR SELECT TO authenticated
        USING (customer_id = current_setting('test.customer_id')::uuid);
      GRANT SELECT ON energy_optimisation_current TO authenticated, service_role;
      CREATE TABLE energy_optimisation_thermal_slots (
        home_id uuid, customer_id uuid, room_key text, room_temperature_c numeric, start_ts timestamptz,
        UNIQUE(home_id, room_key, start_ts));
      CREATE INDEX thermal_room_start ON energy_optimisation_thermal_slots(home_id, room_key, start_ts DESC);
      GRANT SELECT ON energy_optimisation_thermal_slots TO service_role;
    `);
    await db.exec(await Deno.readTextFile('supabase/migrations/20260912100000_narrow_energy_status_and_temperature_reads.sql'));
    const fixture = JSON.parse(await Deno.readTextFile('contracts/ha-api/fixtures/schema-6-dispatched-ev-plan.json'));
    await db.query(`INSERT INTO energy_optimisation_current VALUES
      ($1, $1, $3, $4, $5, 3, 2, 'accepted', null, '2026-09-14T08:00:00Z', null, $1, $2)`,
      [home, other, fixture.snapshot ?? {}, { ...fixture.plan, fixed_plan: { id: 'previous' } },
        { id: 'next', starts_at: '2026-09-12T08:00:00Z', ends_at: '2026-09-12T10:00:00Z', slots: fixture.plan.plans.priority.slots }]);
    await db.query(`INSERT INTO energy_optimisation_current(home_id, customer_id, plan)
      VALUES ($1, $1, '{"private":"other home"}')`, [other]);
    await db.exec(`SET test.customer_id = '${home}'; SET ROLE authenticated;`);
    const raw = (await db.query<CurrentEnergyRow>('SELECT * FROM energy_optimisation_current WHERE home_id=$1', [home])).rows[0];
    const status = async (id = home) => (await db.query<{ value: FixedPlanStatus | null }>(
      'SELECT get_energy_fixed_plan_status($1) AS value', [id])).rows[0].value;
    const slim = await status();
    assert(raw.fixed_plan);
    assertEquals(slim, {
      fixed_plan: { id: raw.fixed_plan.id, starts_at: raw.fixed_plan.starts_at, ends_at: raw.fixed_plan.ends_at },
      revision: raw.fixed_plan_revision, generated_revision: raw.fixed_plan_generation_revision,
      generated_fixed_plan_id: raw.plan.fixed_plan.id,
      ha_ack_status: raw.ha_ack_status, ha_ack_error: raw.ha_ack_error,
      valid_until: '2026-09-14T08:00:00+00:00', error: raw.replan_error,
      pending: raw.replan_request_id !== raw.replan_completed_request_id,
    });
    assert(JSON.stringify(slim).length < JSON.stringify(raw).length / 10);
    assertEquals(await status(other), null);
    await assertRejects(() => db.query('SELECT * FROM get_energy_latest_room_temperatures($1,$1,now())', [home]), Error, 'permission denied');
    await db.exec('RESET ROLE');
    await db.query(`UPDATE energy_optimisation_current SET fixed_plan='null', plan=null,
      replan_request_id=null, replan_completed_request_id=null WHERE home_id=$1`, [home]);
    const cleared = await status();
    assert(cleared);
    assertEquals(cleared.fixed_plan, null);
    assertEquals(cleared.generated_fixed_plan_id, null);
    assertEquals(cleared.pending, false);
    await db.query(`UPDATE energy_optimisation_current SET fixed_plan=null,
      replan_request_id=$1, replan_completed_request_id=$1 WHERE home_id=$1`, [home]);
    const completed = await status();
    assert(completed);
    assertEquals(completed.pending, false);
    // Twenty-four quarters per room: the old planner retained only the latest.
    await db.query(`INSERT INTO energy_optimisation_thermal_slots
      SELECT $1, $1, room, 20 + n/100.0, '2026-09-12T00:00:00Z'::timestamptz + n*interval '15 minutes'
      FROM unnest(ARRAY['bedroom','kitchen']) AS room CROSS JOIN generate_series(0,23) n`, [home]);
    await db.query(`INSERT INTO energy_optimisation_thermal_slots VALUES
      ($1,$1,'old-room',18,'2026-09-11T23:59:59Z'),
      ($2,$2,'kitchen',35,'2026-09-12T05:59:00Z')`, [home, other]);
    await db.exec('SET ROLE service_role');
    const oldRows = (await db.query<RoomTemperatureRow>(`SELECT room_key,room_temperature_c,start_ts
      FROM energy_optimisation_thermal_slots WHERE home_id=$1 AND start_ts >= $2 ORDER BY start_ts DESC`,
      [home, '2026-09-12T00:00:00Z'])).rows;
    const expected = new Map<string, RoomTemperatureRow>();
    for (const row of oldRows) if (!expected.has(row.room_key)) expected.set(row.room_key, row);
    const latest = (await db.query('SELECT * FROM get_energy_latest_room_temperatures($1,$1,$2)',
      [home, '2026-09-12T00:00:00Z'])).rows;
    assertEquals(latest, [...expected.values()].sort((a, b) => a.room_key.localeCompare(b.room_key)));
    assertEquals(oldRows.length, 48);
    assertEquals(latest.length, 2);
    assertEquals((await db.query('SELECT * FROM get_energy_latest_room_temperatures($1,$2,$3)',
      [home, other, '2026-09-12T00:00:00Z'])).rows, []);
    await db.exec('RESET ROLE; SET ROLE anon');
    await assertRejects(() => status(), Error, 'permission denied');
  } finally { await db.close(); }
});
