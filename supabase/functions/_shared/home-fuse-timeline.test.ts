import { assertEquals } from '@std/assert';
import { homeFusePeriods } from './home-fuse-timeline.ts';
Deno.test('known fuse changes preserve earlier subscriptions', () => {
  assertEquals(homeFusePeriods(25, [{ changed_on: '2026-09-11', previous_fuse_a: 35 }]), [
    { valid_from: null, fuse_a: 35 }, { valid_from: '2026-09-11', fuse_a: 25 },
  ]);
  assertEquals(homeFusePeriods(25, []), [{ valid_from: null, fuse_a: 25 }]);
  assertEquals(homeFusePeriods(16, [
    { changed_on: '2026-10-01', previous_fuse_a: 25 }, { changed_on: '2026-09-11', previous_fuse_a: 35 },
  ]), [{ valid_from: null, fuse_a: 35 }, { valid_from: '2026-09-11', fuse_a: 25 }, { valid_from: '2026-10-01', fuse_a: 16 }]);
});
