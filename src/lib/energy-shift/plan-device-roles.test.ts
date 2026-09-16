import {
  foldDevicePowerIntoBase,
  reconcilePlanDeviceRoles,
} from './plan-device-roles.ts';
import { splitConsumption } from './consumption-series.ts';

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test('a base-load role removes the device series and preserves displayed load', () => {
  const plannedModels = [{ key: 'heater' }, { key: 'ev' }];
  const view = reconcilePlanDeviceRoles(plannedModels, [
    { device_key: 'heater', planning_role_override: 'base_load' },
    { device_key: 'ev', planning_role_override: 'controllable' },
  ]);

  assertEquals(view.visibleModels, [{ key: 'ev' }], 'visible models');
  assertEquals(view.baseLoadModels, [{ key: 'heater' }], 'base-load models');
  assertEquals(view.requiresPlanRefresh, true, 'plan refresh state');

  const originalTotalW = 600 + 275 + 400;
  const displayedTotalW = foldDevicePowerIntoBase(
    600,
    { heater: 275, ev: 400 },
    view.baseLoadModels,
  ) + 400;
  assertEquals(displayedTotalW, originalTotalW, 'displayed power total');
});

Deno.test('an issued plan model stays visible until its current role is known', () => {
  const view = reconcilePlanDeviceRoles([{ key: 'demo-device' }], []);

  assertEquals(view.visibleModels, [{ key: 'demo-device' }], 'visible demo model');
  assertEquals(view.baseLoadModels, [], 'base-load demo models');
  assertEquals(view.requiresPlanRefresh, false, 'demo refresh state');
});

Deno.test('a newly controllable device waits for the next plan', () => {
  const view = reconcilePlanDeviceRoles([], [
    { device_key: 'heater', planning_role_override: 'controllable' },
  ]);

  assertEquals(view.requiresPlanRefresh, true, 'plan refresh state');
});

Deno.test('the consumption chart schedules only Planned meters and keeps Monitored demand in base', () => {
  const view = reconcilePlanDeviceRoles([{ key: 'pump' }, { key: 'heater' }], [
    { device_key: 'pump', planning_role_override: 'controllable' },
    { device_key: 'heater', planning_role_override: 'base_load' },
    { device_key: 'fridge', planning_role_override: 'base_load' },
  ]);
  const plannedKeys = new Set(view.visibleModels.map(model => model.key));
  const consumption = splitConsumption([
    { key: 'pump', name: 'Pump', values: [764, 764, 764, 764] },
    { key: 'heater', name: 'Heater', values: [1311, 1311, 1311, 1311] },
    { key: 'fridge', name: 'Fridge', values: [100, 100, 100, 100] },
  ].map(meter => ({ ...meter, schedulable: plannedKeys.has(meter.key) })), [2500, 2500, 2500, 2500]);
  assertEquals(consumption.series.map(series => series.key), ['pump'], 'only the Planned pump is scheduled');
  assertEquals(consumption.baseValues, [1736, 1736, 1736, 1736], 'Monitored demand remains in household load');
  assertEquals(consumption.foldedCount, 2, 'both Monitored meters remain in base');
});
