import { createSeasonalThermalProjection } from './thermal-fixtures.ts';

const START = Date.parse('2026-01-15T00:00:00Z');

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test('every seasonal fixture contains one complete 72-hour projection', () => {
  for (const season of ['winter', 'spring', 'summer', 'autumn'] as const) {
    const projection = createSeasonalThermalProjection(season, START);
    assert(projection.starts.length === 288, `${season} horizon is incomplete`);
    assert(projection.outdoor_temperature_c.length === 288, `${season} weather is incomplete`);
    assert(projection.zones.length === 3, `${season} zones are missing`);
    for (const zone of projection.zones) {
      for (const values of [
        zone.comfort_min_c,
        zone.target_c,
        zone.comfort_max_c,
        zone.planned_temperature_c,
        zone.unplanned_temperature_c,
        zone.planned_power_w,
        zone.unplanned_power_w,
      ]) {
        assert(values.length === 288, `${season}/${zone.key} has a truncated series`);
        assert(values.every(Number.isFinite), `${season}/${zone.key} has a non-finite value`);
      }
    }
  }
});

Deno.test('coordinated thermal projection respects the whole-home heat budget', () => {
  const winter = createSeasonalThermalProjection('winter', START);
  assert(
    Math.max(...winter.planned_total_power_w) <= 2_700,
    'planned winter heat exceeded its coordinated envelope',
  );
  assert(
    Math.max(...winter.planned_total_power_w) <
      Math.max(...winter.unplanned_total_power_w),
    'coordination did not reduce coincident thermostat demand',
  );
  for (const [index, total] of winter.planned_total_power_w.entries()) {
    const summed = winter.zones.reduce(
      (value, zone) => value + zone.planned_power_w[index],
      0,
    );
    assert(Math.abs(total - summed) < 0.01, 'planned thermal total is inconsistent');
  }
});

Deno.test('summer and EV-only fixtures do not invent heating demand', () => {
  const winter = createSeasonalThermalProjection('winter', START);
  const summer = createSeasonalThermalProjection('summer', START);
  const evOnly = createSeasonalThermalProjection('ev_only', START);
  const energy = (values: number[]) =>
    values.reduce((sum, watts) => sum + watts / 4_000, 0);

  assert(
    energy(summer.planned_total_power_w) < energy(winter.planned_total_power_w) * 0.25,
    'summer heating is implausibly close to winter heating',
  );
  assert(evOnly.zones.length === 0, 'EV-only customer received thermal zones');
  assert(
    evOnly.planned_total_power_w.every(value => value === 0),
    'EV-only customer received thermal power',
  );
});
