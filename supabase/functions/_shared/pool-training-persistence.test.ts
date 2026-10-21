import { PGlite } from "@electric-sql/pglite";
import { assertEquals, assertRejects } from "@std/assert";
import { storePoolModelRow } from "./pool-training-persistence.ts";
import { poolRefitIsDue } from "./pool-training.ts";

Deno.test("pool refits preserve a usable fit and save failed-attempt evidence under the real SQL constraints", async () => {
  const db = new PGlite();
  const home = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const customer = "33333333-3333-4333-8333-333333333333";
  const initialAt = "2026-10-20T17:20:35.744Z";
  const attemptedAt = "2026-10-21T17:20:35.744Z";
  const fit = { loss_kw_per_k: 0.2, rated_cop: 4, cop_per_air_c: 0.03,
    background_kw: 0.1, r2: 0.8, sample_count: 200, heated_sample_count: 50 };
  const response = [{ at_c: 29.125, idle_c_per_h: -0.02, idle_hours: 4.5,
    heat_c_per_kwh: 0.08, heated_kwh: 3.33 }];
  const attempt = { issues: ["unphysical", "limited_idle_observations"] };
  type Row = Record<string, unknown> & { home_id: string };
  // Execute the same column-wise INSERT/UPDATE operations as PostgREST against
  // PostgreSQL, so this catches checks that a map-based database mock cannot.
  const columns = (row: Row) => Object.keys(row).map(key => `"${key}"`);
  const insert = async (table: string, row: Row, upsert = false) => {
    const names = columns(row);
    await db.query(`INSERT INTO ${table} (${names.join(",")})
      VALUES (${names.map((_, index) => `$${index + 1}`).join(",")})
      ${upsert ? `ON CONFLICT (home_id) DO UPDATE SET ${names.map(name => `${name}=EXCLUDED.${name}`).join(",")}` : ""}`,
    Object.values(row));
    return { error: null };
  };
  const client = { from(table: string) { return {
    upsert: (row: Row) => insert(table, row, true),
    update: (row: Row) => ({ async eq(column: string, value: string) {
      await db.query(`UPDATE ${table} SET ${columns(row).map((name, index) => `${name}=$${index + 1}`).join(",")}
        WHERE "${column}"=$${Object.keys(row).length + 1}`, [...Object.values(row), value]);
      return { error: null };
    } }),
  }; } };
  const read = async (id: string) => (await db.query<Row>(
    "SELECT * FROM energy_optimisation_pool_model WHERE home_id=$1", [id],
  )).rows[0];
  try {
    await db.exec(`CREATE ROLE authenticated;
      CREATE TABLE customers(id uuid PRIMARY KEY);
      CREATE TABLE homes(id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id));
      CREATE FUNCTION energy_home_matches_customer(h uuid,c uuid) RETURNS boolean LANGUAGE sql AS
        $$ SELECT EXISTS(SELECT 1 FROM homes WHERE id=h AND customer_id=c) $$;
      CREATE FUNCTION can_access_energy_billing_customer(c uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`);
    for (const migration of [
      "20260817160000_add_pool_model.sql",
      "20260927160000_fit_pool_loss_from_idle_stretches.sql",
      "20261002120000_pool_measured_response.sql",
    ]) await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}`));
    await db.exec(`ALTER TABLE energy_optimisation_pool_model
      ADD COLUMN last_attempted_at timestamptz,
      ADD COLUMN last_fit_attempt jsonb NOT NULL DEFAULT '{}'::jsonb;`);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261017133100_learn_pool_thermal_response.sql"));
    await db.query("INSERT INTO customers VALUES($1)", [customer]);
    await db.query("INSERT INTO homes VALUES($1,$3),($2,$3)", [home, other, customer]);

    await storePoolModelRow(client, { home_id: home, customer_id: customer, ...fit,
      fitted_at: initialAt, last_attempted_at: initialAt, rejection: null }, false);
    await storePoolModelRow(client, { home_id: other, customer_id: customer,
      rejection: "insufficient_samples", sample_count: 0, heated_sample_count: 0,
      fitted_at: initialAt, last_attempted_at: initialAt }, false);
    const initial = await read(home), untouched = await read(other);
    // Exact failure from the production log: retained COP parameters are omitted
    // and rejection is null because the existing model remains usable.
    const patch = { home_id: home, customer_id: customer, rejection: null,
      idle_loss_kw_per_k: 0.1316, idle_loss_hours: 347.25, idle_loss_run_count: 23,
      idle_loss_rejection: null, response, thermal_dynamics: { state: { run_hours: 0 } },
      last_attempted_at: attemptedAt, last_fit_attempt: attempt };
    await assertRejects(() => client.from("energy_optimisation_pool_model").upsert(patch),
      Error, "energy_pool_model_fitted_or_rejected");
    assertEquals(await storePoolModelRow(client, patch, true), { error: null });
    const stored = await read(home);
    for (const key of [...Object.keys(fit), "fitted_at"]) assertEquals(stored[key], initial[key]);
    for (const key of ["response", "thermal_dynamics", "last_fit_attempt"]) assertEquals(stored[key], patch[key]);
    assertEquals(Number(stored.idle_loss_kw_per_k), patch.idle_loss_kw_per_k);
    const attemptedMs = (await db.query<{ ms: number }>(
      "SELECT extract(epoch FROM last_attempted_at)::float8 * 1000 AS ms FROM energy_optimisation_pool_model WHERE home_id=$1", [home],
    )).rows[0].ms;
    assertEquals(attemptedMs, Date.parse(attemptedAt));
    assertEquals(poolRefitIsDue(Date.parse(attemptedAt) + 15 * 60_000,
      attemptedMs, null, 24), false);
    assertEquals(await read(other), untouched);

    // A further rejected fit leaves the newly learned independent models intact.
    await storePoolModelRow(client, { home_id: home, rejection: null,
      last_fit_attempt: { issues: ["singular"] } }, true);
    const failedAgain = await read(home);
    assertEquals(failedAgain.thermal_dynamics, stored.thermal_dynamics);
    assertEquals(failedAgain.idle_loss_kw_per_k, stored.idle_loss_kw_per_k);

    // A model initially recorded as rejected can still gain its first fit.
    await storePoolModelRow(client, { home_id: other, ...fit,
      fitted_at: attemptedAt, last_attempted_at: attemptedAt, rejection: null,
      last_fit_attempt: { issues: [] } }, true);
    assertEquals(Number((await read(other)).rated_cop), fit.rated_cop);
    assertEquals((await read(other)).rejection, null);
  } finally {
    await db.close();
  }
});
