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
      CREATE TABLE public.energy_optimisation_zone_models(home_id uuid, room_key text, trained boolean, passive_heat jsonb);
      CREATE SCHEMA private;
      CREATE TABLE private.energy_learning_jobs(id uuid);
      CREATE SCHEMA cron;
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    `);
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261117010000_save_room_connections_and_probe_observations.sql", import.meta.url)));
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261117110000_learn_room_doorway_exchange.sql", import.meta.url)));
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261117135500_read_room_model_scenario.sql", import.meta.url)));

    const home = "00000000-0000-4000-8000-000000000001";
    const customer = "00000000-0000-4000-8000-000000000002";
    const otherHome = "00000000-0000-4000-8000-000000000003";
    const otherCustomer = "00000000-0000-4000-8000-000000000004";
    await db.query("INSERT INTO homes VALUES ($1,$2),($3,$4)", [home, customer, otherHome, otherCustomer]);
    await db.query("SELECT set_config('app.customer',$1,false)", [customer]);
    const rooms: Record<string, { name: string; source_key: string | null }> = { hall: { name: "Hall", source_key: "a".repeat(64) }, office: { name: "Office", source_key: null } };
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
    await db.exec("SET ROLE service_role");
    rooms.office.source_key = "b".repeat(64);
    const office = { ...sample[0], room_key: "office", temperature_c: 23 };
    await record([office]);
    const connected = (from: string | null, to: string) => db.query<{ quarters: number[][] }>(
      "SELECT quarters FROM get_energy_doorway_probes($1,$2,$3,$4)", [home, ["hall"], from, to],
    );
    const stamp = Date.parse(office.start_ts);
    assertEquals((await connected(null, "2026-11-17T08:15:00Z")).rows, [{ quarters: [[stamp, 23]] }]);
    assertEquals((await connected("2026-11-17T08:00:00Z", "2026-11-17T08:15:00Z")).rows,
      [{ quarters: [[stamp, 23, 20]] }]);
    await db.exec("RESET ROLE");
    await db.query("INSERT INTO energy_optimisation_zone_models(home_id,room_key,trained,doorway_exchange) VALUES ($1,'hall',true,$2),($1,'office',true,NULL)",
      [home, JSON.stringify({ source: rooms.hall.source_key, peers: [
        { key: "office", source: rooms.office.source_key, weight: .08, usual: 1, persistence: .9 },
      ] })]);
    const scenario = async (key: string, homeId = home) => (await db.query<{
      value: { room: unknown; connections: { key: string; name: string; model: unknown; doorway: unknown }[] };
    }>("SELECT get_energy_room_model_scenario($1,$2) AS value", [homeId, key])).rows[0].value;
    await db.exec("SET ROLE authenticated");
    await assertRejects(() => scenario("office", otherHome), Error, "access denied");
    const impact = (await scenario("office")).connections[0];
    assertEquals(impact, {
      key: "hall", name: "Hall", doorway: { weight: .08, usual: 1 },
      model: { home_id: home, room_key: "hall", trained: true },
    });
    assertEquals((await scenario("hall")).connections[0].doorway, null);
    await db.exec("SET ROLE service_role");
    rooms.office.source_key = "c".repeat(64);
    await record([]);
    assertEquals((await connected(null, "2026-11-17T08:15:00Z")).rows, [{ quarters: [] }]);
    await db.exec("SET ROLE authenticated");
    assertEquals((await scenario("office")).connections[0].doorway, null);
    assertEquals(await save(1, [{ ...pair, mode: "usually_open" }]), 2);
    assertEquals(await save(2, []), 3);
    assertEquals((await scenario("office")).connections, []);
    await assertRejects(() => save(1, [pair]), Error, "changed");
    await db.exec("SET ROLE service_role");
    assertEquals((await record([])).connections, []);
    assertEquals((await connected(null, "2026-11-17T08:15:00Z")).rows, []);
  } finally {
    await db.close();
  }
});
