import {assertEquals} from '@std/assert';
import {roomOutdoorSeries} from './room-outdoor.ts';
import {connectedRoomSnapshot} from './room-network.fixture.ts';
import {prepareRoomServices} from './rules-room-services.ts';

// Independently synthetic weather and room network.
Deno.test('room weather keeps provider quarters and cold-side estimates newest, interior and complete gaps', () => {
  const s = connectedRoomSnapshot(true);
  s.room_outdoor_estimate_c = -2;
  for (const gaps of [[s.slots.length - 1], [4], s.slots.map((_, i) => i)]) {
    s.outdoor_temperature_c = s.slots.map((_, i) => gaps.includes(i) ? null : 5);
    const result = prepareRoomServices(s);
    assertEquals(result.warnings.some(w => w.code === 'room_evidence_unavailable'), false);
    assertEquals(result.temperature['synthetic-a'].every(Number.isFinite), true);
    assertEquals(roomOutdoorSeries(s), s.slots.map((_, i) => gaps.includes(i) ? -2 : 5));
  }
  delete s.outdoor_temperature_c;
  assertEquals(roomOutdoorSeries(s), s.slots.map(() => -2));
});
Deno.test('absent weather with no observation basis retains demand and comfort without an internal exception', () => {
  const s = connectedRoomSnapshot(true); delete s.outdoor_temperature_c;
  assertEquals(roomOutdoorSeries(s), null);
  const result = prepareRoomServices(s);
  assertEquals(result.warnings.some(w => w.code === 'room_evidence_unavailable'), false);
  assertEquals(result.room_power['synthetic-a'], s.slots.map(() => 500));
});
