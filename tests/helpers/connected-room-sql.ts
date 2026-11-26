// Independent synthetic source and topology schema.
import { chronologicalRoomDatabase } from "./chronological-room-sql.ts";
import { home } from "./room-fit-sql.ts";

export async function connectedDatabase() {
  const db = await chronologicalRoomDatabase();
  await db.exec(`RESET ROLE; CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
    GRANT USAGE ON SCHEMA auth TO room_migration; SET ROLE room_migration;
    ALTER TABLE energy_room_profiles ADD COLUMN app_map_owner text, ADD COLUMN app_map_revision bigint;
    ALTER TABLE energy_heating_observations ADD COLUMN learning_updated_at timestamptz DEFAULT now();
    ALTER TABLE energy_heating_probe_observations ADD COLUMN learning_updated_at timestamptz DEFAULT now();
    ALTER TABLE private.energy_heating_history_sources ADD COLUMN heater_energy_limits_w jsonb DEFAULT '{}';
    CREATE TABLE energy_history_notes(home_id uuid,note_date date,event_type text);
    DROP FUNCTION private.energy_room_heating_contexts(uuid);
    SET check_function_bodies=false;`);
  const native = await Deno.readTextFile("supabase/migrations/20261118190000_native_heating_observations.sql");
  const sourceStart = native.indexOf("CREATE FUNCTION private.energy_heating_source_matches(");
  await db.exec(native.slice(sourceStart, native.indexOf("REVOKE ALL ON FUNCTION private.energy_heating_source_matches", sourceStart)));
  const bounded = await Deno.readTextFile("supabase/migrations/20261119001500_bound_room_history_reads.sql");
  const contextStart = bounded.indexOf("CREATE OR REPLACE FUNCTION private.energy_room_heating_contexts(");
  await db.exec(bounded.slice(contextStart, bounded.indexOf("$$;", contextStart) + 3));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261122000500_complete_legacy_training_intervals.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261126150000_connected_room_source_contexts.sql"));
  await db.exec(`SET check_function_bodies=true;
    INSERT INTO energy_room_profiles(home_id,rooms,connections,app_map_owner,app_map_revision) VALUES('${home}',
      '{"room":{"source_key":"${"a".repeat(64)}"},"observed":{"source_key":"${"b".repeat(64)}","name":"Synthetic observed room"},"unlinked":{"source_key":"${"c".repeat(64)}"}}',
      '[{"rooms":["observed","room"]}]','synthetic-app',1);
    INSERT INTO energy_optimisation_devices(home_id,customer_id,id,device_key,statistic_id,category,active_power_w,first_seen_at,
      mapping_summary,control_type_override,mapping_status,mapped_control_type,planning_role_override)
    VALUES('${home}','${home}','33333333-3333-4333-8333-333333333333','heater','synthetic.energy','heating',800,'2000-01-01',
      '{"room_key":"room","room_name":"Synthetic heated room"}','switch_schedule','ready','switch_schedule','controllable');`);
  return db;
}
