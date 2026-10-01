import { assertEquals } from 'jsr:@std/assert@1';
import ts from 'npm:typescript@5.8.3';

// Inspect syntax rather than matching across unrelated queries or comments.
function broadReads(source: string): string[] {
  const file = ts.createSourceFile('query.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const reads: string[] = [];
  function currentTable(node: ts.Expression): boolean {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (node.expression.name.text === 'from') {
      const table = node.arguments[0];
      return !!table && ts.isStringLiteralLike(table) && table.text === 'energy_optimisation_current';
    }
    return currentTable(node.expression.expression);
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'select' && currentTable(node.expression.expression)) {
      const columns = node.arguments[0];
      if (!columns) reads.push('*');
      else if (!ts.isStringLiteralLike(columns)) reads.push('dynamic selection');
      else for (const column of columns.text.split(',')) {
        const name = column.trim().replace(/^\w+\s*:\s*/, '');
        if (['*', 'plan', 'snapshot'].includes(name)) reads.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return reads;
}

Deno.test('plan read guard detects broad selects without confusing JSON projections', () => {
  for (const [selection, expected] of [
    ['"plan_id,plan"', ['plan']], ['"*"', ['*']], ['', ['*']],
    ['"plan_id"', []], ['"snapshot->>timezone"', []],
    ['"data:plan,snapshot"', ['plan', 'snapshot']], ['columns', ['dynamic selection']],
    ['`plan_id,plan`', ['plan']],
  ] as const) {
    assertEquals(broadReads(`db.from('energy_optimisation_current').select(${selection}).eq('id', id);`), [...expected]);
  }
  assertEquals(broadReads(`db.from('other').select('*'); db.from('energy_optimisation_current').select('plan_id');`), []);
  assertEquals(broadReads(`// db.from('energy_optimisation_current').select('*');`), []);
  assertEquals(broadReads(`db.from("energy_optimisation_current").update({plan: p}).select("plan")`), ['plan']);
});

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) result.push(...await files(path));
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) result.push(path);
  }
  return result;
}

Deno.test('recurring paths never read whole current energy plans or snapshots', async () => {
  const allowed: Record<string, string[]> = {
    // Manual activation validates a complete user-edited schedule; status polling uses its narrow RPC.
    'supabase/functions/energy-optimisation-fixed-plan/index.ts': ['snapshot'],
    // Explicit workbench analysis needs the complete model and result.
    'src/components/portal/energy/PlanWorkbenchTab.tsx': ['snapshot', 'plan'],
    // User-opened value-curve analysis needs the complete model and result.
    'src/components/portal/energy/ValueCurvesTab.tsx': ['snapshot', 'plan'],
    // User-requested replay downloads need the original input snapshot.
    'src/components/portal/energy/plan/PlanReplayDownload.tsx': ['snapshot'],
  };
  const violations: string[] = [];
  for (const path of [...await files('supabase/functions'), ...await files('src')]) {
    for (const column of broadReads(await Deno.readTextFile(path))) {
      if (!allowed[path]?.includes(column)) violations.push(`${path}: ${column}`);
    }
  }
  assertEquals(violations, [], 'Use a SQL projection such as get_energy_replan_state; never return full plan/snapshot JSON in recurring paths.');
});

Deno.test('manual fixed-plan snapshot exception stays behind the status early return', async () => {
  const source = await Deno.readTextFile('supabase/functions/energy-optimisation-fixed-plan/index.ts');
  const file = ts.createSourceFile('endpoint.ts', source, ts.ScriptTarget.Latest, true);
  let status: ts.IfStatement | undefined;
  const snapshotReads: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.left.getText(file) === 'body.action'
      && ts.isStringLiteral(node.expression.right) && node.expression.right.text === 'status') status = node;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'select' && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text.split(',').some(column => column.trim() === 'snapshot')) snapshotReads.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assertEquals(!!status && ts.isBlock(status.thenStatement)
    && ts.isReturnStatement(status.thenStatement.statements.at(-1)!), true);
  assertEquals(snapshotReads.length > 0, true);
  assertEquals(snapshotReads.every(read => read.pos > status!.end), true,
    'Status polling must return before any full snapshot read.');
});
