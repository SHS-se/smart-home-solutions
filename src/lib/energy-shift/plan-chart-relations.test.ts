import { planChartRelations } from './plan-chart-relations.ts';
import { BUILTIN_RELATIONS, placeSeriesLabels, spotlightSeries, type EnergySeriesId } from '../../components/portal/energy/charts/series-interaction.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

Deno.test('linked spotlight follows explicit pool, car and room ownership, not colours or broad categories', () => {
  const relations = planChartRelations({
    series: ['pool-pump', 'pool-room-floor', 'car', 'shared-heater'].map(key => ({ key })),
    deviceModels: [
      { key: 'pool-pump', category: 'pool_heating', planning_service: 'pool' },
      { key: 'pool-room-floor', category: 'pool_heating', planning_service: 'room_heating' },
      { key: 'car', category: 'ev_charging' },
    ],
    rooms: [{ key: 'bath', deviceKeys: ['shared-heater'] }, { key: 'hall', deviceKeys: ['shared-heater', 'not-drawn'] }],
  });
  const lit = (id: EnergySeriesId) => [...spotlightSeries(id, [...BUILTIN_RELATIONS, ...relations])!].sort();
  equal(lit('temperature:pool'), ['load:pool-pump', 'temperature:pool']);
  equal(lit('soc:car'), ['load:car', 'soc:car']);
  equal(lit('room:bath'), ['load:shared-heater', 'room:bath']);
  equal(lit('load:shared-heater'), ['load:shared-heater', 'room:bath', 'room:hall']);
  equal(lit('soc:home'), ['flow:battery-in', 'flow:battery-out', 'soc:home']);
  equal(spotlightSeries(null, relations), null);
});

Deno.test('dense direct labels stay separated inside the data panel', () => {
  const positions = placeSeriesLabels([10, 35, 36, 36, 36, 37, 38, 39, 40], 0, 170);
  equal(positions.every((position, index) => position >= 9 && position <= 161
    && (index === 0 || position - positions[index - 1] >= 18)), true);
});
