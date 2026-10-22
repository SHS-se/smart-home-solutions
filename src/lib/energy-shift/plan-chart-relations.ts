import type { EnergySeriesRelation, EnergySeriesId } from '../../components/portal/energy/charts/series-interaction.ts';

/** Adapt explicit ownership to the individually rendered bands; no name or colour inference. */
export function planChartRelations(input: {
  series: readonly { key: string }[];
  deviceModels: readonly { key: string; category: string; planning_service?: string | null }[];
  rooms: readonly { key: string; deviceKeys: readonly string[] }[];
}): EnergySeriesRelation[] {
  const drawn = new Set(input.series.map(series => series.key));
  const loads = (keys: readonly string[]): EnergySeriesId[] => keys.filter(key => drawn.has(key)).map(key => `load:${key}` as const);
  return [
    ['temperature:pool', ...loads(input.deviceModels.filter(device => device.planning_service === 'pool').map(device => device.key))],
    ['soc:car', ...loads(input.deviceModels.filter(device => device.category === 'ev_charging').map(device => device.key))],
    ...input.rooms.map(room => [`room:${room.key}` as EnergySeriesId, ...loads(room.deviceKeys)]),
  ];
}
