export interface ThermalReadinessDevice {
  device_key: string;
  name: string;
  planning_role_override: 'base_load' | 'controllable';
  control_type_override: string | null;
  mapping_status: 'not_configured' | 'ready' | 'invalid';
  mapped_control_type: string | null;
  mapping_error: string | null;
  profile_sample_count: number;
}

export interface ThermalReadinessPlanDevice {
  key: string;
  control_type: string;
}

export interface ThermalReadinessAssessment {
  selectedDevices: ThermalReadinessDevice[];
  mappingReadyCount: number;
  electricalHistoryReadyCount: number;
  electricalForecastReadyCount: number;
  electricalHistorySampleCount: number;
  mappingBlockers: ThermalReadinessDevice[];
}

export const assessThermalReadiness = (
  devices: ThermalReadinessDevice[],
  planDevices: ThermalReadinessPlanDevice[],
): ThermalReadinessAssessment => {
  const selectedDevices = devices.filter(device =>
    device.planning_role_override === 'controllable'
    && device.control_type_override === 'setpoint');
  const plannedKeys = new Set(
    planDevices
      .filter(device => device.control_type === 'setpoint')
      .map(device => device.key),
  );
  const mappingReady = (device: ThermalReadinessDevice) =>
    device.mapping_status === 'ready'
    && device.mapped_control_type === device.control_type_override;

  return {
    selectedDevices,
    mappingReadyCount: selectedDevices.filter(mappingReady).length,
    electricalHistoryReadyCount: selectedDevices.filter(device =>
      device.profile_sample_count > 0).length,
    electricalForecastReadyCount: selectedDevices.filter(device =>
      plannedKeys.has(device.device_key)).length,
    electricalHistorySampleCount: selectedDevices.reduce(
      (total, device) => total + device.profile_sample_count,
      0,
    ),
    mappingBlockers: selectedDevices.filter(device => !mappingReady(device)),
  };
};
