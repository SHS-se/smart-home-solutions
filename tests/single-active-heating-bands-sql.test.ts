import { PGlite } from "@electric-sql/pglite";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { canonicalHeatingBands, type HeatingBandRevision } from "../supabase/functions/_shared/planner/heating-bands.ts";

// Independent synthetic metadata exercises storage and selection, not household observations.
const home = "10000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const migration = "supabase/migrations/20261122180000_one_active_heating_revision_per_band.sql";
const point = (n: number, extra: Partial<HeatingBandRevision> = {}) => ({
  revision: uuid(n), band_c: 0, observed_min_c: 1, observed_max_c: 2,
  training_from: "2025-01-01", training_to: "2025-01-10", ...extra,
});
const supported = { run_calibration: { policy: "recent_independent_runs_v1", fitted_runs: 3 } };
const groups = [
  [point(1,{observed_min_c:0,observed_max_c:4,training_to:"2026-01-10"}),point(2,{learning_evidence:supported})],
  [point(3,{fitted_at:"2026-01-11T12:00:00+01:00"}),point(4,{fitted_at:"2026-01-11T11:30:00Z"})],
  [point(5),point(6,{training_to:"2026-01-10"})],
  [point(7),point(8)],
  [point(9,{learning_evidence:{run_calibration:{...supported.run_calibration,fitted_runs:3.5}}}),
    point(10,{learning_evidence:supported})],
  [point(11),point(12,{training_from:"2025-01-02"})],
];

