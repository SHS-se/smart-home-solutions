export interface SimulateDayInputs {
  indoorTempC: number;
  outdoorTempC: number;
  UA: number;
  baseW: number;
  shiftableW: number;
  fixedActiveW: number;
  scenario: 'dumb' | 'smart';
}

export interface TimeseriesPoint {
  time: string;
  total: number;
  heating: number;
  shiftable: number;
  fixedActive: number;
  base: number;
}

export interface SimulateDayResult {
  timeseries: TimeseriesPoint[];
  dailyKwh: number;
  dailyKwhByCategory: { heating: number; base: number; shiftable: number; fixedActive: number };
  peakW: number;
  avgW: number;
}

export function simulateDay(inputs: SimulateDayInputs): SimulateDayResult {
  const { indoorTempC, outdoorTempC, UA, baseW, shiftableW, fixedActiveW, scenario } = inputs;

  const timeseries: TimeseriesPoint[] = Array.from({ length: 96 }, (_, i) => {
    const hour = Math.floor(i / 4);
    const min = (i % 4) * 15;
    const time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

    const heating = Math.max(0, UA * (indoorTempC - outdoorTempC)) *
      (1 + 0.3 * Math.sin(Math.PI * (hour - 6) / 12));

    const shiftable = scenario === 'dumb'
      ? (hour >= 17 && hour <= 22 ? shiftableW : 0)
      : (hour >= 1 && hour <= 5 ? shiftableW : 0);

    const fixedActive = ((hour >= 7 && hour <= 9) || (hour >= 18 && hour <= 20)) ? fixedActiveW : 0;

    const total = baseW + heating + shiftable + fixedActive;
    return { time, total, heating, shiftable, fixedActive, base: baseW };
  });

  const sumTotal = timeseries.reduce((s, p) => s + p.total, 0);
  const sumHeating = timeseries.reduce((s, p) => s + p.heating, 0);
  const sumShiftable = timeseries.reduce((s, p) => s + p.shiftable, 0);
  const sumFixedActive = timeseries.reduce((s, p) => s + p.fixedActive, 0);
  const sumBase = timeseries.reduce((s, p) => s + p.base, 0);

  // Each point = 15 min = 0.25 hours
  const toKwh = (sumW: number) => Math.round(sumW * 0.25 / 1000 * 10) / 10;

  return {
    timeseries,
    dailyKwh: toKwh(sumTotal),
    dailyKwhByCategory: {
      heating: toKwh(sumHeating),
      base: toKwh(sumBase),
      shiftable: toKwh(sumShiftable),
      fixedActive: toKwh(sumFixedActive),
    },
    peakW: Math.max(...timeseries.map(p => p.total)),
    avgW: Math.round(sumTotal / 96),
  };
}
