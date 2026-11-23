import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { fitTrend, trendAt, trendSlopeAt, trendZero } from './room-run-trend.ts';
import { roomRunPoints } from './room-run-points.ts';

// Deterministic synthetic scatter; no household measurements.
const noise = (i: number) => {
  const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v) - 0.5;
};

Deno.test('a constant response with honest noise is reported flat', () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ x: -15 + i * 1.5, y: 2 + noise(i) * 0.3, se: 0.3 }));
  const trend = fitTrend(points, 'response')!;
  assertEquals(trend.degree, 0);
  assertAlmostEquals(trendAt(trend, 0).y, 2, 0.15);
});

Deno.test('a real slope is kept and extra scatter widens its band', () => {
  const points = Array.from({ length: 16 }, (_, i) => ({ x: -15 + i * 2, y: 3 - 0.1 * (-15 + i * 2) + noise(i) * 0.05, se: 0.05 }));
  const trend = fitTrend(points, 'response')!;
  assertEquals(trend.degree, 1);
  assertAlmostEquals(trendAt(trend, 10).y, 2, 0.1);
  const scattered = fitTrend(points.map((p, i) => ({ ...p, y: p.y + noise(i + 3) })), 'response')!;
  assert(trendAt(scattered, 0).se > trendAt(trend, 0).se * 3);
});

Deno.test('a cool-down may bow steeper in the cold once enough runs support it', () => {
  const curve = (x: number) => 0.0025 * (20 - x) ** 2;
  const many = Array.from({ length: 24 }, (_, i) => ({ x: -18 + i * 1.5, y: curve(-18 + i * 1.5) + noise(i) * 0.02 }));
  assertEquals(fitTrend(many, 'cooling')!.degree, 2);
  // Three runs in one narrow window cannot support a slope at all.
  const narrow = [0, 1, 2].map(i => ({ x: i, y: curve(i) + noise(i) * 0.02 }));
  assertEquals(fitTrend(narrow, 'cooling')!.degree, 0);
  // A gentle measured fall stays a falling line even when noise makes flat competitive.
  const gentle = Array.from({ length: 24 }, (_, i) => { const x = -10 + i; return { x, y: 0.3 - 0.004 * x + noise(i) * 0.15 }; });
  const weak = fitTrend(gentle, 'cooling')!;
  assertEquals(weak.degree, 1);
  assert(trendSlopeAt(weak, 0) < 0);
});

Deno.test('a cool-down never turns upward in warmer weather, inside or beyond the measured runs', () => {
  // A U: falling in the cold, rising again from 5 °C.
  const u = Array.from({ length: 30 }, (_, i) => { const x = -12 + i; return { x, y: 0.2 + 0.002 * (x - 5) ** 2 + noise(i) * 0.01 }; });
  const trend = fitTrend(u, 'cooling')!;
  for (let x = -25; x <= 30; x += 0.5) assert(trendSlopeAt(trend, x) <= 1e-12, `slope at ${x}`);
  for (let x = trend.maxX; x <= 30; x += 1) assert(trendAt(trend, x + 1).y <= trendAt(trend, x).y + 1e-12);
  // Rising runs are not physical; with no allowed slope the trend is flat and says so.
  const rising = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0.05 + 0.01 * i + noise(i) * 0.002 }));
  const flat = fitTrend(rising, 'cooling')!;
  assertEquals(flat.degree, 0);
  assertEquals(flat.constrained, true);
});

Deno.test('heating response is flat or straight, never curved and never reaching zero', () => {
  const curve = Array.from({ length: 24 }, (_, i) => { const x = -15 + i * 1.5; return { x, y: 2 + 0.01 * x * x + noise(i) * 0.02, se: 0.02 }; });
  assert(fitTrend(curve, 'response')!.degree <= 1);
  // A straight fit that would fall to zero within the runs is a non-physical heater.
  const falling = Array.from({ length: 20 }, (_, i) => { const x = -10 + i; return { x, y: Math.max(0.05, 1 - 0.2 * x) + noise(i) * 0.01, se: 0.05 }; });
  const trend = fitTrend(falling, 'response')!;
  assertEquals(trend.degree, 0);
  assert(trendAt(trend, trend.maxX).y > 0);
});

Deno.test('the cooling trend crosses zero at the temperature the room holds unheated', () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ x: -10 + i * 2, y: 0.05 * (12 - (-10 + i * 2)) }));
  const trend = fitTrend(points, 'cooling')!;
  assertAlmostEquals(trendZero(trend, -20, 25)!, 12, 0.05);
  // Without stated uncertainties, the band reflects the observed scatter.
  const tight = fitTrend(points.map((p, i) => ({ ...p, y: p.y + noise(i) * 0.01 })), 'cooling')!;
  assert(trendAt(tight, 0).se < 0.01);
});

Deno.test('ledger runs merge across scopes, prefer their own band and tolerate older entries', () => {
  const base = { from_ms: 0, to_ms: 3_600_000, measured_wh: 1500, transitions: 6, gain: 0.002, gain_se: 0.0003,
    change_at_ms: null, change_size: null, change_phase: null, disposition: 'fitted' };
  const { points, skipped } = roomRunPoints([
    { scope_key: 'general', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [{ ...base, id: 'a', outdoor_c: -7 }] } },
    { scope_key: '-10', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [{ ...base, id: 'a', gain: 0.0021, outdoor_c: -7 }] } },
    { scope_key: '-5', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [{ ...base, id: 'a', gain: 0.0019, outdoor_c: -7 },
      { ...base, id: 'b' }, { id: 'broken' }] } },
    { scope_key: '0', created_at: '2026-01-01T00:00:00Z', evidence: null },
  ]);
  assertEquals(points.map(p => p.id), ['a', 'b']);
  assertEquals(points[0].scope, '-10');
  assertAlmostEquals(points[0].gain!, 2.1, 1e-9);
  // An entry written before runs recorded their outdoor temperature stays listed, unplaced.
  assertEquals(points[1].outdoorC, null);
  assertEquals(skipped, 2);
});
