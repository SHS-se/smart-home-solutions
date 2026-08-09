export interface EnergyUsageAnalysisReading {
  readingDate: string;
  consumptionKwh: number;
  readingKind: EnergyAnalysisReadingKind;
}

export type EnergyAnalysisReadingKind = 'grid_import' | 'total_consumption';

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
  readingKind: EnergyAnalysisReadingKind;
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

export interface WeatherNormalizedDailyPoint {
  readingDate: string;
  monthKey: string;
  temperatureC: number;
  actualKwh: number;
  normalizedKwh: number;
  readingKind: EnergyAnalysisReadingKind;
}

export interface WeatherNormalizedMonth {
  monthKey: string;
  averageActualKwh: number;
  averageNormalizedKwh: number;
  sampleCount: number;
}

export interface WeatherNormalizedHistory {
  referenceTemperatureC: number;
  referenceUsageKwh: number;
  dailyPoints: WeatherNormalizedDailyPoint[];
  months: WeatherNormalizedMonth[];
}

export interface EnergyHistoryEvent {
  id: string;
  eventDate: string;
  eventText: string;
}

export interface MonthlyEnergyCost {
  monthKey: string;
  daysInMonth: number;
  gridCoverage: 'complete' | 'partial' | 'missing';
  electricityCoverage: 'complete' | 'partial' | 'missing';
  totalCostSek: number | null;
}

