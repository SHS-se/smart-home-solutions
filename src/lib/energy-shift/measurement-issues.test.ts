import { assertEquals } from 'jsr:@std/assert@1';
import { describeMeasurementIssue, planMeasurementIssues } from './measurement-issues.ts';

const en = (_sv: string, english: string) => english;
const sv = (swedish: string) => swedish;

Deno.test('impossible readings are described per device in both languages', () => {
  const issue = {
    device: 'ev' as const, field: 'soc', entity_id: 'sensor.ev_soc', value: 1.05,
    reason: 'The car reported a state of charge of 105%, outside 0–100%.', detected_by: 'planner' as const,
  };
  assertEquals(describeMeasurementIssue(issue, en), 'Car: the state of charge reads 105 %, which cannot be right.');
  assertEquals(describeMeasurementIssue(issue, sv), 'Bilen: laddnivån visar 105 %, vilket inte kan stämma.');
  assertEquals(
    describeMeasurementIssue({ ...issue, device: 'pool', field: 'water_temperature_c', value: 'unavailable' }, en),
    'Pool: the water temperature has no usable reading ("unavailable").',
  );
  // An unknown reading keeps the planner's own sentence.
  assertEquals(describeMeasurementIssue({ ...issue, field: 'phase_count' }, en), `Car: ${issue.reason}`);
});

Deno.test('plans issued before measurement issues existed carry none', () => {
  assertEquals(planMeasurementIssues(null), []);
  assertEquals(planMeasurementIssues({}), []);
});