Deno.test("one active heating band migration preserves history, matches runtime preference and fences old publications", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA private;
      CREATE TABLE homes(id uuid PRIMARY KEY); INSERT INTO homes VALUES('${home}');
      CREATE TABLE energy_optimisation_zone_models(home_id uuid,customer_id uuid,room_key text,trained boolean,
        heating_bands jsonb,model_revision bigint DEFAULT 1,PRIMARY KEY(home_id,room_key));
      CREATE TABLE energy_optimisation_device_operating_points(home_id uuid,customer_id uuid,device_key text,
        operating_points jsonb,model_revision bigint DEFAULT 1,PRIMARY KEY(home_id,device_key));
      CREATE TABLE energy_optimisation_pool_model(home_id uuid PRIMARY KEY,model_revision bigint);
      CREATE TABLE private.energy_learning_jobs(id uuid PRIMARY KEY,home_id uuid,customer_id uuid,owner_kind text,
        owner_key text,pending boolean,generation bigint,fence bigint,lease_until timestamptz,wake_after timestamptz,
        last_error text,finished_at timestamptz);
      CREATE FUNCTION private.energy_room_heating_contexts(uuid) RETURNS TABLE(room_key text,binding text)
        LANGUAGE sql AS $$ SELECT room_key,'synthetic-binding'::text FROM energy_optimisation_zone_models WHERE home_id=$1 $$;`);
    const lifecycle = await Deno.readTextFile("supabase/migrations/20261026001000_device_learning_lifecycle.sql");
    const begin = lifecycle.indexOf("CREATE FUNCTION private.advance_device_model_revision()");
    await db.exec(lifecycle.slice(begin,lifecycle.indexOf("CREATE TABLE private.energy_learning_jobs")));
    await db.exec(`CREATE TRIGGER device_operating_points_revision BEFORE UPDATE ON energy_optimisation_device_operating_points
      FOR EACH ROW EXECUTE FUNCTION private.advance_device_model_revision();`);
    const original = await Deno.readTextFile("supabase/migrations/20261118120000_version_heating_bands.sql");
    await db.exec(original.slice(original.indexOf("CREATE TABLE private.energy_heating_calibration_revisions"),
      original.indexOf("-- Hash the room")));
    for (const [i,group] of groups.entries()) {
      const active = [...group,point(100+i,{band_c:-10,observed_min_c:-9,observed_max_c:-8})];
      const library = { binding:"synthetic-binding",active,reference_revision:uuid(200+i),reference:{model:{gain_c_per_wh:.002}} };
      await db.query("INSERT INTO energy_optimisation_zone_models VALUES($1,$1,$2,true,$3,1)",[home,`room-${i}`,JSON.stringify(library)]);
      await db.query("INSERT INTO energy_optimisation_device_operating_points VALUES($1,$1,$2,$3,1)",
        [home,`heater-${i}`,JSON.stringify({method:"weather_heating_draw_v1",binding:"synthetic-binding",versioned:{},
          points:active,reference:{revision:uuid(300+i),points:[]}})]);
    }
    const unrelated = {method:"device_operating_points_v1",points:groups[0]};
    await db.query("INSERT INTO energy_optimisation_device_operating_points VALUES($1,$1,'other',$2,1)",[home,JSON.stringify(unrelated)]);
    await db.query("INSERT INTO energy_optimisation_zone_models VALUES($1,$1,'already-unique',true,$2,1)",
      [home,JSON.stringify({binding:"synthetic-binding",active:[point(400)],reference_revision:uuid(401)})]);
    // Prove an existing immutable archive entry is not replaced by backfill.
    await db.query("INSERT INTO private.energy_heating_calibration_revisions VALUES($1,'room','room-0',$2,0,$3)",
      [home,uuid(1),JSON.stringify({immutable:true})]);
    // These rows deliberately predate the real archive triggers.
    const triggers = original.indexOf("CREATE FUNCTION private.archive_energy_heating_calibrations()");
    const publisher = original.indexOf("CREATE OR REPLACE FUNCTION public.publish_energy_device_learning(");
    await db.exec(original.slice(triggers,publisher));
    await db.exec(original.slice(publisher,original.indexOf("END; $$;",publisher)+"END; $$;".length));
    // The deployment CLI sends separate statements and supplies no transaction.
    // Do not let PGlite's multi-statement implicit transaction hide that contract.
    await assertRejects(() => db.exec("LOCK TABLE energy_optimisation_zone_models IN SHARE ROW EXCLUSIVE MODE"),
      Error,"transaction blocks");
    const sql = await Deno.readTextFile(migration);
    let start = 0;
    for (const token of sql.matchAll(/\$\$[\s\S]*?\$\$|'(?:''|[^'])*'|--[^\n]*|;/g)) {
      if (token[0] !== ";") continue;
      await db.exec(sql.slice(start,token.index+1));
      start = token.index+1;
    }

    for (const [i,group] of groups.entries()) {
      const expected = canonicalHeatingBands([...group,point(100+i,{band_c:-10,observed_min_c:-9,observed_max_c:-8})]);
      const room = (await db.query<{heating_bands:{active:HeatingBandRevision[]};model_revision:number}>(
        "SELECT heating_bands,model_revision FROM energy_optimisation_zone_models WHERE room_key=$1",[`room-${i}`])).rows[0];
      const device = (await db.query<{operating_points:{points:HeatingBandRevision[]};model_revision:number}>(
        "SELECT operating_points,model_revision FROM energy_optimisation_device_operating_points WHERE device_key=$1",[`heater-${i}`])).rows[0];
      assertEquals(room.heating_bands.active,expected);
      assertEquals(device.operating_points.points,expected);
      assertEquals(room.model_revision,2);
      assertEquals(device.model_revision,2);
      for (const [kind,key,reference] of [["room",`room-${i}`,uuid(200+i)],["device",`heater-${i}`,uuid(300+i)]]) {
        const ids = (await db.query<{revision:string}>("SELECT revision FROM private.energy_heating_calibration_revisions WHERE owner_kind=$1 AND owner_key=$2",[kind,key])).rows.map(r=>r.revision);
        assertEquals(new Set(ids),new Set([...group.map(r=>r.revision),uuid(100+i),reference]));
      }
    }
    assertEquals((await db.query<{calibration:unknown}>("SELECT calibration FROM private.energy_heating_calibration_revisions WHERE owner_kind='room' AND owner_key='room-0' AND revision=$1",[uuid(1)])).rows[0].calibration,{immutable:true});
    assertEquals((await db.query<{model_revision:number}>("SELECT model_revision FROM energy_optimisation_zone_models WHERE room_key='already-unique'")).rows[0].model_revision,1);
    assertEquals((await db.query<{operating_points:unknown;model_revision:number}>("SELECT operating_points,model_revision FROM energy_optimisation_device_operating_points WHERE device_key='other'")).rows[0],{operating_points:unrelated,model_revision:1});
    assertEquals((await db.query<{helper:string|null}>("SELECT to_regprocedure('private.canonical_heating_bands_for_migration(jsonb)') AS helper")).rows[0].helper,null,"no second live ranking policy");

    const job = uuid(500);
    await db.query(`INSERT INTO private.energy_learning_jobs(id,home_id,customer_id,owner_kind,owner_key,pending,generation,fence,lease_until)
      VALUES($1,$2,$2,'room','room-0',true,1,1,now()+interval '1 minute')`,[job,home]);
    const publish = async (revision:number,active:HeatingBandRevision[]) => (await db.query<{ok:boolean}>(
      "SELECT publish_energy_device_learning($1,1,1,$2,$3::jsonb) AS ok",[job,revision,JSON.stringify({home_id:home,customer_id:home,room_key:"room-0",
        heating_bands:{binding:"synthetic-binding",active}})])).rows[0].ok;
    assertEquals(await publish(1,groups[0]),false,"the migration's changed model revision fences stale captures");
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=now()+interval '1 minute' WHERE id=$1",[job]);
    const candidate = point(501,{fitted_at:"2026-11-22T12:00:00Z",learning_evidence:supported});
    await assertRejects(()=>publish(2,[candidate,...groups[0]]),Error,"room_heating_active_band_unique");
    assertEquals((await db.query<{pending:boolean}>("SELECT pending FROM private.energy_learning_jobs WHERE id=$1",[job])).rows[0].pending,true);
    assertEquals((await db.query<{n:number}>("SELECT count(*)::int AS n FROM private.energy_heating_calibration_revisions WHERE revision=$1",[candidate.revision])).rows[0].n,0,"a rejected publication is not an accepted revision");
    assertEquals(await publish(2,[candidate]),true,"fresh single-band publication succeeds through the ordinary publisher");
    const history = (await db.query<{revision:string}>("SELECT revision FROM private.energy_heating_calibration_revisions WHERE owner_kind='room' AND owner_key='room-0'")).rows.map(r=>r.revision);
    assert(history.includes(candidate.revision) && history.includes(uuid(1)) && history.includes(uuid(2)));
    await assertRejects(()=>db.query("UPDATE energy_optimisation_device_operating_points SET operating_points=$1 WHERE device_key='heater-0'",
      [JSON.stringify({method:"weather_heating_draw_v1",points:groups[0]})]),Error,"device_heating_active_band_unique");
    const before = await db.query("SELECT * FROM private.energy_heating_calibration_revisions ORDER BY owner_kind,owner_key,revision");
    // Repeated archival is harmless and cannot mutate accepted history.
    await db.exec("SELECT private.archive_energy_heating_row(to_jsonb(m),'room') FROM energy_optimisation_zone_models m");
    assertEquals(await db.query("SELECT * FROM private.energy_heating_calibration_revisions ORDER BY owner_kind,owner_key,revision"),before);
  } finally {await db.close();}
});
