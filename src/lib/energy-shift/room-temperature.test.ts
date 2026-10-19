import { assertEquals } from 'jsr:@std/assert@1';
import { plannedRoomTemperatures } from './room-temperature.ts';
import { buildEnergyTimeline, SLOT_MS } from './energy-timeline.ts';

const NOW = Date.parse('2026-10-19T20:00:00Z');
const plan = {
  operating_scope: { modes: { floor: 'controlling', fan: 'monitoring' }, device_owners: { floor: 'floor', fan: 'fan' } },
  thermal_projection: { starts: [NOW, NOW + SLOT_MS].map(ms => new Date(ms).toISOString()), zones: [
    { key: 'bath', name: 'Bathroom', device_keys: ['floor'], planned_temperature_c: [21.5, 22], comfort_min_c: [21, 22] },
    { key: 'hall', name: 'Hall', device_keys: ['fan'], planned_temperature_c: [18, 18], comfort_min_c: [18, 18] },
  ] },
};

Deno.test('a planned room temperature is drawn at the end of its quarter, where a reading would be taken', () => {
  const rooms = plannedRoomTemperatures(plan);
  assertEquals(rooms.rooms, [{ key: 'bath', name: 'Bathroom', deviceKeys: ['floor'] }]);
  assertEquals(rooms.temperatureByStart.get(NOW + SLOT_MS), { bath: 21.5 });
  assertEquals(rooms.temperatureByStart.get(NOW + 2 * SLOT_MS), { bath: 22 });
  assertEquals(rooms.comfortMinByStart.get(NOW), { bath: 21 });
});

Deno.test('rooms are measured before now and planned after, like the pool', () => {
  const rows = buildEnergyTimeline({
    actuals: [{ start_ts: new Date(NOW - SLOT_MS).toISOString(), total_load_kwh: .2, solar_production_kwh: 0, grid_import_kwh: .2,
      grid_export_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0, battery_soc: null, ev_soc: null }],
    deviceActuals: [], prices: [], deviceKeyById: new Map(), nowMs: NOW,
    planSlots: [NOW, NOW + SLOT_MS].map(ms => ({ start: new Date(ms).toISOString(), device_loads_w: {} })) as never,
    roomActuals: [{ start_ts: new Date(NOW - SLOT_MS).toISOString(), room_key: 'bath', room_temperature_c: 20.8 },
      // A reading never stands in for the plan on the future side.
      { start_ts: new Date(NOW + SLOT_MS).toISOString(), room_key: 'bath', room_temperature_c: 25 }],
    roomPlan: plannedRoomTemperatures(plan),
  });
  assertEquals(rows.map(row => row.roomC ?? null), [{ bath: 20.8 }, null, { bath: 21.5 }]);
  assertEquals(rows.map(row => row.roomComfortMinC ?? null), [null, { bath: 21 }, { bath: 22 }]);
});
