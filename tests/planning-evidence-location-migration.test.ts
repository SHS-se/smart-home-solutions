import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "@std/assert";
Deno.test("planner evidence migration preserves addresses, scopes derived locations, and retains exact service commands",async()=>{
 const db=new PGlite();const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
 const h="33333333-3333-4333-8333-333333333333",other="44444444-4444-4444-8444-444444444444";
 try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE customers(id uuid PRIMARY KEY,site_street text,site_postcode text,site_city text);
 CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid,address_text text);
 ALTER TABLE homes ENABLE ROW LEVEL SECURITY;
 CREATE POLICY own_home ON homes FOR SELECT TO authenticated USING(customer_id=current_setting('test.customer')::uuid);
 GRANT SELECT ON homes TO authenticated;
 CREATE TABLE energy_optimisation_zone_models(fitted_at timestamptz);
 CREATE TABLE energy_optimisation_pool_model(fitted_at timestamptz);
 CREATE TABLE energy_optimisation_current(home_id uuid,plan_id uuid,plan jsonb,fixed_plan jsonb,fixed_plan_revision int);
 GRANT SELECT ON energy_optimisation_current TO service_role;
 INSERT INTO customers VALUES('${a}','Existing street','12345','City'),('${b}','Other street','54321','Other city');
 INSERT INTO homes VALUES('${h}','${a}',null),('${other}','${b}','Explicit installation');
 INSERT INTO energy_optimisation_zone_models VALUES('2026-10-14');INSERT INTO energy_optimisation_pool_model VALUES('2026-10-14');`);
 await db.exec(await Deno.readTextFile("supabase/migrations/20261015213000_planning_evidence_and_home_location.sql"));
 assertEquals((await db.query<{address_text:string}>("SELECT address_text FROM homes ORDER BY id")).rows.map(r=>r.address_text),["Existing street, 12345 City","Explicit installation"]);
 assertEquals((await db.query("SELECT last_attempted_at=fitted_at AS preserved FROM energy_optimisation_zone_models")).rows,[{preserved:true}]);
 await db.query("INSERT INTO energy_home_locations(home_id,address_text,latitude,longitude,provider) VALUES($1,'Address',59,18,'test'),($2,'Other',58,17,'test')",[h,other]);
 await db.exec(`SET test.customer='${a}';SET ROLE authenticated;`);
 assertEquals((await db.query("SELECT home_id FROM energy_home_locations")).rows,[{home_id:h}]);
 await assertRejects(()=>db.query("UPDATE energy_home_locations SET latitude=1"),Error,"permission denied");
 await assertRejects(()=>db.query("SELECT get_energy_replan_state($1)",[h]),Error,"permission denied");
 await db.exec("RESET ROLE");
 const slot={start:"2026-10-15T12:00:00Z",pool_permitted:true,pool_w:0,pool_command_w:0,device_loads_w:{room:1000},room_heating_w:{study:1000},
   ev_target_current_a:0,ev_min_current_a:0,ev_max_current_a:0,boiler_battery_allowed:false,boiler_permitted:true,boiler_expected_w:500,
   battery_command:null,device_commands:{room:{type:"switch_schedule",on_seconds:900}}};
 await db.query("INSERT INTO energy_optimisation_current VALUES($1,$2,$3,null,7)",[h,b,{status:"ready",hot_water_permissions:[slot.start],plans:{priority:{slots:[slot]}}}]);
 await db.exec("SET ROLE service_role");
 const reference=(await db.query<{value:{published_commands:{slots:unknown[]};fixed_plan_revision:number}}>("SELECT get_energy_replan_state($1) value",[h])).rows[0].value;
 assertEquals(reference.published_commands.slots,[slot]);assertEquals(reference.fixed_plan_revision,7);
 } finally {await db.close();}
});
