// Independently generated synthetic rooms; no household observations.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";

Deno.test("app room-map ownership preserves existing pairs and fences delayed publications", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.homes(id uuid PRIMARY KEY, customer_id uuid);
      CREATE FUNCTION public.can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE SCHEMA cron;
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE TABLE public.energy_optimisation_zone_models(home_id uuid,room_key text,trained boolean,passive_heat jsonb);
      CREATE SCHEMA private;
      CREATE TABLE private.energy_learning_jobs(id uuid);
    `);
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261117010000_save_room_connections_and_probe_observations.sql", import.meta.url)));
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261117110000_learn_room_doorway_exchange.sql", import.meta.url)));
    const home = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    const pair = { rooms: ["hall", "office"] };
    await db.query("INSERT INTO homes VALUES ($1,NULL),($2,NULL)", [home, other]);
    await db.query("INSERT INTO energy_room_profiles(home_id,rooms,connections) VALUES ($1,$2,$3)",
      [home, { hall: { name: "Hall", source_key: "a" }, office: { name: "Office", source_key: "b" } }, [{ ...pair, mode: "varies" }]]);
    await db.query("INSERT INTO energy_room_probe_slots VALUES ($1,'office','b','2026-11-17T08:00:00Z',20)", [home]);
    await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/20261126140000_app_owned_room_connections.sql", import.meta.url)));
    await db.exec("SET ROLE service_role");
    const read = async (id = home) => (await db.query<{ value: { connections: unknown[] } }>(
      "SELECT read_energy_room_connections($1) AS value", [id])).rows[0].value;
    assertEquals((await read()).connections, [{ ...pair, mode: "varies" }]);
    assertEquals((await read(other)).connections, []);
    const publish = async (revision: number, connections: unknown[], owner = "synthetic-app", id = home) =>
      (await db.query<{ value: unknown }>("SELECT publish_energy_room_connections($1,$2,$3,$4::jsonb) AS value",
        [id, owner, revision, JSON.stringify(connections)])).rows[0].value;
    const receipt = { owner: "synthetic-app", revision: 1, connections: [pair] };
    assertEquals(await publish(1, [pair]), receipt);
    const peers = async () => (await db.query("SELECT other_key FROM get_energy_doorway_probes($1,ARRAY['hall'],NULL,'2026-11-17T09:00:00Z')", [home])).rows;
    assertEquals(await peers(), [{ other_key: "office" }]);
    assertEquals(await publish(1, [{ rooms: ["office", "hall"] }]), receipt);
    assertEquals(await publish(2, []), { ...receipt, revision: 2, connections: [] });
    assertEquals(await peers(), []);
    await assertRejects(() => publish(1, [pair]), Error, "Newer app room connections");
    await assertRejects(() => publish(2, [pair]), Error, "revision");
    await assertRejects(() => publish(3, [pair], "another-app"), Error, "another app");
    await assertRejects(() => publish(3, [pair, { rooms: ["office", "hall"] }]), Error, "already listed");
    await assertRejects(() => publish(3, [{ rooms: ["hall", "hall"] }]), Error, "two different rooms");
    assertEquals((await read()).connections, []);
    assertEquals(await publish(3, [{ rooms: ["hall", "removed_room"] }]),
      { ...receipt, revision: 3, connections: [{ rooms: ["hall", "removed_room"] }] });
    assertEquals((await read(other)).connections, []);
    // Probe uploads preserve the replica and its deletion fence.
    await db.query("SELECT record_energy_room_observations($1,'{}','[]')", [home]);
    assertEquals((await read()).connections, [{ rooms: ["hall", "removed_room"] }]);
    await db.exec("SET ROLE authenticated");
    await assertRejects(() => publish(4, []), Error, "permission denied");
    await assertRejects(() => read(), Error, "permission denied");
    await assertRejects(() => db.query("SELECT set_energy_room_connections($1,0,'[]')", [home]), Error, "permission denied");
    const portal = (await db.query<{ value: { connections: unknown[] } }>(
      "SELECT get_energy_room_profile($1) AS value", [home])).rows[0].value;
    assertEquals(portal.connections, [{ rooms: ["hall", "removed_room"] }]);
  } finally {
    await db.close();
  }
});
