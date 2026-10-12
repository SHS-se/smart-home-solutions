import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';

Deno.test('deployment retry transaction preserves authorization, uploader, atomicity and cleanup receipts', async () => {
  const db = new PGlite();
  const customer = '11111111-1111-4111-8111-111111111111', uploader = '22222222-2222-4222-8222-222222222222';
  const ids = ['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
  const hash = 'a'.repeat(64);
  const document = { document_kind: 'grid', provider_key: 'ellevio', provider_name: 'Ellevio', parser_id: 'ellevio_flat_transfer', parser_version: 4,
    invoice_number: '123456', invoice_date: '2026-10-05', period_start: '2026-09-01', period_end: '2026-09-30', consumption_kwh: 10,
    total_amount_sek: 100, currency: 'SEK', original_file_name: 'untrusted.pdf', mime_type: 'text/plain', file_size_bytes: 1, document_sha256: 'f'.repeat(64) };
  const lines = [{ category: 'fixed_fee', label: 'Fast avgift', amount_sek: 100, quantity: 30, unit: 'days', period_start: '2026-09-01', period_end: '2026-09-30', amount_includes_vat: true }];
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.uid',true),'')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.role',true),'') $$;
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id = '${customer}'::uuid AND auth.uid() = '${uploader}'::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      INSERT INTO customers VALUES ('${customer}'); INSERT INTO auth.users VALUES ('${uploader}');`);
    const billing = await Deno.readTextFile('supabase/migrations/20260727160000_add_energy_billing_history.sql');
    await db.exec(billing.slice(billing.indexOf('CREATE TABLE public.energy_billing_documents'), billing.indexOf('CREATE OR REPLACE FUNCTION public.create_energy_billing_document')));
    await db.exec('ALTER TABLE energy_billing_documents ALTER COLUMN file_path DROP NOT NULL;');
    const retention = await Deno.readTextFile('supabase/migrations/20260729113000_energy_import_retention_and_deletion.sql');
    await db.exec(retention.slice(retention.indexOf('CREATE TABLE IF NOT EXISTS public.energy_parse_failures'), retention.indexOf('CREATE OR REPLACE FUNCTION public.record_energy_parse_failure')));
    await db.exec(await Deno.readTextFile('supabase/migrations/20261012103000_retry_retained_energy_invoices.sql'));
    for (const [i, id] of ids.entries()) await db.query(`INSERT INTO energy_parse_failures(id,customer_id,original_file_name,file_path,mime_type,file_size_bytes,file_sha256,file_category,parser_error,uploaded_by)
      VALUES ($1,$2,'original.pdf',$3,'application/pdf',100,$4,'document','unknown_format',$5)`, [id,customer,`${customer}/${id}/original.pdf`, i === 0 ? hash : String(i).repeat(64),uploader]);
    const complete = async (id: string, payload: unknown = document, items: unknown = lines) => (await db.query<{ done: boolean }>('SELECT complete_energy_invoice_retry($1,$2::jsonb,$3::jsonb) AS done',[id,payload,items])).rows[0].done;
    await db.exec(`SET test.uid='${uploader}'; SET test.role='authenticated'; SET ROLE authenticated;`);
    await assertRejects(() => complete(ids[0]), Error, 'permission denied');
    await assertRejects(() => db.query('SELECT private.insert_energy_billing_document($1,$2,$3::jsonb,$4::jsonb)', [customer,uploader,document,lines]), Error, 'permission denied');
    await db.exec("RESET ROLE; SET test.uid=''; SET test.role='service_role'; SET ROLE service_role;");
    assertEquals(await complete(ids[0],null,null),false);
    await assertRejects(() => complete(ids[0],document,[{...lines[0],quantity:-1}]), Error, 'check constraint');
    await db.exec('RESET ROLE;');
    assertEquals((await db.query('SELECT * FROM energy_billing_documents')).rows.length,0);
    assertEquals((await db.query<{ at: string | null }>('SELECT retry_imported_at AS at FROM energy_parse_failures WHERE id=$1',[ids[0]])).rows[0].at,null);
    await db.exec('SET ROLE service_role;');
    assertEquals(await complete(ids[0]),true); assertEquals(await complete(ids[0]),true);
    // A different hash with the same invoice number must not be treated as a duplicate.
    await assertRejects(() => complete(ids[1]), Error, 'unique constraint');
    await db.query('SELECT finish_energy_invoice_retry($1)',[ids[1]]);
    await db.exec('RESET ROLE;');
    const imported = (await db.query<{ uploaded_by: string; original_file_name: string; document_sha256: string; mime_type: string; file_size_bytes: number }>('SELECT * FROM energy_billing_documents')).rows;
    assertEquals(imported.length,1); assertEquals(imported[0].uploaded_by,uploader);
    assertEquals(imported[0].original_file_name,'original.pdf'); assertEquals(imported[0].document_sha256,hash);
    assertEquals(imported[0].mime_type,'application/pdf'); assertEquals(Number(imported[0].file_size_bytes),100);
    assertEquals((await db.query('SELECT * FROM energy_billing_line_items')).rows.length,1);
    assertEquals((await db.query('SELECT * FROM energy_parse_failures WHERE id=$1',[ids[1]])).rows.length,1);
    await db.exec(`SET test.uid='${uploader}'; SET test.role='authenticated'; SET ROLE authenticated;`);
    assertEquals((await db.query('SELECT * FROM energy_parse_failures WHERE id=$1',[ids[0]])).rows.length,0); // Completed receipt is hidden.
    await db.query('SELECT create_energy_billing_document($1,$2::jsonb,$3::jsonb)',[customer,{...document,invoice_number:'normal',document_sha256:'b'.repeat(64)},lines]);
    await db.exec("RESET ROLE; SET test.uid=''; SET test.role='service_role'; SET ROLE service_role;");
    await assertRejects(() => db.query('SELECT create_energy_billing_document($1,$2::jsonb,$3::jsonb)',[customer,document,lines]), Error, 'permission denied');
    await db.exec('RESET ROLE; DELETE FROM energy_billing_documents; SET ROLE service_role;');
    // A user-deleted invoice must not be recreated while a committed source awaits cleanup.
    assertEquals(await complete(ids[0]),true);
    await db.query('SELECT finish_energy_invoice_retry($1)',[ids[0]]);
    await db.query('SELECT finish_energy_invoice_retry($1)',[ids[0]]); // Finalization is idempotent.
    await db.exec('RESET ROLE;');
    assertEquals((await db.query('SELECT * FROM energy_billing_documents')).rows.length,0);
    assertEquals((await db.query('SELECT * FROM energy_parse_failures WHERE id=$1',[ids[0]])).rows.length,0);
  } finally { await db.close(); }
});
