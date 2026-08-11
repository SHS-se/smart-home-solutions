import {
  foldDevicePowerIntoBase,
  reconcilePlanDeviceRoles,
} from './plan-device-roles.ts';

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
