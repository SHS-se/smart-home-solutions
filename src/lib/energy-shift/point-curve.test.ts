import { assertEquals } from 'jsr:@std/assert@1';
import { moveCurvePoint, resizeCurve } from './point-curve.ts';
const curve = {unit:'kwh', points:[{at:0, sek_per_unit:4}, {at:10, sek_per_unit:0}]};
Deno.test('point count is explicit and resizing preserves endpoints and diminishing value', () => {
  const resized = resizeCurve(curve, 21);
  assertEquals(resized.points.length, 21);
  assertEquals(resized.points[0], curve.points[0]);
  assertEquals(resized.points.at(-1), curve.points.at(-1));
  assertEquals(resized.points[10], {at:5, sek_per_unit:2});
  assertEquals(curve.points.length, 2);
});
Deno.test('moving a point does not mutate a published curve or reorder neighbours', () => {
  const draft = resizeCurve(curve, 3);
  const moved = moveCurvePoint(draft, 1, 6, 3);
  assertEquals(moved.points[1], {at:6, sek_per_unit:3});
  assertEquals(draft.points[1], {at:5, sek_per_unit:2});
  assertEquals(moveCurvePoint(draft, 1, 11, 3), draft);
  assertEquals(moveCurvePoint(draft, 1, 6, 8).points[1].sek_per_unit, 4);
});
