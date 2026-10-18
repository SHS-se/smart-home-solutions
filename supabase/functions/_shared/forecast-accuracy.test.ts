import {assertEquals, assert} from '@std/assert';
import {calculateAccuracy, accuracyScore, nextAccuracyUpdate, type ForecastRecord, type AccuracySlot, type AccuracyActual, type PublishedPrice} from './forecast-accuracy.ts';

const past = '2026-10-16T12:00:00Z', next = '2026-10-17T18:00:00Z';
type Calculation = {historical: {bias_kwh: number; pairs: number; absolute_error_kwh: number}; gaps: number; plan_ids: string[];
  lag?: {minutes: number; absolute_error_kwh: number}[]};
const battery = (diagnostics: {key: string}[], key: string) => diagnostics.find(d => d.key === key) as unknown as Calculation;
function slot(start: string): AccuracySlot {return {start, duration_hours: .25, load_w: 2000, pv_w: 0,
  device_loads_w: {heater: 1000}, battery_charge_w: 0, battery_discharge_w: 0, battery_soc: .5};}
function record(plan_id: string, published_at: string, start: string): ForecastRecord {return {plan_id, published_at,
  forecast: {timezone: 'Europe/Stockholm', battery: false, devices: [{key: 'heater', name: 'Heater'}], slots: [slot(start)]}};}
function input() {return {scheduled_at: '2026-10-17T16:00:00Z', calculated_at: '2026-10-17T16:00:01Z', timezone: 'Europe/Stockholm',
  forecasts: [record('past', '2026-10-16T06:00:00Z', past), record('current', '2026-10-17T12:00:00Z', next)],
  actuals: [{start_ts: past, total_load_kwh: .5, solar_production_kwh: 0, battery_charge_kwh: 0,
    battery_discharge_kwh: 0, battery_soc: .5}] as AccuracyActual[],
  device_actuals: [{start_ts: past, device_key: 'heater', energy_kwh: .25}], prices: [] as PublishedPrice[]};}

Deno.test('historical accuracy uses measured pairs; the report has no forecast side', () => {
  const i = input();
  i.actuals[0].total_load_kwh = .75; // baseline actually .5, forecast .25: 50%.
  const {report, diagnostics} = calculateAccuracy(i);
  assertEquals(report.version, 2);
  assertEquals('forecast' in report, false);
  assertEquals(report.historical.devices.find(d => d.key === 'baseline')!.percentage, 50);
  assertEquals(report.historical.percentage, 67); // .5 matched / .75 larger.
  assertEquals(battery(diagnostics, 'baseline').historical.bias_kwh, -.25);
});

Deno.test('prices compare the last estimate before publication with the published price', () => {
  const i = input(), tomorrow = '2026-10-18T10:00:00Z';
  const estimate = (plan: string, at: string, value: number | null) => ({...record(plan, at, tomorrow),
    forecast: {...record(plan, at, tomorrow).forecast, slots: [{...slot(tomorrow), estimated_import_sek_per_kwh: value}]}});
  // An older estimate is superseded; a plan issued after publication carries no estimate.
  i.forecasts.push(estimate('early', '2026-10-16T20:00:00Z', 1), estimate('last', '2026-10-17T09:00:00Z', 2),
    estimate('published', '2026-10-17T13:00:00Z', null));
  i.prices = [{start_ts: tomorrow, import_price_sek_per_kwh: 2.5}, {start_ts: past, import_price_sek_per_kwh: 1}];
  const {report, diagnostics} = calculateAccuracy(i);
  assertEquals(report.prices, {percentage: 80, grade: 'lime', quarters: 1}); // 2 of 2.5
  const prices = diagnostics.find(d => d.key === 'prices') as unknown as {plan_ids: string[]; bias_sek_per_kwh: number};
  assertEquals(prices.plan_ids, ['last']);
  assertEquals(prices.bias_sek_per_kwh, -.5);
  assertEquals(calculateAccuracy(input()).report.prices, {percentage: null, grade: null, quarters: 0});
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
  assertEquals(battery(result.diagnostics, 'baseline').historical.pairs, 1);
  assertEquals(battery(result.diagnostics, 'baseline').plan_ids, ['past']);
});

Deno.test('missing device quarters cannot become zero or manufacture a residual baseline', () => {
  const i = input(); i.device_actuals = [];
  const result = calculateAccuracy(i);
  assertEquals(result.report.historical.percentage, null);
  assertEquals(result.report.historical.devices.find(d => d.key === 'baseline')!.percentage, null);
  assertEquals(battery(result.diagnostics, 'baseline').gaps, 1);
});

