import {assertEquals, assert} from '@std/assert';
import {calculateAccuracy, accuracyScore, type ForecastRecord, type AccuracySlot, type AccuracyActual} from './forecast-accuracy.ts';

const past = '2026-10-16T12:00:00Z', next = '2026-10-17T18:00:00Z';
function slot(start: string): AccuracySlot {return {start, duration_hours: .25, load_w: 2000, pv_w: 0,
  device_loads_w: {heater: 1000}, battery_charge_w: 0, battery_discharge_w: 0, battery_soc: .5};}
function record(plan_id: string, published_at: string, start: string): ForecastRecord {return {plan_id, published_at,
  forecast: {timezone: 'Europe/Stockholm', battery: false, devices: [{key: 'heater', name: 'Heater'}], slots: [slot(start)]}};}
function input() {return {scheduled_at: '2026-10-17T16:00:00Z', calculated_at: '2026-10-17T16:00:01Z', timezone: 'Europe/Stockholm',
  forecasts: [record('past', '2026-10-16T06:00:00Z', past), record('current', '2026-10-17T12:00:00Z', next)],
  actuals: [{start_ts: past, total_load_kwh: .5, solar_production_kwh: 0, battery_charge_kwh: 0,
    battery_discharge_kwh: 0, battery_soc: .5}] as AccuracyActual[],
  device_actuals: [{start_ts: past, device_key: 'heater', energy_kwh: .25}]};}

Deno.test('current forecast is estimated from matching lead errors; historical uses measured pairs', () => {
  const i = input();
  i.actuals[0].total_load_kwh = .75; // baseline actually .5, forecast .25: 50%.
  const {report, diagnostics} = calculateAccuracy(i);
  assertEquals(report.forecast_plan_id, 'current');
  assertEquals(report.forecast.devices.find(d => d.key === 'baseline')!.percentage, 50);
  assertEquals(report.historical.devices.find(d => d.key === 'baseline')!.percentage, 50);
  assertEquals(report.forecast.percentage, 75); // weights the current .25 + .25 forecast.
  assertEquals(report.historical.percentage, 67); // .25 error / .75 actual.
  assertEquals(diagnostics.find(d => d.key === 'baseline')!.historical.bias_kwh, -.25);
  i.forecasts[1].forecast.slots[0].start = '2026-10-18T18:00:00Z';
  assertEquals(calculateAccuracy(i).report.forecast.percentage, null, 'unobserved lead is unscored');
});

Deno.test('as-issued history selects the last pre-quarter publication, never hindsight or overlapping duplicates', () => {
  const i = input();
  const obsolete = record('obsolete', '2026-10-16T05:00:00Z', past);
  obsolete.forecast.slots[0].load_w = 4000;
  const hindsight = record('hindsight', '2026-10-16T12:05:00Z', past);
  hindsight.forecast.slots[0].load_w = 9000;
  i.forecasts.push(obsolete, hindsight);
  const result = calculateAccuracy(i);
  assertEquals(result.report.historical.percentage, 100);
  assertEquals(result.diagnostics.find(d => d.key === 'baseline')!.historical.pairs, 1);
  assertEquals(result.diagnostics.find(d => d.key === 'baseline')!.plan_ids, ['past']);
});

Deno.test('missing device quarters cannot become zero or manufacture a residual baseline', () => {
  const i = input(); i.device_actuals = [];
  const result = calculateAccuracy(i);
  assertEquals(result.report.historical.percentage, null);
  assertEquals(result.report.historical.devices.find(d => d.key === 'baseline')!.percentage, null);
  assertEquals(result.diagnostics.find(d => d.key === 'baseline')!.gaps, 1);
});

Deno.test('battery directions cannot cancel and lag diagnostics identify a delayed charge', () => {
  const i = input();
  i.forecasts.forEach(r => {r.forecast.battery = true;});
  i.forecasts[0].forecast.slots = [0,1,2].map(n => ({...slot(new Date(Date.parse(past) + n*900_000).toISOString()), battery_charge_w: n===0 ? 1000 : 0}));
  i.forecasts[1].forecast.slots[0].battery_charge_w = 1000;
  i.actuals = [0,1,2,3].map(n => ({...i.actuals[0], start_ts: new Date(Date.parse(past)+n*900_000).toISOString(), battery_charge_kwh: n===1 ? .25 : 0}));
  i.device_actuals = i.actuals.map(a => ({start_ts:a.start_ts, device_key:'heater', energy_kwh:.25}));
  const result = calculateAccuracy(i), battery = result.diagnostics.find(d => d.key === 'battery')!;
  assertEquals(result.report.historical.devices.find(d => d.key === 'battery')!.percentage, 0);
  assertEquals(battery.lag!.find(l => l.minutes === 15)!.absolute_error_kwh, 0);
  assert(battery.lag!.find(l => l.minutes === 0)!.absolute_error_kwh > 0);
  i.actuals[0].battery_discharge_kwh = .25;
  assert(calculateAccuracy(i).diagnostics.find(d => d.key === 'battery')!.historical.absolute_error_kwh >= .5);
});

Deno.test('five grade boundaries and zero-volume evidence are explicit', () => {
  for (const [n, grade] of [[90,'green'],[89,'lime'],[80,'lime'],[79,'yellow'],[70,'yellow'],[69,'orange'],[60,'orange'],[59,'red']] as const)
    assertEquals(accuracyScore(100-n,100,100).grade,grade);
  assertEquals(accuracyScore(0,0,0), {percentage:null,grade:null});
  assertEquals(accuracyScore(1,0,1), {percentage:0,grade:'red'});
  assertEquals(calculateAccuracy({...input(), forecasts: []}).report.forecast.percentage, null);
});
