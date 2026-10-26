/** Deploy and enable the explicitly authorized TEST research archive only. */
const TEST = 'vxqpgbzseckgceopitpm';
const MIGRATIONS = [
  { version: '20261022180000', name: 'test_market_forecast_vintages' },
  { version: '20261022190000', name: 'test_medium_range_weather' },
  { version: '20261022210000', name: 'test_generation_mix' },
  { version: '20261022211000', name: 'test_generation_validation_permissions' },
  { version: '20261022220000', name: 'test_hydro_nuclear_forecasts' },
  { version: '20261022230000', name: 'test_paired_price_experiment' },
  { version: '20261022233000', name: 'test_price_pair_comparison_ui' },
  { version: '20261026100000', name: 'test_price_residual_correction' },
];
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
    // Agent auto-detection wraps rows in a warning envelope locally but not in CI.
    // Request one explicit machine protocol in both environments.
    const output = await cli(['db', 'query', '--linked', '--project-ref', TEST, '--file', path, '--agent', 'no', '--output', 'json']);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid TEST database result.');
    return parsed;
  };
  for (const { version, name } of MIGRATIONS) {
    const applied = await query(`SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${version}') AS applied;`);
    if (applied[0]?.applied === true) continue;
    const source = await Deno.readTextFile(`${root}/supabase/migrations/${version}_${name}.sql`);
    const delimiter = '$shs_market_archive_source$';
    if (source.includes(delimiter)) throw new Error('Unexpected migration source delimiter.');
    // Apply only this authorized migration and preserve the exact standard history identity.
    await query(`BEGIN;\n${source}\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('${version}','${name}',ARRAY[${delimiter}${source}${delimiter}]);\nCOMMIT;\nSELECT true AS applied;`);
    console.log(`Applied TEST archive migration ${version}.`);
  }
  await cli(['functions', 'deploy', 'energy-market-archive', '--project-ref', TEST, '--use-api', '--yes']);
  console.log('Deployed the TEST collector.');
  await cli(['functions', 'deploy', 'energy-price-experiment', '--project-ref', TEST, '--use-api', '--yes']);
  console.log('Deployed the TEST paired price worker.');
  // Keep authentication configuration local to this TEST deployment. A global
  // config edit selects unrelated household functions for redeployment.
  await cli(['functions', 'deploy', 'energy-price-correction-experiment', '--project-ref', TEST, '--use-api', '--no-verify-jwt', '--yes']);
  console.log('Deployed the TEST residual correction worker.');
  const homes = await query('SELECT home_id FROM public.energy_optimisation_current ORDER BY home_id;');
  if (homes.length !== 1 || typeof homes[0].home_id !== 'string' || !/^[0-9a-f-]{36}$/.test(homes[0].home_id)) {
    throw new Error('TEST price study requires exactly one explicitly scoped current home.');
  }
  await query(`SELECT private.enable_test_market_archive(); SELECT private.enable_test_generation_forecast(); SELECT private.enable_test_price_experiment('${homes[0].home_id}'::uuid); SELECT private.enable_test_price_correction(); SELECT private.request_test_market_archive(); SELECT private.request_test_generation_forecast(); SELECT private.request_test_price_experiment(); SELECT private.request_test_price_correction(); SELECT true AS enabled;`);
  const schedule = await query("SELECT jobname,schedule,active FROM cron.job WHERE jobname IN ('test-energy-market-forecast-archive','test-energy-generation-forecast','test-energy-price-experiment','test-energy-price-correction');");
  console.log(JSON.stringify({ project: TEST, archive: 'enabled', first_collection: 'requested', schedule }));
} finally {
  await Deno.remove(temporary, { recursive: true });
}
