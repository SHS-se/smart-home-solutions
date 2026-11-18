import { assertAlmostEquals, assertEquals } from "@std/assert";
import { MeanFeatureWorkspace } from "./mean-features.ts";

Deno.test("synthetic feature compression preserves mixed-duration objective with shared initial states", () => {
  // Independent deterministic features include collinear/zero columns, very
  // different scales, and four duration classes within each initial state.
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    kind: i % 4, segment: Math.floor(i / 30), initialShare: Math.exp(-(i % 30) / 4),
    values: [Math.sin(i / 9) * 1000, Math.cos(i / 13), 1, 0, Math.cos(i / 13) * 1e-5],
  }));
  const workspace = new MeanFeatureWorkspace(rows.length, rows[0].values.length);
  for (const row of rows) workspace.add(row.kind, row.segment, row.initialShare, row.values);
  const compressed = workspace.factor();
  workspace.reset();
  workspace.add(3, 9, 1, [2, 4, 6, 8, 10]);
  assertEquals(workspace.factor()[0], { values: [2, 4, 6, 8, 10], kind: 3, segment: 9, initialScale: 1 });
  assertEquals(workspace.count, 1);
  assertEquals(new Set(compressed.filter(row => row.initialScale !== 0).map(row => row.segment)).size, 40);
  for (let experiment = 0; experiment < 12; experiment++) {
    const coefficients = Array.from({ length: 4 }, (_, kind) =>
      [.002 * Math.sin(experiment + kind), 3, -.4 * kind, 8, 100]);
    const memory = (kind: number) => (kind + 1) * .3;
    const state = (segment: number) => Math.sin(segment + experiment) * 8;
    const residual = (values: number[], kind: number, segment: number, share: number) =>
      values.reduce((sum, value, j) => sum + value * coefficients[kind][j], 0) + memory(kind) * share * state(segment);
    const raw = rows.reduce((sum, row) => sum + residual(row.values, row.kind, row.segment, row.initialShare) ** 2, 0);
    const compact = compressed.reduce((sum, row) => sum + residual(row.values, row.kind, row.segment, row.initialScale) ** 2, 0);
    assertAlmostEquals(compact, raw, raw * 1e-12);
  }
});
