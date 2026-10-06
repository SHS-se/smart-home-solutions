import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "jsr:@std/assert@1";

Deno.test("planning archive returns every exact ordered raw row beyond one REST page", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE energy_optimisation_price_slots (
        home_id uuid, start_ts timestamptz, import_price_sek_per_kwh numeric,
        export_price_sek_per_kwh numeric, source text);
      GRANT SELECT ON energy_optimisation_price_slots TO service_role, anon, authenticated;
      INSERT INTO energy_optimisation_price_slots
        SELECT '11111111-1111-4111-8111-111111111111',
               '2026-08-01'::timestamptz + i * interval '15 minutes',
               (i % 29 - 14)::numeric / 7, 0.1, 'snapshot'
        FROM generate_series(6000,0,-1) AS i;
      INSERT INTO energy_optimisation_price_slots VALUES
        ('22222222-2222-4222-8222-222222222222','2026-08-01',99,0.1,'integration');
    `);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261006184500_read_planning_price_archive_once.sql"));
    const home = "11111111-1111-4111-8111-111111111111";
    const from = "2026-08-02";
    const expected = await db.query("SELECT start_ts,import_price_sek_per_kwh FROM energy_optimisation_price_slots WHERE home_id=$1 AND start_ts >= $2 ORDER BY start_ts", [home, from]);
    const reference = expected.rows.map((row: { start_ts: Date; import_price_sek_per_kwh: string }) => ({
      start_ts: row.start_ts.toISOString(), import_price_sek_per_kwh: Number(row.import_price_sek_per_kwh),
    }));
    await db.exec("SET ROLE service_role");
    const read = async (id: string) => (await db.query<{ archive: { start_ts: string; import_price_sek_per_kwh: number }[] }>(
      "SELECT read_energy_planning_price_archive($1,$2) AS archive", [id, from],
    )).rows[0].archive;
    const actual = await read(home);
    assertEquals(actual.length, 5905);
    assertEquals(actual.map(row => ({ ...row, start_ts: new Date(row.start_ts).toISOString() })), reference);
    assertEquals(await read("33333333-3333-4333-8333-333333333333"), []);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await assertRejects(() => read(home), Error, "permission denied");
    }
  } finally {
    await db.close();
  }
});
