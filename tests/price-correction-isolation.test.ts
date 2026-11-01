import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { classify, classifyPipeline } from '../scripts/ci-changes.ts';
Deno.test('retained residual replay modules have no live deployment path', () => {
  for (const source of ['price-pair.ts', 'price-correction.ts', 'price-correction-v2.ts']) {
    const changes = classify(new URL('..', import.meta.url).pathname, [`supabase/functions/_shared/${source}`]);
    assertEquals(changes.functions, []);
    assert(!changes.planner);
  }
});
Deno.test('archive deployment changes validate the pipeline and select only the collector', () => {
  const workflow = '.github/workflows/ci-deploy.yml';
  const changes = classifyPipeline(new URL('..', import.meta.url).pathname, [workflow, 'scripts/ci-changes.ts',
    'scripts/deploy-market-archive.ts'], [workflow, 'scripts/ci-changes.ts']);
  assertEquals(changes.functions, ['energy-market-archive']);
  assert(changes.planner && changes.frontend && changes.bench);
});
Deno.test('research collector is excluded from ordinary production deployment', async () => {
  const workflow = await Deno.readTextFile('.github/workflows/ci-deploy.yml');
  assertStringIncludes(workflow, '[ "$name" = energy-market-archive ]; then\n              continue');
  assertStringIncludes(workflow, '[ "$SUPABASE_PROJECT_REF" = vxqpgbzseckgceopitpm ]');
});
