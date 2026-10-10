import { assert, assertEquals } from '@std/assert';
import { LocalStore } from '../bench/store.ts';

const root = new URL('..', import.meta.url).pathname;

Deno.test('the real bench runner preserves branch heads, marks pre-planner commits unavailable, and fails existing broken planners', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'bench-commit-identity-' });
  const repo = `${dir}/repo`, cases = `${dir}/cases`, out = `${dir}/results.json`;
  const command = async (executable: string, args: string[], env: Record<string, string> = {}) => {
    const result = await new Deno.Command(executable, { args, cwd: repo, env, stdout: 'piped', stderr: 'piped' }).output();
    assert(result.success, new TextDecoder().decode(result.stderr) + new TextDecoder().decode(result.stdout));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await Deno.mkdir(repo);
    await Deno.mkdir(cases);
    // Use the current harness in an isolated repository with real commits.
    await command('cp', ['-R', ...['bench', 'src', 'scripts', 'supabase'].map(path => `${root}/${path}`), repo]);
    await Deno.copyFile(`${root}/deno.json`, `${repo}/deno.json`);
    await Deno.symlink(`${root}/node_modules`, `${repo}/node_modules`);
    const planner = 'supabase/functions/_shared/planner';
    await Deno.writeTextFile(`${repo}/${planner}/energy-optimisation.ts`, 'export const PLANNER_INPUTS = [];\n');
    await Deno.writeTextFile(`${repo}/${planner}/dispatch-plan.ts`, 'export {};\n');
    await command('git', ['init', '--initial-branch=main']);
    await command('git', ['config', 'user.name', 'Bench test']);
    await command('git', ['config', 'user.email', 'bench@example.invalid']);
    const commit = async (subject: string, date: string) => {
      await command('git', ['commit', '--allow-empty', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return await command('git', ['rev-parse', 'HEAD']);
    };
    const beforePlanner = await commit('Before the planner existed', '2026-10-07T17:00:00Z');
    await command('git', ['add', `${planner}/energy-optimisation.ts`, `${planner}/dispatch-plan.ts`]);
    const older = await commit('Original planner', '2026-10-07T18:00:00Z');
    const main = await commit('Main head, same planner', '2026-10-07T19:00:00Z');
    await command('git', ['switch', '-c', 'dev']);
    const dev = await commit('Dev head, same planner', '2026-10-07T20:00:00Z');
    await command('git', ['remote', 'add', 'origin', repo]);

    // Exercise the workflow's actual branch-resolution script against git refs.
    const workflow = await Deno.readTextFile(`${root}/.github/workflows/planner-bench.yml`);
    const script = workflow.split('      - name: Resolve main and dev branch heads\n')[1]
      .split('        run: |\n')[1].split('\n      - name:')[0]
      .split('\n').filter(line => line.trim()).map(line => line.slice(10)).join('\n');
    const envFile = `${dir}/github-env`;
    await command('bash', ['-e', '-c', script], { GITHUB_ENV: envFile });
    assertEquals((await Deno.readTextFile(envFile)).trim().split('\n'), [`BRANCH_main=${main}`, `BRANCH_dev=${dev}`]);

    // Start with the misleading folded record produced by the old runner.
    const store = new LocalStore(cases, out);
    await store.saveRun({ sha: older, short_sha: older.slice(0, 7), committed_at: '2026-10-07T18:00:00Z', subject: 'Original planner', branch: null, status: 'done' });
    await store.saveRun({ sha: beforePlanner, short_sha: beforePlanner.slice(0, 7), committed_at: "2026-10-07T17:00:00Z", subject: "Before the planner existed", branch: null, status: "failed", error: "worker exited with 1" });
    await store.markDeployed(older, 'production');
    await store.markDeployed(older, 'test');
    const run = () => command(Deno.execPath(), [
      'run', '-A', '--no-check', '--sloppy-imports', '--config', `${repo}/deno.json`, `${repo}/bench/run.ts`,
      '--shas', 'all', '--current', 'main', '--test', 'dev', '--local', cases, '--out', out,
    ]);
    await run();
    const first = await store.runs();
    assertEquals(first.map(r => [r.sha, r.is_current, r.is_test]), [
      [beforePlanner, false, false], [older, false, false], [main, true, false], [dev, false, true],
    ]);
    assertEquals(first[0].status, 'unavailable');
    assertEquals(first[0].planner_version, null);
    assertEquals(first[0].error, 'This commit does not contain a planner entry point.');
    assert(first[1].planner_version);
    assertEquals(new Set(first.slice(1).map(r => r.planner_version)).size, 1);
    await run();
    assertEquals(await store.runs(), first, 'repeated runs keep branch marks and every equal-code commit');
    const automatic = await command(Deno.execPath(), [
      'run', '-A', '--no-check', '--sloppy-imports', '--config', `${repo}/deno.json`, `${repo}/bench/run.ts`,
      '--shas', 'all', '--current', 'main', '--test', 'dev', '--local', cases, '--out', out,
    ], { GITHUB_EVENT_NAME: 'workflow_run' });
    assert(automatic.includes('Refresh: 2 planner(s), lanes oracle/nominal'));
    assert(!automatic.includes('Original planner'), 'automatic deployments must not expand stored history');
    // An environment may itself point to a commit with no planner. Its identity stays exact.
    await command(Deno.execPath(), [
      'run', '-A', '--no-check', '--sloppy-imports', '--config', `${repo}/deno.json`, `${repo}/bench/run.ts`,
      '--shas', 'all', '--current', beforePlanner, '--test', 'dev', '--local', cases, '--out', out,
    ]);
    assertEquals((await store.runs()).filter(r => r.is_current).map(r => [r.sha, r.status]), [[beforePlanner, 'unavailable']]);
    assertEquals((await store.runs()).filter(r => r.is_test).map(r => r.sha), [dev]);

    await Deno.writeTextFile(`${repo}/${planner}/energy-optimisation.ts`, "import './missing.ts';\nexport const PLANNER_INPUTS = [];\n");
    await command('git', ['add', `${planner}/energy-optimisation.ts`]);
    const broken = await commit('Broken planner dependency', '2026-10-07T21:00:00Z');
    const failure = await new Deno.Command(Deno.execPath(), { cwd: repo, args: [
      'run', '-A', '--no-check', '--sloppy-imports', '--config', `${repo}/deno.json`, `${repo}/bench/run.ts`,
      '--shas', broken, '--current', main, '--test', broken, '--local', cases, '--out', out,
    ], stdout: 'piped', stderr: 'piped' }).output();
    assert(!failure.success, 'an existing planner with a missing import must still fail the workflow');
    assert(new TextDecoder().decode(failure.stderr).includes('Module not found'));
    assertEquals((await store.runs()).find(r => r.sha === broken)!.status, 'failed');
    // The failure cannot leave the UI marked with an old environment identity.
    assertEquals((await store.runs()).filter(r => r.is_current).map(r => r.sha), [main]);
    assertEquals((await store.runs()).filter(r => r.is_test).map(r => r.sha), [broken]);
    const output = new TextDecoder().decode(failure.stdout);
    assert(output.includes('Refresh: 1 planner(s)'));
    assert(!output.includes('Main head, same planner'), 'explicit candidate refresh must not solve the production head');

    // History kept by the runner: a commit whose planner a head already has leaves with its results.
    await command('git', ['switch', 'main']);
    assertEquals((await store.runs()).map(r => r.sha).sort(), [beforePlanner, older, main, dev, broken].sort());
    const pruned = await command(Deno.execPath(), [
      'run', '-A', '--no-check', '--sloppy-imports', '--config', `${repo}/deno.json`, `${repo}/bench/run.ts`,
      '--shas', 'heads', '--current', main, '--test', dev, '--history', '1', '--local', cases, '--out', out,
    ]);
    assert(pruned.includes('## Planner bench history'));
    assert(pruned.includes(older.slice(0, 8)), 'the copy of the heads\' planner is named as removed');
    // No case is ready here, so the two that remain are not compared on score.
    assertEquals((await store.runs()).map(r => [r.sha, r.is_current, r.is_test]), [
      [beforePlanner, false, false], [main, true, false], [dev, false, true], [broken, false, false],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
