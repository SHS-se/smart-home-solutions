import { assertEquals, assertRejects } from '@std/assert';
import { mapConcurrent } from './map-concurrent.ts';

Deno.test('history readers refill independently, stay bounded and preserve chronological results', async () => {
  const started: number[] = [], finish = new Map<number, (value: string) => void>();
  const result = mapConcurrent([0, 1, 2, 3, 4], 3, (_, i) => {
    started.push(i);
    return new Promise<string>(resolve => finish.set(i, resolve));
  });
  assertEquals(started, [0, 1, 2]);
  finish.get(1)!('week-1'); await Promise.resolve();
  assertEquals(started, [0, 1, 2, 3]);
  finish.get(3)!('week-3'); await Promise.resolve();
  assertEquals(started, [0, 1, 2, 3, 4]);
  for (const i of [4, 2, 0]) finish.get(i)!(`week-${i}`);
  assertEquals(await result, ['week-0', 'week-1', 'week-2', 'week-3', 'week-4']);
});

Deno.test('a failed history read rejects and stops scheduling further windows', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  await assertRejects(() => mapConcurrent([0, 1, 2, 3], 2, async (_, i) => {
    started.push(i);
    if (i === 0) throw new Error('History unavailable');
    await pending;
    return i;
  }), Error, 'History unavailable');
  release(); await Promise.resolve();
  assertEquals(started, [0, 1]);
  assertEquals(await mapConcurrent([], 3, async () => 0), []);
});
