import { PGlite } from "@electric-sql/pglite";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { qualifyRoomOperationEvidence, type RoomOperationFact } from "./operation-evidence.ts";

const fact: RoomOperationFact = { id: "synthetic-fact", kind: "heating_off_fan", basis: "customer_assertion",
  from_at: "2025-11-01T00:00:00Z", to_at: "2025-11-01T02:00:00Z" };

Deno.test("dated operation knowledge preserves observed fan, unknown mode and missing meter facts", () => {
  const observations = [true, null, false].map((cooling, i) => ({
    start_ts: `2025-11-01T00:${String(i * 15).padStart(2, "0")}:00Z`, duration_s: 900,
    cooling, heat_w: i === 1 ? null : 12,
  }));
  const original = structuredClone(observations);
  const actual = qualifyRoomOperationEvidence(observations, [fact]);
  assertEquals(actual, observations.map(row => ({ ...row, operation_fact: fact.id })));
  assertEquals(observations, original);
  actual[0].heat_w = 99;
  assertEquals(observations, original);
});

Deno.test("operation knowledge covers whole native intervals and has exclusive end bounds", () => {
  const observations = [
    { start_ts: "2025-10-31T23:45:00Z", duration_s: 900, cooling: null },
    { start_ts: "2025-11-01T00:00:00Z", duration_s: 3600, cooling: null },
    { start_ts: "2025-11-01T01:00:00Z", duration_s: 3600, cooling: null },
    { start_ts: "2025-11-01T01:15:00Z", duration_s: 3600, cooling: null },
    { start_ts: "2025-11-01T01:45:00Z", cooling: true },
    { start_ts: "2025-11-01T02:00:00Z", duration_s: 900, cooling: false },
  ];
  assertEquals(qualifyRoomOperationEvidence(observations, [fact]).map(row => row.operation_fact ?? null),
    [null, fact.id, fact.id, null, fact.id, null]);
});

Deno.test("operation evidence is recomputed after a fact withdrawal without retaining stale derived claims", () => {
  const observations = [{ start_ts: "2025-11-01T00:00:00Z", cooling: null }];
  const qualified = qualifyRoomOperationEvidence(observations, [fact]);
  assertEquals(qualified[0].operation_fact, fact.id);
  assertEquals(qualifyRoomOperationEvidence(qualified, []), observations);
});

Deno.test("invalid interval time cannot acquire operation evidence and malformed facts fail explicitly", () => {
  const observations = [{ start_ts: "unavailable", cooling: null }];
  assertEquals(qualifyRoomOperationEvidence(observations, [fact]), observations);
  assertThrows(() => qualifyRoomOperationEvidence(observations, [{ ...fact, to_at: fact.from_at }]));
  assertThrows(() => qualifyRoomOperationEvidence(observations, [{ ...fact, from_at: "unknown" }]));
});

