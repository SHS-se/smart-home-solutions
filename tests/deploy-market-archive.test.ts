import { assertEquals, assertStringIncludes } from '@std/assert';

Deno.test('TEST archive deployment uses one explicit CLI JSON protocol in CI and refuses any project override', async () => {
  const temporary = await Deno.makeTempDir({ prefix: 'price-archive-cli-test-' });
  const calls = `${temporary}/calls`;
  try {
    await Deno.writeTextFile(`${temporary}/supabase`, `#!/bin/sh
printf '%s\\n' "$*" >> "$PRICE_ARCHIVE_TEST_CALLS"
project=''
input=''
agent=''
operation="$1 $2"
while [ "$#" -gt 0 ]; do
 case "$1" in
  --project-ref) shift; project="$1" ;;
  --file) shift; input="$1" ;;
  --agent) shift; agent="$1" ;;
 esac
 shift
done
[ "$project" = 'vxqpgbzseckgceopitpm' ] || exit 8
if [ "$operation" = 'db query' ]; then
 [ "$agent" = 'no' ] || exit 9
 case "$(cat "$input")" in
  *'AS applied'*) printf '[{"applied":true}]' ;;
  *'SELECT home_id'*) printf '[{"home_id":"9bc2ab59-7832-4530-8a15-e51a09e43a59"}]' ;;
  *'cron.job'*) printf '[{"jobname":"test-energy-price-experiment","active":true}]' ;;
  *'AS enabled'*) printf '[{"enabled":true}]' ;;
  *) exit 10 ;;
 esac
fi
`, { mode: 0o700 });
    const run = (args: string[] = []) => new Deno.Command(Deno.execPath(), {
      args: ['run', '--allow-read', '--allow-write', '--allow-run=supabase', 'scripts/deploy-market-archive.ts', ...args],
      env: { PATH: `${temporary}:${Deno.env.get('PATH')}`, CI: 'true', PRICE_ARCHIVE_TEST_CALLS: calls },
      stdout: 'piped', stderr: 'piped',
    }).output();
    const success = await run();
    assertEquals(success.code, 0, new TextDecoder().decode(success.stderr));
    assertStringIncludes(new TextDecoder().decode(success.stdout), 'Deployed the TEST paired price worker.');
    const invocations = await Deno.readTextFile(calls);
    assertStringIncludes(invocations, '--agent no --output json');
    assertStringIncludes(invocations, 'functions deploy energy-price-experiment --project-ref vxqpgbzseckgceopitpm --use-api');
    assertStringIncludes(invocations, 'functions deploy energy-price-correction-experiment --project-ref vxqpgbzseckgceopitpm --use-api');
    assertEquals(invocations.includes('oosxndduqzhvrorgogaw'), false);
    const rejected = await run(['another-project']);
    assertEquals(rejected.code !== 0, true);
    assertEquals(await Deno.readTextFile(calls), invocations);
  } finally { await Deno.remove(temporary, { recursive: true }); }
});
