import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { classify } from '../scripts/ci-changes.ts';
Deno.test('residual study source has no path into executable household forecasts or the planner', () => {
  const changes=classify(new URL('..',import.meta.url).pathname,['supabase/functions/_shared/price-correction.ts']);
  assertEquals(changes.functions,['energy-price-correction-experiment']);
  assert(!changes.planner);
});
Deno.test('residual worker is explicitly excluded from ordinary production deployment',async()=>{
  const workflow=await Deno.readTextFile('.github/workflows/ci-deploy.yml');
  assertStringIncludes(workflow,'[ "$name" = energy-price-correction-experiment ]; then\n              continue');
  assertStringIncludes(workflow,'[ "$SUPABASE_PROJECT_REF" = vxqpgbzseckgceopitpm ]');
});
