import { assertEquals } from '@std/assert';
import { controlledRooms, type PlannedRoom } from './controlled-rooms.ts';

const room = (key: string, device_keys?: string[]): PlannedRoom =>
  ({ key, name: key, device_keys, planned_temperature_c: [21], comfort_min_c: [21] });

Deno.test('only rooms with a heater in control verification or controlling are driven by the plan', () => {
  const plan = {
    operating_scope: {
      modes: { $battery: 'controlling', floor: 'control_verification', radiator: 'controlling', fan: 'monitoring', spare: 'planning' },
      device_owners: { floor: 'floor', radiator: 'radiator', fan: 'fan', spare: 'spare' },
    },
    thermal_projection: { starts: ['2026-10-19T20:00:00Z'], zones: [
      room('bath', ['floor']), room('bed', ['fan', 'radiator']), room('hall', ['fan', 'spare']), room('old'),
    ] },
  };
  assertEquals(controlledRooms(plan).map(r => r.key), ['bath', 'bed']);
  assertEquals(controlledRooms({ thermal_projection: plan.thermal_projection }), []);
});