Deno.test("operation fact SQL fences the owning refit and preserves accepted bands and source boundaries", async () => {
  const db = new PGlite();
  // Independent synthetic ownership context. The migration under test runs
  // unchanged, including its RLS, RPC, triggers and immutable fact identity.
  const home = "11111111-1111-4111-8111-111111111111", customer = "22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA private;
      CREATE TABLE public.customers(id uuid PRIMARY KEY);
      CREATE TABLE public.homes(id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES customers);
      CREATE FUNCTION public.energy_home_matches_customer(h uuid,c uuid) RETURNS boolean LANGUAGE sql AS
        $$SELECT EXISTS(SELECT FROM homes WHERE id=h AND customer_id=c)$$;
      CREATE TABLE private.contexts(home_id uuid,room_key text,binding text);
      CREATE FUNCTION private.energy_room_heating_contexts(h uuid,history boolean DEFAULT false)
      RETURNS TABLE(room_key text,binding text,observed_since timestamptz) LANGUAGE sql AS
        $$SELECT room_key,binding,NULL::timestamptz FROM private.contexts WHERE home_id=h$$;
      CREATE TABLE private.energy_learning_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),home_id uuid,customer_id uuid,
        owner_kind text,owner_key text,input jsonb,generation bigint DEFAULT 1,fence bigint DEFAULT 0,pending boolean DEFAULT true,
        lease_until timestamptz,wake_after timestamptz DEFAULT now(),attempts integer DEFAULT 0,last_error text,finished_at timestamptz,
        UNIQUE(home_id,owner_kind,owner_key));
      CREATE TABLE private.wakes(job_id uuid);
      CREATE FUNCTION private.wake_energy_learning_job(j uuid) RETURNS void LANGUAGE sql AS
        $$INSERT INTO private.wakes VALUES(j)$$;
      CREATE TABLE energy_optimisation_zone_models(home_id uuid,room_key text,heating_bands jsonb,last_attempted_at timestamptz,
        model_revision bigint NOT NULL DEFAULT 1,PRIMARY KEY(home_id,room_key));
      CREATE FUNCTION private.advance_device_model_revision() RETURNS trigger LANGUAGE plpgsql AS
        $$BEGIN NEW.model_revision:=OLD.model_revision+1; RETURN NEW; END$$;
      CREATE TRIGGER zone_model_revision BEFORE UPDATE ON energy_optimisation_zone_models
        FOR EACH ROW EXECUTE FUNCTION private.advance_device_model_revision();
      INSERT INTO customers VALUES('${customer}');
      INSERT INTO homes VALUES('${home}','${customer}');
      INSERT INTO private.contexts VALUES('${home}','synthetic-room','binding-a');
    `);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261120001000_room_operation_facts.sql"));
    const accepted = { active: [{ revision: "retained" }], reference: { revision: "retained-reference" },
      window_attempts: { autumn: "completed" }, general_attempt: { implementation: "previous" } };
    await db.query("INSERT INTO energy_optimisation_zone_models(home_id,room_key,heating_bands,last_attempted_at) VALUES($1,'synthetic-room',$2,now())",
      [home, accepted]);
    await db.query("INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input,pending) VALUES($1,$2,'room','synthetic-room',$3,false)",
      [home, customer, { location: { latitude: 1, longitude: 2 } }]);
    const insert = async (binding: string) => (await db.query<{ id: string }>(`
      INSERT INTO private.energy_room_operation_facts(home_id,customer_id,room_key,binding,from_at,to_at,basis)
      VALUES($1,$2,'synthetic-room',$3,'2025-11-01','2026-04-01','customer_assertion') RETURNING id`, [home, customer, binding])).rows[0].id;
    const read = async (c = customer) => (await db.query("SELECT * FROM get_energy_room_operation_facts($1,$2,'synthetic-room','2025-11-01','2026-04-01')", [home, c])).rows;
    const first = await insert("binding-a");
    const state = (await db.query<{ heating_bands: Record<string, unknown>; model_revision: number }>(
      "SELECT heating_bands,model_revision FROM energy_optimisation_zone_models")).rows[0];
    assertEquals(state.heating_bands, { active: accepted.active, reference: accepted.reference, pending_windows: 1 });
    assertEquals(state.model_revision, 2);
    const job = (await db.query<{ pending: boolean; generation: number; fence: number; input: object }>(
      "SELECT pending,generation,fence,input FROM private.energy_learning_jobs")).rows[0];
    assertEquals(job, { pending: true, generation: 2, fence: 1, input: { location: { latitude: 1, longitude: 2 } } });
    assertEquals((await read()).length, 1);
    await assertRejects(() => db.query("UPDATE private.energy_room_operation_facts SET to_at='2026-05-01' WHERE id=$1", [first]),
      Error, "Replace an operation fact");
    await assertRejects(() => read("33333333-3333-4333-8333-333333333333"), Error, "Home mismatch");
    await db.exec("UPDATE private.contexts SET binding='binding-b'");
    assertEquals(await read(), []);
    await db.query("DELETE FROM private.energy_room_operation_facts WHERE id=$1", [first]);
    assertEquals((await db.query("SELECT generation FROM private.energy_learning_jobs")).rows, [{ generation: 2 }]);
    const second = await insert("binding-b");
    await db.query("DELETE FROM private.energy_room_operation_facts WHERE id=$1", [second]);
    assertEquals((await db.query("SELECT generation FROM private.energy_learning_jobs")).rows, [{ generation: 4 }]);
    assertEquals((await db.query("SELECT count(*)::integer n FROM private.wakes")).rows, [{ n: 3 }]);
    const privileges = (await db.query(`SELECT
      has_table_privilege('service_role','private.energy_room_operation_facts','SELECT') AS direct_read,
      has_function_privilege('anon','public.get_energy_room_operation_facts(uuid,uuid,text,timestamptz,timestamptz)','EXECUTE') AS anon_read,
      has_function_privilege('service_role','public.get_energy_room_operation_facts(uuid,uuid,text,timestamptz,timestamptz)','EXECUTE') AS service_read`)).rows;
    assertEquals(privileges, [{ direct_read: false, anon_read: false, service_read: true }]);
    await insert("binding-b");
    await db.query("DELETE FROM homes WHERE id=$1", [home]);
    assertEquals((await db.query("SELECT count(*)::integer n FROM private.energy_room_operation_facts")).rows, [{ n: 0 }]);
    // Cascade cleanup must not enqueue another job against the removed home.
    assertEquals((await db.query("SELECT count(*)::integer n FROM private.wakes")).rows, [{ n: 4 }]);
  } finally { await db.close(); }
});
