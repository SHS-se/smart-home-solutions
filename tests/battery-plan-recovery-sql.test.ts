import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals } from '@std/assert';

const home='11111111-1111-4111-8111-111111111111';
const initial='22222222-2222-4222-8222-222222222222';
const replacement='33333333-3333-4333-8333-333333333333';
const reference=(id='initial',generation=3) => ({id,generation,scope_revision:'scope'});
const accepted=(plan_id=replacement,contract_id='replacement',generation=4) => ({plan_id,contract_id,generation,scope_revision:'scope'});
const rejection=(contract_id='replacement',generation=4) => ({contract_id,generation,reason:'changed target needs an amendment'});
const notice=(generation=3,scope_revision='scope') => ({key:'battery_plan_handover',generation,scope_revision,reason:'Handover failed',occurred_at:'2026-10-14T19:41:14Z'});

Deno.test('battery handover recovery follows actual admission and preserves other recommendations', async () => {
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE energy_optimisation_current(home_id uuid PRIMARY KEY,plan_id uuid,status text,
      issued_at timestamptz,plan jsonb,ha_runtime jsonb,ha_runtime_received_at timestamptz,replan_recommendations jsonb);`);
    const configuration={key:'integration_change',reason:'Configuration changed',occurred_at:'2026-10-14T19:42:00Z'};
    const legacy={key:'integration_change',reason:'Battery controller: plan_handover_rejected. Consider a manual replan.',occurred_at:'2026-10-14T19:41:14Z'};
    await db.query(`INSERT INTO energy_optimisation_current VALUES ($1,$2,'ready','2026-10-14T19:40:57Z',$3,null,null,$4)`,
      [home,initial,{battery_execution:reference()},[legacy,configuration]]);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261014201500_battery_plan_recovery.sql'));
    const warnings=async () => (await db.query<{replan_recommendations: unknown[]}>('SELECT replan_recommendations FROM energy_optimisation_current')).rows[0].replan_recommendations;
    const migrated=[{...legacy,key:'battery_plan_handover',scope_revision:'scope',generation:3},configuration];
    assertEquals(await warnings(),migrated);
    // The original failure: a warning newer than this same plan's issue time
    // clears when that plan's actual admission is reported, without a replan.
    await db.query('SELECT report_energy_runtime($1,$2)',[home,{observed_at:'2026-10-14T19:41:20Z',
      battery_plan:{accepted:accepted(initial,'initial',3),rejection:null}}]);
    assertEquals(await warnings(),[configuration]);
    await db.query('UPDATE energy_optimisation_current SET replan_recommendations=$1',[migrated]);
    await db.exec(`CREATE TRIGGER solved BEFORE UPDATE OF plan_id ON energy_optimisation_current
      FOR EACH ROW EXECUTE FUNCTION clear_solved_energy_recommendations();`);
    await db.query(`UPDATE energy_optimisation_current SET plan_id=$1,issued_at='2026-10-14T19:41:30Z',plan=$2`,
      [replacement,{battery_execution:reference('replacement',4)}]);
    // Publication must not claim the battery has accepted this plan.
    assertEquals((await warnings()).length,2);
    let tick=0;
    const report=async (battery_plan: unknown,at?: string) => {
      const observed_at=at ?? new Date(Date.parse('2026-10-14T19:43:00Z')+tick++*1000).toISOString();
      return (await db.query<{received:boolean}>('SELECT report_energy_runtime($1,$2) received',[home,{observed_at,battery_plan}])).rows[0].received;
    };
    // An admitted older plan does not resolve a failed replacement.
    await report({accepted:accepted(initial,'initial',3),rejection:rejection()});
    assertEquals((await warnings()).some((v: unknown) => (v as {key:string}).key==='battery_plan_handover'),true);
    await report({accepted:accepted(),rejection:null});
    assertEquals(await warnings(),[configuration]);
    // A delayed report cannot resurrect the warning after admission.
    assertEquals(await report({accepted:null,rejection:rejection()},'2026-10-14T19:42:59Z'),false);
    assertEquals(await warnings(),[configuration]);
    // Nor can a current report about an obsolete candidate create a new notice.
    await report({accepted:accepted(),rejection:rejection('initial',3)});
    assertEquals(await warnings(),[configuration]);
    const protectedWarnings=[notice(5),notice(3,'different-scope'),configuration];
    await db.query('UPDATE energy_optimisation_current SET replan_recommendations=$1',[protectedWarnings]);
    await report({accepted:accepted(),rejection:null});
    assertEquals(await warnings(),protectedWarnings);
    // A stale plan's acceptance cannot clear the current plan's rejection.
    await db.query('UPDATE energy_optimisation_current SET replan_recommendations=$1',[[notice(4),configuration]]);
    await report({accepted:accepted(initial,'initial',3),rejection:null});
    assertEquals(await warnings(),[notice(4),configuration]);
    await report({accepted:accepted(),rejection:null});
    assertEquals(await warnings(),[configuration]);
    // A genuine rejection also preserves newer and different-scope notices.
    await db.query('UPDATE energy_optimisation_current SET replan_recommendations=$1,ha_runtime=null',[protectedWarnings]);
    await report({accepted:accepted(initial,'initial',3),rejection:rejection()});
    const afterRejection=await warnings();
    assertEquals(afterRejection.slice(0,protectedWarnings.length),protectedWarnings);
    assertEquals(afterRejection.length,protectedWarnings.length+1);
    await report({accepted:accepted(),rejection:null});
    assertEquals(await warnings(),protectedWarnings);
  } finally { await db.close(); }
});
