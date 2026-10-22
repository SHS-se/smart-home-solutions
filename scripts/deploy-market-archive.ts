/** Deploy and enable the explicitly authorized TEST research archive only. */
const TEST = 'vxqpgbzseckgceopitpm';
const VERSION = '20261022180000';
const NAME = 'test_market_forecast_vintages';
const root = new URL('..', import.meta.url).pathname;
if (Deno.args.length) throw new Error('This command accepts no project override; TEST only.');

async function cli(args: string[]): Promise<string> {
  const result = await new Deno.Command('supabase', { cwd: root, args, stdout: 'piped', stderr: 'piped' }).output();
  if (!result.success) throw new Error(`TEST archive ${args[0]} ${args[1]} failed (exit ${result.code}); no production operation was attempted.`);
  return new TextDecoder().decode(result.stdout);
}
const temporary = await Deno.makeTempDir({ prefix: 'shs-market-archive-' });
try {
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    const path = `${temporary}/query.sql`;
    await Deno.writeTextFile(path, sql, { mode: 0o600 });
    const output = await cli(['db', 'query', '--linked', '--project-ref', TEST, '--file', path, '--output', 'json']);
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || !('rows' in parsed) || !Array.isArray(parsed.rows)) throw new Error('Invalid TEST database result.');
    return parsed.rows;
  };
  const applied = await query(`SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${VERSION}') AS applied;`);
  if (applied[0]?.applied !== true) {
    const source = await Deno.readTextFile(`${root}/supabase/migrations/${VERSION}_${NAME}.sql`);
    const delimiter = '$shs_market_archive_source$';
    if (source.includes(delimiter)) throw new Error('Unexpected migration source delimiter.');
    // Apply only this authorized migration and preserve the exact standard history identity.
    await query(`BEGIN;\n${source}\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('${VERSION}','${NAME}',ARRAY[${delimiter}${source}${delimiter}]);\nCOMMIT;\nSELECT true AS applied;`);
    console.log('Applied the forecast-vintage migration to TEST.');
  }
  await cli(['functions', 'deploy', 'energy-market-archive', 'energy-optimisation-ingest', '--project-ref', TEST, '--use-api', '--yes']);
  console.log('Deployed the TEST collector and price producer.');
  await query('SELECT private.enable_test_market_archive(); SELECT private.request_test_market_archive(); SELECT true AS enabled;');
  const schedule = await query("SELECT jobname,schedule,active FROM cron.job WHERE jobname='test-energy-market-forecast-archive';");
  console.log(JSON.stringify({ project: TEST, archive: 'enabled', first_collection: 'requested', schedule }));
} finally {
  await Deno.remove(temporary, { recursive: true });
}
