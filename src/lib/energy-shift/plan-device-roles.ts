import type { DevicePlanningRole } from './contracts.ts';

interface PlannedDeviceModel {
  key: string;
}

export interface DevicePlanningRoleSelection {
  device_key: string;
  planning_role_override: DevicePlanningRole;
}

export interface PlanDeviceRoleView<T extends PlannedDeviceModel> {
  visibleModels: T[];
  baseLoadModels: T[];
  requiresPlanRefresh: boolean;
}

export const reconcilePlanDeviceRoles = <T extends PlannedDeviceModel>(
  plannedModels: readonly T[],
  configuredDevices: readonly DevicePlanningRoleSelection[],
): PlanDeviceRoleView<T> => {
  const configuredRoleByKey = new Map(
    configuredDevices.map(device => [
      device.device_key,
      device.planning_role_override,
    ]),
  );
  const plannedKeys = new Set(plannedModels.map(model => model.key));
  const visibleModels: T[] = [];
  const baseLoadModels: T[] = [];

  for (const model of plannedModels) {
    if (configuredRoleByKey.get(model.key) === 'base_load') {
      baseLoadModels.push(model);
    } else {
      visibleModels.push(model);
    }
  }

  const newlyControllableDeviceMissingFromPlan = configuredDevices.some(device =>
    device.planning_role_override === 'controllable'
    && !plannedKeys.has(device.device_key)
  );

  return {
    visibleModels,
    baseLoadModels,
    requiresPlanRefresh: baseLoadModels.length > 0
      || newlyControllableDeviceMissingFromPlan,
  };
};

export const foldDevicePowerIntoBase = (
  basePowerW: number,
  deviceLoadsW: Readonly<Record<string, number>>,
  baseLoadModels: readonly PlannedDeviceModel[],
): number => baseLoadModels.reduce(
  (total, model) => total + (deviceLoadsW[model.key] ?? 0),
  basePowerW,
);
