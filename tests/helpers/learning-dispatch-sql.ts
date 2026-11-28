// Independently synthetic owners, source bytes and delivery responses.
import { connectedDatabase } from "./connected-room-sql.ts";
import { home, other } from "./room-fit-sql.ts";
import { roomLearningWorkerCapabilities } from "../../supabase/functions/_shared/room-learning-worker-capabilities.ts";

export async function learningDispatchFixture(protocol = 4) {
  const db = await connectedDatabase();
  await db.exec(`RESET ROLE; ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN room_name text;
    CREATE TABLE net._http_response(id bigint PRIMARY KEY,status_code integer,content text,timed_out boolean,error_msg text,created timestamptz DEFAULT now());
    CREATE SEQUENCE net.synthetic_request;
    ALTER TABLE net.wakes ADD COLUMN id bigint DEFAULT nextval('net.synthetic_request');
    CREATE OR REPLACE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
      RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.wakes(body) VALUES($3) RETURNING id $$;`);
  for (const migration of ["20261123160000_measured_room_response", "20261123170000_state_carrying_room_forecasts",
    "20261126151000_connected_room_publication", "20261126151100_connected_room_fit_progress", "20261126220000_room_learning_work",
    "20261127100000_minimal_room_fit_work", "20261127223000_bound_room_learning_dispatch", "20261128010000_isolate_learning_executor_slots", "20261128020000_parallel_room_fit_replicas"]) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}.sql`));
  }
  const { runtime: _runtime, ...manifest } = { ...roomLearningWorkerCapabilities(), protocol };
  const worker = { ...manifest, runtime: "synthetic-runtime" };
  await db.query("DELETE FROM private.energy_learning_jobs WHERE home_id=$1", [other]);
  await db.query(`UPDATE private.energy_learning_jobs SET input=jsonb_build_object('learner_version',$1::text),pending=true,
    wake_after=now(),lease_until=NULL`, [worker.learner_version]);
  await db.query(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
    VALUES($1,$1,'room','observed',jsonb_build_object('learner_version',$2::text))`, [home, worker.learner_version]);
  await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture,adaptive_cursor)
    SELECT j.id,j.generation,coalesce(m.model_revision,0),jsonb_build_object('version',6,'runtime',$2::text,
      'learner_version',$3::text,'has_accepted_reference',false,'row_count',1,
      'capture',jsonb_build_object('implementation',$4::text,'binding',c.binding,'connected',jsonb_build_object('observedOnly',true)),
      'heat_state',jsonb_build_object('version',1,'stage','static')),decode('010203','hex'),17
    FROM private.energy_learning_jobs j JOIN private.energy_room_heating_contexts($1) c ON c.room_key=j.owner_key
    LEFT JOIN public.energy_optimisation_zone_models m ON m.home_id=j.home_id AND m.room_key=j.owner_key`,
    [home, worker.runtime, worker.learner_version,
      "chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1"]);
  const value = async <T>(sql: string, ...args: unknown[]) => (await db.query<{ v: T }>(`SELECT ${sql} AS v`, args)).rows[0].v;
  const token = await value<string>("(SELECT token FROM private.energy_learning_credentials)");
  await value("prepare_energy_learning_release(1,$1)", manifest);
  await value("activate_energy_learning_release(1,$1)", worker);
  type Delivery = { job_id: string; delivery_id: string; worker_url: string };
  const run = () => value<number>("(SELECT run_fence FROM private.energy_learning_dispatch)");
  const claimRun = async () => value("claim_energy_learning_dispatch($1,$2,$3)", await run(), worker, token);
  const take = async () => value<Delivery[]>("take_energy_learning_dispatch_work($1,2)", await run());
  const claim = (d: Delivery) => value<{ id: string; generation: number; fence: number; delivery_id?: string; replica_delivery?: { delivery_id: string; process_epoch: string; sequence: number; revision: number }; room_fit_progress: { cursor: number; base_revision: number; process?: { replica: { index: number; row: number } } } } | null>(
    "claim_energy_learning_request($1,$2,$3,$4)", d.job_id, worker, token, d.delivery_id);
  return { db, value, token, worker, manifest, run, claimRun, take, claim };
}
