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
});
