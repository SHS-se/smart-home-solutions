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
  { version: '20261101110000', name: 'test_price_residual_v2' },
  { version: '20261101143000', name: 'retire_test_price_workers' },
  { version: '20261101144000', name: 'market_data_foundation' },
  { version: '20261101162000', name: 'weather_accuracy_quality_monitor' },
  { version: '20261101164000', name: 'verified_regional_context' },
  { version: '20261101180000', name: 'retrospective_regional_backfill' },
  { version: '20261101181000', name: 'native_history_request_windows' },
  { version: '20261110100000', name: 'test_weather_price_experiment' },
  { version: '20261113134000', name: 'se3_market_history' },
  { version: '20261113152000', name: 'retire_open_meteo' },
  { version: '20261113205000', name: 'test_se3_net_import_forecast' },
  { version: '20261113220000', name: 'test_se3_gross_flow_forecasts' },
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
    // Newer CLIs refuse a hosted statement without confirmation when the output is machine-readable.
    const output = await cli(['db', 'query', '--linked', '--project-ref', TEST, '--file', path, '--agent', 'no', '--output', 'json', '--yes']);
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
  await cli(['functions', 'deploy', 'energy-market-quality', '--project-ref', TEST, '--use-api', '--no-verify-jwt', '--yes']);
  console.log('Deployed TEST accuracy evaluation.');
  const functions: { slug: string }[] = JSON.parse(await cli(['functions', 'list', '--project-ref', TEST, '--output', 'json']));
  for (const slug of ['energy-price-experiment', 'energy-price-correction-experiment', 'energy-price-weather-experiment']) {
    if (functions.some(fn => fn.slug === slug)) await cli(['functions', 'delete', slug, '--project-ref', TEST, '--yes']);
  }
  const homes = await query(`SELECT coalesce((SELECT price_experiment_home_id FROM private.test_market_archive_config WHERE singleton),
    CASE WHEN count(*)=1 THEN min(home_id::text)::uuid END) home_id FROM public.energy_optimisation_current;`);
  if (homes.length !== 1 || typeof homes[0].home_id !== 'string' || !/^[0-9a-f-]{36}$/.test(homes[0].home_id)) {
    throw new Error('TEST ledger requires one explicitly scoped home.');
  }
  await query(`SELECT private.enable_test_market_archive(); SELECT private.enable_test_generation_forecast(); SELECT private.enable_test_market_context(); SELECT private.enable_test_market_quality(); SELECT private.enable_test_regional_context(); SELECT private.enable_test_market_history(); SELECT private.enable_test_price_ledger('${homes[0].home_id}'::uuid); SELECT private.request_test_market_archive(); SELECT private.request_test_generation_forecast(); SELECT private.request_test_market_context(); SELECT private.request_test_weather_truth(); SELECT private.request_test_regional_context(); SELECT private.request_test_market_history(); SELECT true AS enabled;`);
  await query('SELECT private.enable_test_se3_net_import_forecasts(); SELECT private.record_test_se3_net_import_forecasts(); SELECT private.enable_test_se3_gross_flow_forecasts(); SELECT private.record_test_se3_gross_flow_forecasts(); SELECT true AS enabled;');
  const schedule = await query("SELECT jobname,schedule,active FROM cron.job WHERE jobname IN ('test-energy-market-forecast-archive','test-energy-generation-forecast','test-energy-market-context','test-energy-market-history','test-energy-weather-truth','test-energy-market-health','test-energy-regional-context','test-energy-weather-accuracy','test-energy-demand-accuracy','test-energy-price-experiment','test-energy-price-correction','test-energy-price-weather','test-energy-se3-net-import-forecast','test-energy-se3-gross-flow-forecast');");
  console.log(JSON.stringify({ project: TEST, archive: 'enabled', first_collection: 'requested', schedule }));
} finally {
  await Deno.remove(temporary, { recursive: true });
}
