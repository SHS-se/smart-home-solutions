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

export interface QuadraticRegression {
  temperatureCenterC: number;
  quadraticCoefficient: number;
  linearCoefficient: number;
  interceptKwh: number;
  startTemperatureC: number;
  endTemperatureC: number;
  rSquared: number;
}

export interface YearTemperatureSeries {
  year: number;
  points: TemperatureBinPoint[];
  regression: QuadraticRegression | null;
}

export interface EnergyTemperatureAnalysis {
  joinedPoints: JoinedEnergyTemperaturePoint[];
  years: YearTemperatureSeries[];
  overall: {
    points: TemperatureBinPoint[];
    regression: QuadraticRegression | null;
  };
}

function temperatureBin(temperatureC: number): number {
  const rounded = temperatureC < 0
    ? -Math.round(Math.abs(temperatureC))
    : Math.round(temperatureC);
  return Object.is(rounded, -0) ? 0 : rounded;
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

function solveThreeByThree(
  matrix: number[][],
  values: number[],
): [number, number, number] | null {
  const rows = matrix.map((row, index) => [...row, values[index]]);

  for (let pivotIndex = 0; pivotIndex < 3; pivotIndex += 1) {
    let largestRow = pivotIndex;
    for (let rowIndex = pivotIndex + 1; rowIndex < 3; rowIndex += 1) {
      if (Math.abs(rows[rowIndex][pivotIndex]) > Math.abs(rows[largestRow][pivotIndex])) {
        largestRow = rowIndex;
      }
    }
    if (Math.abs(rows[largestRow][pivotIndex]) < 1e-12) return null;
    [rows[pivotIndex], rows[largestRow]] = [rows[largestRow], rows[pivotIndex]];

    const pivot = rows[pivotIndex][pivotIndex];
    for (let columnIndex = pivotIndex; columnIndex < 4; columnIndex += 1) {
      rows[pivotIndex][columnIndex] /= pivot;
    }

    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
      if (rowIndex === pivotIndex) continue;
      const factor = rows[rowIndex][pivotIndex];
      for (let columnIndex = pivotIndex; columnIndex < 4; columnIndex += 1) {
        rows[rowIndex][columnIndex] -= factor * rows[pivotIndex][columnIndex];
      }
    }
  }

  return [rows[0][3], rows[1][3], rows[2][3]];
}

export function predictTemperatureRegression(
  temperatureC: number,
  regression: QuadraticRegression,
): number {
  const centeredTemperature = temperatureC - regression.temperatureCenterC;
  return (regression.quadraticCoefficient * (centeredTemperature ** 2))
    + (regression.linearCoefficient * centeredTemperature)
    + regression.interceptKwh;
}

function quadraticRegression(points: TemperatureBinPoint[]): QuadraticRegression | null {
  if (points.length < 3) return null;

  const temperatureCenterC = points.reduce(
    (sum, point) => sum + point.temperatureC,
    0,
  ) / points.length;
  const centeredPoints = points.map((point) => ({
    x: point.temperatureC - temperatureCenterC,
    y: point.averageKwh,
  }));
  const sums = centeredPoints.reduce<{
    x: number;
    x2: number;
    x3: number;
    x4: number;
    y: number;
    xy: number;
    x2y: number;
  }>((result, point) => {
    const xSquared = point.x ** 2;
    return {
      x: result.x + point.x,
      x2: result.x2 + xSquared,
      x3: result.x3 + (xSquared * point.x),
      x4: result.x4 + (xSquared ** 2),
      y: result.y + point.y,
      xy: result.xy + (point.x * point.y),
      x2y: result.x2y + (xSquared * point.y),
    };
  }, {
    x: 0,
    x2: 0,
    x3: 0,
    x4: 0,
    y: 0,
    xy: 0,
    x2y: 0,
  });
  const coefficients = solveThreeByThree(
    [
      [sums.x4, sums.x3, sums.x2],
      [sums.x3, sums.x2, sums.x],
      [sums.x2, sums.x, points.length],
    ],
    [sums.x2y, sums.xy, sums.y],
  );
  if (!coefficients) return null;

  const [quadraticCoefficient, linearCoefficient, interceptKwh] = coefficients;
  const regression: QuadraticRegression = {
    temperatureCenterC,
    quadraticCoefficient,
    linearCoefficient,
    interceptKwh,
    startTemperatureC: points[0].temperatureC,
    endTemperatureC: points[points.length - 1].temperatureC,
    rSquared: 0,
  };
  const meanY = sums.y / points.length;
  const sumSquaredResiduals = points.reduce(
    (sum, point) => sum + (
      (point.averageKwh - predictTemperatureRegression(point.temperatureC, regression)) ** 2
    ),
    0,
  );
  const sumSquaredTotal = points.reduce(
    (sum, point) => sum + ((point.averageKwh - meanY) ** 2),
    0,
  );
  regression.rSquared = sumSquaredTotal < 1e-12
    ? 1
    : Math.max(0, Math.min(1, 1 - (sumSquaredResiduals / sumSquaredTotal)));
  return regression;
}

function seriesForPoints(year: number, points: JoinedEnergyTemperaturePoint[]): YearTemperatureSeries {
  const grouped = groupedTemperaturePoints(points);
  return {
    year,
    points: grouped,
    regression: quadraticRegression(grouped),
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
      regression: quadraticRegression(overallPoints),
    },
  };
}
