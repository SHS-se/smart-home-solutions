import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { classify, classifyPipeline } from '../scripts/ci-changes.ts';
Deno.test('residual study source has no path into executable household forecasts or the planner', () => {
  const changes=classify(new URL('..',import.meta.url).pathname,['supabase/functions/_shared/price-correction.ts']);
  assertEquals(changes.functions,['energy-price-correction-experiment']);
  assert(!changes.planner);
});
Deno.test('the complete residual deployment change validates the planner but deploys only research workers', () => {
  const workflow='.github/workflows/ci-deploy.yml';
  const changes=classifyPipeline(new URL('..',import.meta.url).pathname,[workflow,'scripts/ci-changes.ts',
    'scripts/deploy-market-archive.ts','supabase/functions/_shared/price-pair.ts',
    'supabase/functions/_shared/price-correction.ts','supabase/functions/energy-price-correction-experiment/index.ts'],[workflow,'scripts/ci-changes.ts']);
  assertEquals(changes.functions,['energy-market-archive','energy-price-correction-experiment','energy-price-experiment']);
  assert(changes.planner && changes.frontend && changes.bench);
});
Deno.test('residual worker is explicitly excluded from ordinary production deployment',async()=>{
  const workflow=await Deno.readTextFile('.github/workflows/ci-deploy.yml');
  assertStringIncludes(workflow,'[ "$name" = energy-price-correction-experiment ]; then\n              continue');
  assertStringIncludes(workflow,'[ "$SUPABASE_PROJECT_REF" = vxqpgbzseckgceopitpm ]');
});