export interface SeasonalEventImpact {
  eventId: string;
  eventDate: string;
  eventText: string;
  readingKind: EnergyAnalysisReadingKind;
  referenceStartDate: string;
  referenceEndDate: string;
  comparisonStartDate: string;
  comparisonEndDate: string;
  referenceAverageTemperatureC: number;
  comparisonAverageTemperatureC: number;
  referenceActualAverageKwh: number;
  comparisonActualAverageKwh: number;
  referenceAverageKwh: number;
  comparisonAverageKwh: number;
  changeKwh: number;
  changePercent: number;
  referenceTotalKwh: number;
  comparisonTotalKwh: number;
  referenceCostSek: number | null;
  comparisonCostSek: number | null;
  costChangeSek: number | null;
  costChangePercent: number | null;
  matchedDayCount: number;
  costedDayCount: number;
  windowMonths: number;
  completeWindow: boolean;
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
        readingKind: reading.readingKind,
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

export function buildWeatherNormalizedHistory(
  analysis: EnergyTemperatureAnalysis,
  referenceTemperatureC = 0,
): WeatherNormalizedHistory | null {
  const regression = analysis.overall.regression;
  if (!regression) return null;

  const referenceUsageKwh = predictTemperatureRegression(referenceTemperatureC, regression);
  const dailyPoints = analysis.joinedPoints.map((point) => {
    const expectedAtObservedTemperature = predictTemperatureRegression(
      point.temperatureC,
      regression,
    );
    return {
      readingDate: point.readingDate,
      monthKey: point.readingDate.slice(0, 7),
      temperatureC: point.temperatureC,
      actualKwh: point.consumptionKwh,
      normalizedKwh: point.consumptionKwh
        - expectedAtObservedTemperature
        + referenceUsageKwh,
      readingKind: point.readingKind,
    };
  });

  const monthGroups = new Map<string, {
    actualTotal: number;
    normalizedTotal: number;
    sampleCount: number;
  }>();
  for (const point of dailyPoints) {
    const group = monthGroups.get(point.monthKey) ?? {
      actualTotal: 0,
      normalizedTotal: 0,
      sampleCount: 0,
    };
    group.actualTotal += point.actualKwh;
    group.normalizedTotal += point.normalizedKwh;
    group.sampleCount += 1;
    monthGroups.set(point.monthKey, group);
  }

  return {
    referenceTemperatureC,
    referenceUsageKwh,
    dailyPoints,
    months: Array.from(monthGroups.entries())
      .sort(([monthA], [monthB]) => monthA.localeCompare(monthB))
      .map(([monthKey, group]) => ({
        monthKey,
        averageActualKwh: group.actualTotal / group.sampleCount,
        averageNormalizedKwh: group.normalizedTotal / group.sampleCount,
        sampleCount: group.sampleCount,
      })),
  };
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function utcDateNumber(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid energy-history date: ${date}`);
  }
  return timestamp;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return isoDate(utcDateNumber(date) + (days * MILLISECONDS_PER_DAY));
}

function addMonths(date: string, months: number): string {
  const parsed = new Date(utcDateNumber(date));
  const targetMonth = parsed.getUTCMonth() + months;
  const targetYear = parsed.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(parsed.getUTCDate(), lastDay),
  )).toISOString().slice(0, 10);
}

function shiftYear(date: string, years: number): string {
  const parsed = new Date(utcDateNumber(date));
  const targetYear = parsed.getUTCFullYear() + years;
  const month = parsed.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    month,
    Math.min(parsed.getUTCDate(), lastDay),
  )).toISOString().slice(0, 10);
}

function shiftYearExact(date: string, years: number): string | null {
  const parsed = new Date(utcDateNumber(date));
  const targetYear = parsed.getUTCFullYear() + years;
  const target = new Date(Date.UTC(
    targetYear,
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  ));
  return target.getUTCMonth() === parsed.getUTCMonth()
    && target.getUTCDate() === parsed.getUTCDate()
    ? target.toISOString().slice(0, 10)
    : null;
}

/**
 * Compare the three months after an event with the same dates one year earlier.
 *
 * Only year-over-year day pairs present in both windows are used, so an event
 * whose three-month follow-up is still in progress is never compared with a
 * longer reference period. Energy is weather-normalized. Cost is kept separate
 * from that model: complete monthly grid and supplier bills are allocated by
 * calendar day, so the result remains a raw billed-cost comparison and never
 * applies a grid-import price to whole-home consumption.
 */
export function buildSeasonalEventImpacts(
  history: WeatherNormalizedHistory,
  events: EnergyHistoryEvent[],
  costMonths: readonly MonthlyEnergyCost[],
  readingKind: EnergyAnalysisReadingKind,
  windowMonths = 3,
  minimumSampleCount = 30,
): SeasonalEventImpact[] {
  if (!Number.isInteger(windowMonths) || windowMonths < 1) {
    throw new Error('Event impact window must be a positive number of whole months.');
  }
  if (!Number.isInteger(minimumSampleCount) || minimumSampleCount < 1) {
    throw new Error('Event impact minimum sample count must be a positive integer.');
  }
  if (history.dailyPoints.some((point) => point.readingKind !== readingKind)) {
    throw new Error('Event impact history must contain one consistent energy-reading source.');
  }

  const pointsByDate = new Map(history.dailyPoints.map((point) => [point.readingDate, point]));
  const billedCostPerDayByMonth = new Map(costMonths.flatMap((month) => (
    month.totalCostSek !== null
      && month.daysInMonth > 0
      && month.gridCoverage === 'complete'
      && month.electricityCoverage === 'complete'
      ? [[month.monthKey, month.totalCostSek / month.daysInMonth] as const]
      : []
  )));
  const latestDate = history.dailyPoints.at(-1)?.readingDate ?? null;

  return events.flatMap((event) => {
    const comparisonStartDate = addDays(event.eventDate, 1);
    const comparisonEndExclusive = addMonths(comparisonStartDate, windowMonths);
    const comparisonEndDate = addDays(comparisonEndExclusive, -1);
    const referenceStartDate = shiftYear(comparisonStartDate, -1);
    const referenceEndDate = shiftYear(comparisonEndDate, -1);
    const referenceTemperatures: number[] = [];
    const comparisonTemperatures: number[] = [];
    const referenceActualEnergy: number[] = [];
    const comparisonActualEnergy: number[] = [];
    const referenceEnergy: number[] = [];
    const comparisonEnergy: number[] = [];
    let referenceCostSek = 0;
    let comparisonCostSek = 0;
    let costedDayCount = 0;

    for (const comparison of history.dailyPoints) {
      if (
        comparison.readingDate < comparisonStartDate
        || comparison.readingDate >= comparisonEndExclusive
      ) continue;
      const referenceDate = shiftYearExact(comparison.readingDate, -1);
      if (!referenceDate) continue;
      const reference = pointsByDate.get(referenceDate);
      if (!reference) continue;
      referenceTemperatures.push(reference.temperatureC);
      comparisonTemperatures.push(comparison.temperatureC);
      referenceActualEnergy.push(reference.actualKwh);
      comparisonActualEnergy.push(comparison.actualKwh);
      referenceEnergy.push(reference.normalizedKwh);
      comparisonEnergy.push(comparison.normalizedKwh);

      const referenceDailyCost = billedCostPerDayByMonth.get(referenceDate.slice(0, 7));
      const comparisonDailyCost = billedCostPerDayByMonth.get(
        comparison.readingDate.slice(0, 7),
      );
      if (referenceDailyCost !== undefined && comparisonDailyCost !== undefined) {
        referenceCostSek += referenceDailyCost;
        comparisonCostSek += comparisonDailyCost;
        costedDayCount += 1;
      }
    }

    if (referenceEnergy.length < minimumSampleCount) return [];

    const referenceAverageKwh = average(referenceEnergy);
    const comparisonAverageKwh = average(comparisonEnergy);
    const changeKwh = comparisonAverageKwh - referenceAverageKwh;
    const hasComparableCosts = costedDayCount >= minimumSampleCount
      && costedDayCount === referenceEnergy.length;
    const costChangeSek = hasComparableCosts
      ? comparisonCostSek - referenceCostSek
      : null;
    return [{
      eventId: event.id,
      eventDate: event.eventDate,
      eventText: event.eventText,
      readingKind,
      referenceStartDate,
      referenceEndDate,
      comparisonStartDate,
      comparisonEndDate,
      referenceAverageTemperatureC: average(referenceTemperatures),
      comparisonAverageTemperatureC: average(comparisonTemperatures),
      referenceActualAverageKwh: average(referenceActualEnergy),
      comparisonActualAverageKwh: average(comparisonActualEnergy),
      referenceAverageKwh,
      comparisonAverageKwh,
      changeKwh,
      changePercent: referenceAverageKwh === 0
        ? 0
        : (changeKwh / referenceAverageKwh) * 100,
      referenceTotalKwh: referenceEnergy.reduce((sum, value) => sum + value, 0),
      comparisonTotalKwh: comparisonEnergy.reduce((sum, value) => sum + value, 0),
      referenceCostSek: hasComparableCosts ? referenceCostSek : null,
      comparisonCostSek: hasComparableCosts ? comparisonCostSek : null,
      costChangeSek,
      costChangePercent: hasComparableCosts && referenceCostSek !== 0
        ? (costChangeSek! / referenceCostSek) * 100
        : null,
      matchedDayCount: referenceEnergy.length,
      costedDayCount,
      windowMonths,
      completeWindow: latestDate !== null && latestDate >= comparisonEndDate,
    }];
  });
}
