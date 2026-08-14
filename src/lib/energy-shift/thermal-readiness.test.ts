import { assessThermalReadiness } from './thermal-readiness.ts';

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test('thermal readiness distinguishes electrical data from missing thermal telemetry', () => {
  const assessment = assessThermalReadiness([
    {
      device_key: 'office-heater',
      name: 'Office heater',
      planning_role_override: 'controllable',
      control_type_override: 'setpoint',
      mapping_status: 'ready',
      mapped_control_type: 'setpoint',
      mapping_error: null,
      mapping_summary: {
        room_key: 'office',
        room_name: 'Office',
        controlled_devices: ['climate.office_heater'],
      },
      profile_sample_count: 960,
    },
    {
      device_key: 'kitchen-heater',
      name: 'Kitchen heater',
      planning_role_override: 'controllable',
      control_type_override: 'setpoint',
      mapping_status: 'invalid',
      mapped_control_type: 'setpoint',
      mapping_error: 'temperature entity is unavailable',
      profile_sample_count: 400,
    },
    {
      device_key: 'fridge',
      name: 'Fridge',
      planning_role_override: 'base_load',
      control_type_override: null,
      mapping_status: 'not_configured',
      mapped_control_type: null,
      mapping_error: null,
      profile_sample_count: 960,
    },
  ], [
    { key: 'office-heater', control_type: 'setpoint' },
  ]);

  assertEquals(assessment.selectedDevices.length, 2, 'selected heater count');
  assertEquals(assessment.mappingReadyCount, 1, 'ready mapping count');
  assertEquals(assessment.electricalHistoryReadyCount, 2, 'history count');
  assertEquals(assessment.electricalForecastReadyCount, 1, 'forecast count');
  assertEquals(assessment.electricalHistorySampleCount, 1360, 'sample count');
  assertEquals(
    assessment.mappingBlockers.map(device => device.device_key),
    ['kitchen-heater'],
    'mapping blockers',
  );
  assertEquals(assessment.thermalState, 'blocked', 'no observations yet');
  assertEquals(assessment.outdoorState, 'blocked', 'no outdoor source yet');
  assertEquals(assessment.modelState, 'blocked', 'training cannot start');
  assertEquals(assessment.pipelineComplete, false, 'pipeline incomplete');
});

const heater = (device_key: string, room_key = device_key) => ({
  device_key,
  name: device_key,
  planning_role_override: 'controllable' as const,
  control_type_override: 'setpoint',
  mapping_status: 'ready' as const,
  mapped_control_type: 'setpoint',
  mapping_error: null,
  mapping_summary: {
    room_key,
    room_name: room_key,
    controlled_devices: [`climate.${device_key}`],
  },
  profile_sample_count: 960,
});

Deno.test('a partially reporting home is waiting, not blocked', () => {
  // One zone arriving proves the pipeline works, so the remaining zones are
  // a matter of time rather than a configuration fault.
  const assessment = assessThermalReadiness(
    [heater('office-heater', 'office'), heater('kitchen-heater', 'kitchen')],
    [],
    {
      slotCount: 200,
      outdoorSlotCount: 200,
      observedRoomKeys: ['office'],
      firstObservedAt: '2026-08-10T00:00:00Z',
      lastObservedAt: '2026-08-12T00:00:00Z',
    },
  );
  assertEquals(assessment.thermalObservedCount, 1, 'observed zone count');
  assertEquals(assessment.thermalState, 'waiting', 'partial reporting waits');
  assertEquals(assessment.outdoorState, 'ready', 'outdoor covers every slot');
  assertEquals(assessment.modelState, 'waiting', 'training still accruing');
  assertEquals(assessment.pipelineComplete, false, 'not every zone reports');
});

Deno.test('a fully reporting home with a fitted zone is ready', () => {
  const assessment = assessThermalReadiness(
    [heater('office-heater', 'office')],
    [],
    {
      slotCount: 2880,
      outdoorSlotCount: 2880,
      observedRoomKeys: ['office'],
      firstObservedAt: '2026-07-13T00:00:00Z',
      lastObservedAt: '2026-08-12T00:00:00Z',
    },
    [{
      room_key: 'office',
      trained: true,
      rejection_reason: null,
      sample_count: 2880,
    }],
  );
  assertEquals(assessment.thermalState, 'ready', 'every zone reports');
  assertEquals(assessment.trainedZoneCount, 1, 'fitted zone count');
  assertEquals(assessment.modelState, 'ready', 'a fitted model is ready');
  assertEquals(assessment.pipelineComplete, true, 'nothing left to deliver');
});

Deno.test('zones reporting without an outdoor source cannot train', () => {
  const assessment = assessThermalReadiness(
    [heater('office-heater', 'office')],
    [],
    {
      slotCount: 2880,
      outdoorSlotCount: 0,
      observedRoomKeys: ['office'],
      firstObservedAt: '2026-07-13T00:00:00Z',
      lastObservedAt: '2026-08-12T00:00:00Z',
    },
  );
  assertEquals(assessment.thermalState, 'ready', 'zones are reporting');
  assertEquals(assessment.outdoorState, 'blocked', 'no outdoor temperature');
  assertEquals(assessment.modelState, 'blocked', 'heat loss is unidentifiable');
});
