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

/**
 * What the integration has actually delivered, as opposed to what it is
 * configured to deliver. Every field is measured from stored rows so the
 * panel can never claim readiness the data does not support.
 */
export interface ThermalObservationSummary {
  /** Quarters carrying at least one zone observation. */
  slotCount: number;
  /** Quarters carrying a measured outdoor temperature. */
  outdoorSlotCount: number;
  /** Device keys that contributed at least one observation. */
  observedDeviceKeys: string[];
  /** Oldest and newest observed quarter, ISO, or null when none exist. */
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

/** One zone's trained model, or the reason it could not be trained. */
export interface ThermalZoneModelSummary {
  device_key: string;
  trained: boolean;
  rejection_reason: string | null;
  sample_count: number;
}

export type ThermalReadinessState = 'ready' | 'waiting' | 'blocked';

export interface ThermalReadinessAssessment {
  selectedDevices: ThermalReadinessDevice[];
  mappingReadyCount: number;
  electricalHistoryReadyCount: number;
  electricalForecastReadyCount: number;
  electricalHistorySampleCount: number;
  mappingBlockers: ThermalReadinessDevice[];
  thermalObservedCount: number;
  thermalSlotCount: number;
  thermalState: ThermalReadinessState;
  outdoorSlotCount: number;
  outdoorState: ThermalReadinessState;
  trainedZoneCount: number;
  modelState: ThermalReadinessState;
  /** True only when nothing further is needed from Home Assistant. */
  pipelineComplete: boolean;
}

/** Quarters needed before a zone fit is worth attempting; five days. */
export const THERMAL_TRAINING_SLOTS = 480;

export const assessThermalReadiness = (
  devices: ThermalReadinessDevice[],
  planDevices: ThermalReadinessPlanDevice[],
  observations: ThermalObservationSummary = {
    slotCount: 0,
    outdoorSlotCount: 0,
    observedDeviceKeys: [],
    firstObservedAt: null,
    lastObservedAt: null,
  },
  zoneModels: ThermalZoneModelSummary[] = [],
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

  const observedKeys = new Set(observations.observedDeviceKeys);
  const thermalObservedCount = selectedDevices.filter(device =>
    observedKeys.has(device.device_key)).length;
  const trainedZoneCount = zoneModels.filter(model => model.trained).length;

  // Blocked means nothing is arriving and nothing will without a change.
  // Waiting means the pipeline works and only time is missing. Conflating
  // the two is what made the old panel unactionable.
  const thermalState: ThermalReadinessState = selectedDevices.length === 0
    ? 'blocked'
    : thermalObservedCount === 0
      ? 'blocked'
      : thermalObservedCount === selectedDevices.length
        ? 'ready'
        : 'waiting';
  const outdoorState: ThermalReadinessState = observations.outdoorSlotCount === 0
    ? 'blocked'
    : observations.outdoorSlotCount < observations.slotCount
      ? 'waiting'
      : 'ready';
  const modelState: ThermalReadinessState = trainedZoneCount > 0
    ? 'ready'
    : thermalState === 'blocked' || outdoorState === 'blocked'
      ? 'blocked'
      : 'waiting';

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
    thermalObservedCount,
    thermalSlotCount: observations.slotCount,
    thermalState,
    outdoorSlotCount: observations.outdoorSlotCount,
    outdoorState,
    trainedZoneCount,
    modelState,
    pipelineComplete: thermalState === 'ready' && outdoorState !== 'blocked',
  };
};