Deno.test('battery directions cannot cancel and lag diagnostics identify a delayed charge', () => {
  const i = input();
  i.forecasts.forEach(r => {r.forecast.battery = true;});
  i.forecasts[0].forecast.slots = [0,1,2].map(n => ({...slot(new Date(Date.parse(past) + n*900_000).toISOString()), battery_charge_w: n===0 ? 1000 : 0}));
  i.forecasts[1].forecast.slots[0].battery_charge_w = 1000;
  i.actuals = [0,1,2,3].map(n => ({...i.actuals[0], start_ts: new Date(Date.parse(past)+n*900_000).toISOString(), battery_charge_kwh: n===1 ? .25 : 0}));
  i.device_actuals = i.actuals.map(a => ({start_ts:a.start_ts, device_key:'heater', energy_kwh:.25}));
  const result = calculateAccuracy(i), calculation = battery(result.diagnostics, 'battery');
  assertEquals(result.report.historical.devices.find(d => d.key === 'battery')!.percentage, 0);
  assertEquals(calculation.lag!.find(l => l.minutes === 15)!.absolute_error_kwh, 0);
  assert(calculation.lag!.find(l => l.minutes === 0)!.absolute_error_kwh > 0);
  i.actuals[0].battery_discharge_kwh = .25;
  assert(battery(calculateAccuracy(i).diagnostics, 'battery').historical.absolute_error_kwh >= .5);
});

Deno.test('five grade boundaries and zero-volume evidence are explicit', () => {
  for (const [n, grade] of [[90,'green'],[89,'lime'],[80,'lime'],[79,'yellow'],[70,'yellow'],[69,'orange'],[60,'orange'],[59,'red']] as const)
    assertEquals(accuracyScore(n,100).grade,grade);
  assertEquals(accuracyScore(0,0), {percentage:null,grade:null});
  assertEquals(accuracyScore(0,1), {percentage:0,grade:'red'});
  assertEquals(calculateAccuracy({...input(), forecasts: []}).report.historical.percentage, null);
});

Deno.test('one missed stretch cannot outweigh agreement elsewhere; over- and under-delivery score alike', () => {
  const i = input();
  i.forecasts.forEach(r => {r.forecast.battery = true;});
  // Two quarters: a planned charge that never happened, then one followed exactly.
  i.forecasts[0].forecast.slots = [0,1].map(n => ({...slot(new Date(Date.parse(past) + n*900_000).toISOString()), battery_charge_w: 2000}));
  i.actuals = [0,1].map(n => ({...i.actuals[0], start_ts: new Date(Date.parse(past)+n*900_000).toISOString(), battery_charge_kwh: n ? .5 : 0}));
  i.device_actuals = i.actuals.map(a => ({start_ts:a.start_ts, device_key:'heater', energy_kwh:.25}));
  const score = () => calculateAccuracy(i).report.historical.devices.find(d => d.key === 'battery')!.percentage;
  assertEquals(score(), 50); // .5 matched / 1 larger; the old error/actual ratio gave 0.
  i.forecasts[0].forecast.slots[1].battery_charge_w = 0; i.actuals[1].battery_charge_kwh = 0; // an idle quarter scores nothing
  i.actuals[0].battery_charge_kwh = .25; // half of the planned .5
  assertEquals(score(), 50);
  i.actuals[0].battery_charge_kwh = 1; // twice the planned .5
  assertEquals(score(), 50, 'missing by half and doubling are equally wrong');
});

Deno.test('the next update is the next local 06:00 or 18:00, across a DST change', () => {
  const tz = 'Europe/Stockholm';
  assertEquals(nextAccuracyUpdate(Date.parse('2026-10-18T03:59:00Z'), tz), {day: 'today', time: '06:00'});
  assertEquals(nextAccuracyUpdate(Date.parse('2026-10-18T04:00:30Z'), tz), {day: 'today', time: '18:00'});
  assertEquals(nextAccuracyUpdate(Date.parse('2026-10-18T16:00:00Z'), tz), {day: 'tomorrow', time: '06:00'});
  // 25 Oct: clocks go back at 03:00 CEST; 04:30Z is 05:30 CET.
  assertEquals(nextAccuracyUpdate(Date.parse('2026-10-25T04:30:00Z'), tz), {day: 'today', time: '06:00'});
});
