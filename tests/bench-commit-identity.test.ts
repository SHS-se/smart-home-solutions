import { assert, assertEquals } from '@std/assert';
import { LocalStore } from '../bench/store.ts';

const root = new URL('..', import.meta.url).pathname;

Deno.test('branch heads and identical planner commits retain their own identities through the real bench runner', async () => {
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
    // Use the current harness in an isolated repository with three real commits.
    await command('cp', ['-R', ...['bench', 'src', 'scripts', 'supabase'].map(path => `${root}/${path}`), repo]);
    await Deno.copyFile(`${root}/deno.json`, `${repo}/deno.json`);
    await Deno.symlink(`${root}/node_modules`, `${repo}/node_modules`);
    const planner = 'supabase/functions/_shared/planner';
    await Deno.writeTextFile(`${repo}/${planner}/energy-optimisation.ts`, 'export const PLANNER_INPUTS = [];\n');
    await Deno.writeTextFile(`${repo}/${planner}/dispatch-plan.ts`, 'export {};\n');
    await command('git', ['init', '--initial-branch=main']);
    await command('git', ['config', 'user.name', 'Bench test']);
    await command('git', ['config', 'user.email', 'bench@example.invalid']);
    await command('git', ['add', `${planner}/energy-optimisation.ts`, `${planner}/dispatch-plan.ts`]);
    const commit = async (subject: string, date: string) => {
      await command('git', ['commit', '--allow-empty', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return await command('git', ['rev-parse', 'HEAD']);
    };
    const older = await commit('Original planner', '2026-10-01T00:00:00Z');
    const main = await commit('Main head, same planner', '2026-10-02T00:00:00Z');
    await command('git', ['switch', '-c', 'dev']);
    const dev = await commit('Dev head, same planner', '2026-10-03T00:00:00Z');
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
    await store.saveRun({ sha: older, short_sha: older.slice(0, 7), committed_at: '2026-10-01T00:00:00Z', subject: 'Original planner', branch: null, status: 'done' });
    await store.markDeployed(older, 'production');
    await store.markDeployed(older, 'test');
    const run = () => command(Deno.execPath(), [
      'run', '-A', '--no-check', '--sloppy-imports', '--config', `${repo}/deno.json`, `${repo}/bench/run.ts`,
      '--shas', 'all', '--current', 'main', '--test', 'dev', '--local', cases, '--out', out,
    ]);
    await run();
    const first = await store.runs();
    assertEquals(first.map(r => [r.sha, r.is_current, r.is_test]), [
      [older, false, false], [main, true, false], [dev, false, true],
    ]);
    assert(first[0].planner_version);
    assertEquals(new Set(first.map(r => r.planner_version)).size, 1);
    await run();
    assertEquals(await store.runs(), first, 'repeated runs keep branch marks and every equal-code commit');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
