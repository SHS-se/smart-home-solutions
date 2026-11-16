import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";

Deno.test("room probe uploads preserve saved doorways and isolate each home", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.homes(id uuid PRIMARY KEY, customer_id uuid);
      CREATE FUNCTION public.can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql
        AS $$ SELECT $1 = current_setting('app.customer', true)::uuid $$;
      CREATE SCHEMA cron;
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    `);
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261117010000_save_room_connections_and_probe_observations.sql", import.meta.url)));

    const home = "00000000-0000-4000-8000-000000000001";
    const customer = "00000000-0000-4000-8000-000000000002";
    const otherHome = "00000000-0000-4000-8000-000000000003";
    const otherCustomer = "00000000-0000-4000-8000-000000000004";
    await db.query("INSERT INTO homes VALUES ($1,$2),($3,$4)", [home, customer, otherHome, otherCustomer]);
    await db.query("SELECT set_config('app.customer',$1,false)", [customer]);
    const rooms = { hall: { name: "Hall", source_key: "a".repeat(64) }, office: { name: "Office", source_key: null } };
    const record = async (slots: {room_key: string; start_ts: string; temperature_c: number}[]) => {
      const reply = await db.query<{ result: { connections: unknown[]; readings_written: number } }>(
        "SELECT record_energy_room_observations($1,$2::jsonb,$3::jsonb) AS result",
        [home, JSON.stringify(rooms), JSON.stringify(slots)],
      );
      return reply.rows[0].result;
    };
    const sample = [{ room_key: "hall", start_ts: "2026-11-17T08:00:00Z", temperature_c: 20 }];
    await db.exec("SET ROLE service_role");
    assertEquals((await record(sample)).readings_written, 1);
    assertEquals((await record(sample)).readings_written, 0);

    await db.exec("SET ROLE authenticated");
    const save = async (revision: number, connections: unknown[]) => {
      const reply = await db.query<{ revision: number }>(
        "SELECT set_energy_room_connections($1,$2,$3::jsonb) AS revision", [home, revision, JSON.stringify(connections)],
      );
      return reply.rows[0].revision;
    };
    const pair = { rooms: ["hall", "office"], mode: "varies" };
    assertEquals(await save(0, [pair]), 1);
    assertEquals(await save(0, [{ ...pair, rooms: ["office", "hall"] }]), 1);
    await assertRejects(() => save(0, []), Error, "changed");
    await assertRejects(() => save(1, [pair, { ...pair, rooms: ["office", "hall"] }]), Error, "already listed");
    await assertRejects(() => save(1, [{ ...pair, rooms: ["hall", "hall"] }]), Error, "two different rooms");
    await assertRejects(() => save(1, [{ ...pair, rooms: ["hall", "missing"] }]), Error, "no longer available");
    await assertRejects(() => db.query("SELECT get_energy_room_profile($1)", [otherHome]), Error, "access denied");
    await assertRejects(() => record([]), Error, "permission denied");

    await db.exec("SET ROLE service_role");
    assertEquals((await record([])).connections, [pair]);
    await db.exec("SET ROLE authenticated");
    const reply = await db.query<{ profile: { rooms: unknown[] } }>("SELECT get_energy_room_profile($1) AS profile", [home]);
    assertEquals(reply.rows[0].profile.rooms, [
      { key: "hall", name: "Hall", has_probe: true, latest: { start: "2026-11-17T08:00:00+00:00", temperature_c: 20 } },
      { key: "office", name: "Office", has_probe: false, latest: null },
    ]);
    assertEquals(await save(1, [{ ...pair, mode: "usually_open" }]), 2);
    assertEquals(await save(2, []), 3);
    await assertRejects(() => save(1, [pair]), Error, "changed");
    await db.exec("SET ROLE service_role");
    assertEquals((await record([])).connections, []);
  } finally {
    await db.close();
  }
});
