export interface EnergyUsageAnalysisReading {
  readingDate: string;
  consumptionKwh: number;
}

export interface WeatherAnalysisObservation {
  observedOn: string;
  temperatureC: number;
}

export interface JoinedEnergyTemperaturePoint {
  readingDate: string;
  year: number;
  temperatureC: number;
  temperatureBinC: number;
  consumptionKwh: number;
}

export interface TemperatureBinPoint {
  temperatureC: number;
  averageKwh: number;
  sampleCount: number;
}

export interface RegressionLine {
  startTemperatureC: number;
  endTemperatureC: number;
  startKwh: number;
  endKwh: number;
  rSquared: number | null;
}

export interface YearTemperatureSeries {
  year: number;
  points: TemperatureBinPoint[];
  regression: RegressionLine | null;
}

export interface EnergyTemperatureAnalysis {
  joinedPoints: JoinedEnergyTemperaturePoint[];
  years: YearTemperatureSeries[];
  overall: {
    points: TemperatureBinPoint[];
    regression: RegressionLine | null;
  };
}

function temperatureBin(temperatureC: number): number {
  return Math.round(temperatureC);
}

function groupedTemperaturePoints(points: JoinedEnergyTemperaturePoint[]): TemperatureBinPoint[] {
  const bins = new Map<number, { totalKwh: number; sampleCount: number }>();
  for (const point of points) {
    const existing = bins.get(point.temperatureBinC) ?? { totalKwh: 0, sampleCount: 0 };
    existing.totalKwh += point.consumptionKwh;
    existing.sampleCount += 1;
    bins.set(point.temperatureBinC, existing);
  }

  return Array.from(bins.entries())
    .sort(([temperatureA], [temperatureB]) => temperatureA - temperatureB)
    .map(([temperatureC, value]) => ({
      temperatureC,
      averageKwh: value.totalKwh / value.sampleCount,
      sampleCount: value.sampleCount,
    }));
}

function linearRegression(points: TemperatureBinPoint[]): RegressionLine | null {
  if (points.length < 2) return null;

  const meanX = points.reduce((sum, point) => sum + point.temperatureC, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.averageKwh, 0) / points.length;
  const denominator = points.reduce(
    (sum, point) => sum + ((point.temperatureC - meanX) ** 2),
    0,
  );
  if (denominator === 0) return null;

  const slope = points.reduce(
    (sum, point) => sum + ((point.temperatureC - meanX) * (point.averageKwh - meanY)),
    0,
  ) / denominator;
  const intercept = meanY - (slope * meanX);
  const predict = (temperatureC: number) => (slope * temperatureC) + intercept;
  const sumSquaredResiduals = points.reduce(
    (sum, point) => sum + ((point.averageKwh - predict(point.temperatureC)) ** 2),
    0,
  );
  const sumSquaredTotal = points.reduce(
    (sum, point) => sum + ((point.averageKwh - meanY) ** 2),
    0,
  );

  return {
    startTemperatureC: points[0].temperatureC,
    endTemperatureC: points[points.length - 1].temperatureC,
    startKwh: predict(points[0].temperatureC),
    endKwh: predict(points[points.length - 1].temperatureC),
    rSquared: sumSquaredTotal === 0
      ? 1
      : Math.max(0, Math.min(1, 1 - (sumSquaredResiduals / sumSquaredTotal))),
  };
}

function seriesForPoints(year: number, points: JoinedEnergyTemperaturePoint[]): YearTemperatureSeries {
  const grouped = groupedTemperaturePoints(points);
  return {
    year,
    points: grouped,
    regression: linearRegression(grouped),
  };
}

export function buildEnergyTemperatureAnalysis(
  readings: EnergyUsageAnalysisReading[],
  observations: WeatherAnalysisObservation[],
): EnergyTemperatureAnalysis {
  const temperaturesByDate = new Map(
    observations.map((observation) => [observation.observedOn, observation.temperatureC]),
  );
  const joinedPoints = readings
    .map((reading) => {
      const temperatureC = temperaturesByDate.get(reading.readingDate);
      if (temperatureC === undefined || !Number.isFinite(temperatureC)) return null;
      return {
        readingDate: reading.readingDate,
        year: Number(reading.readingDate.slice(0, 4)),
        temperatureC,
        temperatureBinC: temperatureBin(temperatureC),
        consumptionKwh: reading.consumptionKwh,
      } satisfies JoinedEnergyTemperaturePoint;
    })
    .filter((point): point is JoinedEnergyTemperaturePoint => point !== null)
    .sort((a, b) => a.readingDate.localeCompare(b.readingDate));

  const groupedByYear = new Map<number, JoinedEnergyTemperaturePoint[]>();
  for (const point of joinedPoints) {
    const yearPoints = groupedByYear.get(point.year) ?? [];
    yearPoints.push(point);
    groupedByYear.set(point.year, yearPoints);
  }

  const years = Array.from(groupedByYear.keys())
    .sort((yearA, yearB) => yearA - yearB)
    .map((year) => seriesForPoints(year, groupedByYear.get(year) ?? []));
  const overallPoints = groupedTemperaturePoints(joinedPoints);

  return {
    joinedPoints,
    years,
    overall: {
      points: overallPoints,
      regression: linearRegression(overallPoints),
    },
  };
}
