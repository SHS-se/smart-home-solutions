import { assert, assertEquals } from 'jsr:@std/assert@1';
import { chartedTemperatureRooms, plannedRoomTemperatures, roomTemperatureSeries } from './room-temperature.ts';
import { buildEnergyTimeline, SLOT_MS } from './energy-timeline.ts';

// All fixture values are independently generated synthetic data.
const NOW = Date.parse('2026-10-19T20:00:00Z');
const plan = {
  operating_scope: { modes: { floor: 'controlling', fan: 'monitoring' }, device_owners: { floor: 'floor', fan: 'fan' } },
  thermal_projection: { initial_at: new Date(NOW + 7 * 60_000).toISOString(), starts: [NOW, NOW + SLOT_MS].map(ms => new Date(ms).toISOString()), zones: [
    { key: 'bath', name: 'Bathroom', initial_temperature_c: 20.9, observed_through: new Date(NOW).toISOString(), device_keys: ['floor'], planned_temperature_c: [21.5, 22], comfort_min_c: [21, 22] },
    { key: 'hall', name: 'Hall', device_keys: ['fan'], planned_temperature_c: [18, 18], comfort_min_c: [18, 18] },
  ] },
};

Deno.test('captured room state and endpoints retain exact times, including partial first quarter and horizon end', () => {
  const rooms = plannedRoomTemperatures(plan);
  assertEquals(rooms.rooms, [{ key: 'bath', name: 'Bathroom', deviceKeys: ['floor'] }]);
  assertEquals(rooms.samplesByStart.get(NOW)?.bath, [
    { atMs: NOW + 7 * 60_000, temperatureC: 20.9, kind: 'forecast' },
    { atMs: NOW + SLOT_MS, temperatureC: 21.5, kind: 'forecast' },
  ]);
  assertEquals(rooms.samplesByStart.get(NOW + SLOT_MS)?.bath, [
    { atMs: NOW + SLOT_MS, temperatureC: 21.5, kind: 'forecast' },
    { atMs: NOW + 2 * SLOT_MS, temperatureC: 22, kind: 'forecast' },
  ]);
  assertEquals(rooms.comfortMinByStart.get(NOW), { bath: 21 });
});

Deno.test('native interval means and forecast states retain separate provenance when later history arrives', () => {
  const input = {
    actuals: [], deviceActuals: [], prices: [], deviceKeyById: new Map(),
    planSlots: [NOW, NOW + SLOT_MS].map(ms => ({ start: new Date(ms).toISOString(), device_loads_w: {} })) as never,
    roomActuals: [
      { start_ts: new Date(NOW - SLOT_MS).toISOString(), room_key: 'bath', room_name: 'Bathroom', room_temperature_c: 20.8 },
      { start_ts: new Date(NOW).toISOString(), room_key: 'bath', room_name: 'Bathroom', room_temperature_c: 25 },
    ],
    roomPlan: plannedRoomTemperatures(plan),
  };
  const initial = buildEnergyTimeline({ ...input, nowMs: NOW + 8 * 60_000 });
  assertEquals(initial[0].roomTemperatures?.bath, [
    { atMs: NOW - SLOT_MS / 2, temperatureC: 20.8, kind: 'interval_mean' },
  ]);
  const captured = roomTemperatureSeries(initial, 'bath', 'forecast').filter(Boolean);
  const later = buildEnergyTimeline({ ...input, nowMs: NOW + SLOT_MS });
  assertEquals(later[1].roomTemperatures?.bath?.[0],
    { atMs: NOW + SLOT_MS / 2, temperatureC: 25, kind: 'interval_mean' });
  assertEquals(roomTemperatureSeries(later, 'bath', 'forecast').filter(Boolean), captured);
  assertEquals(captured.length, 3);
  // Windowing after capture starts at the previous published endpoint, never a newer actual.
  assertEquals(roomTemperatureSeries(later.slice(2), 'bath', 'forecast')[0],
    { atMs: NOW + SLOT_MS, temperatureC: 21.5, kind: 'forecast' });
});

Deno.test('older stored projections draw existing endpoints without an invented initial state', () => {
  const legacy = { ...plan, thermal_projection: { ...plan.thermal_projection, initial_at: undefined } };
  assertEquals(plannedRoomTemperatures(legacy).samplesByStart.get(NOW)?.bath, [
    { atMs: NOW + SLOT_MS, temperatureC: 21.5, kind: 'forecast' },
  ]);
});

Deno.test('measured rooms have names and heater colours without a forecast, including monitored rooms', () => {
  const actuals = [
    { start_ts: new Date(NOW - SLOT_MS).toISOString(), room_key: 'bath', room_name: 'Bathroom', room_temperature_c: 20.8 },
    { start_ts: new Date(NOW - SLOT_MS).toISOString(), room_key: 'hall', room_name: 'Hall', room_temperature_c: 18 },
  ];
  const devices = [{ device_key: 'floor', mapping_summary: { room_key: 'bath' } },
    { device_key: 'rack', mapping_summary: { room_key: 'bath' } }];
  const expected = [
    { key: 'bath', name: 'Bathroom', deviceKeys: ['floor', 'rack'] },
    { key: 'hall', name: 'Hall', deviceKeys: [] },
  ];
  assertEquals(chartedTemperatureRooms([], actuals, devices), expected);
  assertEquals(chartedTemperatureRooms(plannedRoomTemperatures(plan).rooms, actuals, devices), expected);
});

Deno.test('room readings survive missing forecasts and electricity history without becoming future predictions', () => {
  const roomActuals = [-3, -1, 1].map(quarter => ({
    start_ts: new Date(NOW + quarter * SLOT_MS).toISOString(),
    room_key: 'bath', room_name: 'Bathroom', room_temperature_c: 20.8,
  }));
  const rows = buildEnergyTimeline({ actuals: [], deviceActuals: [], prices: [], planSlots: [],
    deviceKeyById: new Map(), nowMs: NOW, roomActuals, roomPlan: plannedRoomTemperatures({}) });
  assertEquals(rows.map(row => row.startMs), [-3, -2, -1].map(q => NOW + q * SLOT_MS));
  assertEquals(rows.map(row => row.roomTemperatures?.bath?.[0].temperatureC ?? null), [20.8, null, 20.8]);
  assertEquals(roomTemperatureSeries(rows, 'bath', 'interval_mean').map(sample => sample?.temperatureC ?? null), [20.8, null, 20.8]);
  assert(roomTemperatureSeries(rows, 'bath', 'forecast').every(sample => sample === null));
  assertEquals(rows.every(row => row.missing && row.measured && row.loadW === null), true);
  assertEquals(rows.every(row => row.roomComfortMinC === undefined), true);
});

Deno.test('a missing published endpoint breaks the forecast instead of bridging an unknown quarter', () => {
  const incomplete = { ...plan, thermal_projection: { ...plan.thermal_projection,
    zones: plan.thermal_projection.zones.map(room => ({ ...room, planned_temperature_c: [NaN, 22] })),
  } };
  const rows = [...plannedRoomTemperatures(incomplete).samplesByStart.values()].map(roomTemperatures => ({ roomTemperatures }));
  assertEquals(roomTemperatureSeries(rows, 'bath', 'forecast'), [
    { atMs: NOW + 7 * 60_000, temperatureC: 20.9, kind: 'forecast' }, null,
    { atMs: NOW + 2 * SLOT_MS, temperatureC: 22, kind: 'forecast' },
  ]);
});
