export const ENERGY_READING_KINDS = ['grid_import', 'total_consumption'] as const;
export type EnergyReadingKind = (typeof ENERGY_READING_KINDS)[number];

export type EnergyUsageCsvFormat =
  | 'daily_grid_consumption'
  | 'home_assistant_sigenergy_total_load';

export interface ParsedEnergyUsageReading {
  readingDate: string;
  consumptionKwh: number;
}

export interface ParsedEnergyUsageCsv {
  readings: ParsedEnergyUsageReading[];
  delimiter: ';' | ',';
  readingKind: EnergyReadingKind;
  sourceFormat: EnergyUsageCsvFormat;
  ignoredSourceRows: number;
  dateRange: {
    start: string;
    end: string;
  };
}

export class EnergyUsageCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnergyUsageCsvParseError';
  }
}

const MAX_READINGS_PER_FILE = 5000;
const MAX_SOURCE_ROWS_PER_FILE = 250_000;
const MAX_CUMULATIVE_INTERVAL_MS = 26 * 60 * 60 * 1000;
const SIGENERGY_TOTAL_LOAD_ENTITY = 'sensor.sigen_plant_total_load_consumption';
const STOCKHOLM_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface CsvContentLine {
  line: string;
  lineNumber: number;
}

function parseCsvLine(line: string, delimiter: ';' | ','): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = '';
      continue;
    }
    value += character;
  }

  if (quoted) {
    throw new EnergyUsageCsvParseError('CSV contains an unterminated quoted field.');
  }

  values.push(value.trim());
  return values;
}

function normalizedHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseDate(value: string, lineNumber: number): string {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    throw new EnergyUsageCsvParseError(`Line ${lineNumber}: expected an ISO date in the date column.`);
  }

  const date = match[1];
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new EnergyUsageCsvParseError(`Line ${lineNumber}: date ${date} is not valid.`);
  }
  return date;
}

function parseNumber(value: string, lineNumber: number): number {
  const normalized = value
    .trim()
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  const number = Number(normalized);
  if (!normalized || !Number.isFinite(number) || number < 0) {
    throw new EnergyUsageCsvParseError(`Line ${lineNumber}: consumption must be a non-negative number.`);
  }
  return number;
}

function parseTimestamp(value: string, lineNumber: number): number {
  const normalized = value.trim();
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    throw new EnergyUsageCsvParseError(
      `Line ${lineNumber}: last_changed must be an ISO timestamp with a time zone.`,
    );
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new EnergyUsageCsvParseError(`Line ${lineNumber}: last_changed is not valid.`);
  }
  return timestamp;
}

function stockholmDate(timestamp: number): string {
  const parts = STOCKHOLM_DATE_FORMATTER.formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new EnergyUsageCsvParseError('A Home Assistant timestamp could not be converted to Stockholm time.');
  }
  return `${year}-${month}-${day}`;
}

function findColumn(headers: string[], predicate: (header: string) => boolean): number {
  return headers.findIndex(predicate);
}

function isDailyGridConsumptionHeader(header: string): boolean {
  return header === 'cons'
    || header.endsWith('.cons')
    || header === 'consumption'
    || header === 'energy consumption'
    || header === 'energy_consumption'
    || header === 'forbrukning'
    || header === 'energiforbrukning'
    || header === 'natuttag'
    || header === 'grid import'
    || header === 'grid_import'
    || header === 'imported energy'
    || header === 'imported_energy';
}

function completeParsedResult(
  readings: ParsedEnergyUsageReading[],
  fields: Omit<ParsedEnergyUsageCsv, 'readings' | 'dateRange'>,
): ParsedEnergyUsageCsv {
  if (readings.length === 0) {
    throw new EnergyUsageCsvParseError('No complete daily readings were found.');
  }
  if (readings.length > MAX_READINGS_PER_FILE) {
    throw new EnergyUsageCsvParseError(
      `A single file may contain at most ${MAX_READINGS_PER_FILE} daily readings.`,
    );
  }

  readings.sort((readingA, readingB) => readingA.readingDate.localeCompare(readingB.readingDate));
  return {
    ...fields,
    readings,
    dateRange: {
      start: readings[0].readingDate,
      end: readings[readings.length - 1].readingDate,
    },
  };
}

function parseDailyGridConsumption(
  contentLines: CsvContentLine[],
  headers: string[],
  delimiter: ';' | ',',
  fileName: string,
): ParsedEnergyUsageCsv {
  const dateColumn = findColumn(headers, (header) => header === 'date' || header === 'datum');
  const consumptionColumn = findColumn(
    headers,
    isDailyGridConsumptionHeader,
  );
  if (dateColumn < 0 || consumptionColumn < 0 || dateColumn === consumptionColumn) {
    throw new EnergyUsageCsvParseError(
      `${fileName}: expected a date column and a consumption column (for example date;meter.cons).`,
    );
  }

  const readings: ParsedEnergyUsageReading[] = [];
  const dates = new Set<string>();
  for (const { line, lineNumber } of contentLines.slice(1)) {
    const columns = parseCsvLine(line, delimiter);
    if (columns.every((column) => column === '')) continue;

    const readingDate = parseDate(columns[dateColumn] ?? '', lineNumber);
    if (dates.has(readingDate)) {
      throw new EnergyUsageCsvParseError(`Line ${lineNumber}: date ${readingDate} occurs more than once.`);
    }
    dates.add(readingDate);
    readings.push({
      readingDate,
      consumptionKwh: parseNumber(columns[consumptionColumn] ?? '', lineNumber),
    });
  }

  return completeParsedResult(readings, {
    delimiter,
    readingKind: 'grid_import',
    sourceFormat: 'daily_grid_consumption',
    ignoredSourceRows: 0,
  });
}

function parseSigenergyTotalLoad(
  contentLines: CsvContentLine[],
  delimiter: ';' | ',',
  fileName: string,
): ParsedEnergyUsageCsv {
  const samples: Array<{ timestamp: number; meterMwh: number; lineNumber: number }> = [];
  let ignoredSourceRows = 0;

  for (const { line, lineNumber } of contentLines.slice(1)) {
    const columns = parseCsvLine(line, delimiter);
    if (columns.every((column) => column === '')) continue;
    if ((columns[0] ?? '').trim() !== SIGENERGY_TOTAL_LOAD_ENTITY) {
      throw new EnergyUsageCsvParseError(
        `${fileName}: line ${lineNumber} contains an unsupported Home Assistant entity.`,
      );
    }

    const timestamp = parseTimestamp(columns[2] ?? '', lineNumber);
    const rawState = (columns[1] ?? '').trim().toLocaleLowerCase();
    if (rawState === 'unknown' || rawState === 'unavailable') {
      ignoredSourceRows += 1;
      continue;
    }
    samples.push({
      timestamp,
      meterMwh: parseNumber(columns[1] ?? '', lineNumber),
      lineNumber,
    });
  }

  if (samples.length < 3) {
    throw new EnergyUsageCsvParseError(
      `${fileName}: the cumulative meter export does not contain enough numeric samples.`,
    );
  }

  const energyByDate = new Map<string, number>();
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const intervalMs = current.timestamp - previous.timestamp;
    if (intervalMs <= 0) {
      throw new EnergyUsageCsvParseError(
        `Line ${current.lineNumber}: Home Assistant timestamps must be strictly increasing.`,
      );
    }
    if (intervalMs > MAX_CUMULATIVE_INTERVAL_MS) {
      throw new EnergyUsageCsvParseError(
        `Line ${current.lineNumber}: the cumulative meter has a gap longer than 26 hours.`,
      );
    }

    const deltaMwh = current.meterMwh - previous.meterMwh;
    if (deltaMwh < -1e-9) {
      throw new EnergyUsageCsvParseError(
        `Line ${current.lineNumber}: the cumulative total-load meter decreased.`,
      );
    }
    const date = stockholmDate(previous.timestamp + (intervalMs / 2));
    energyByDate.set(date, (energyByDate.get(date) ?? 0) + (Math.max(0, deltaMwh) * 1000));
  }

  const dates = Array.from(energyByDate.keys()).sort();
  if (dates.length < 3) {
    throw new EnergyUsageCsvParseError(
      `${fileName}: the cumulative export must span at least three Stockholm calendar days.`,
    );
  }

  const readings = dates.slice(1, -1).map((readingDate) => ({
    readingDate,
    consumptionKwh: Number((energyByDate.get(readingDate) ?? 0).toFixed(6)),
  }));
  return completeParsedResult(readings, {
    delimiter,
    readingKind: 'total_consumption',
    sourceFormat: 'home_assistant_sigenergy_total_load',
    ignoredSourceRows,
  });
}

export function parseEnergyUsageCsv(
  csvText: string,
  fileName = 'energy-usage.csv',
): ParsedEnergyUsageCsv {
  const lines = csvText.replace(/\r\n?/g, '\n').split('\n');
  const contentLines = lines
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith('#'));

  if (contentLines.length < 2) {
    throw new EnergyUsageCsvParseError(`${fileName}: CSV must contain a header and at least one reading.`);
  }
  if (contentLines.length - 1 > MAX_SOURCE_ROWS_PER_FILE) {
    throw new EnergyUsageCsvParseError(
      `${fileName}: a single file may contain at most ${MAX_SOURCE_ROWS_PER_FILE} source rows.`,
    );
  }

  const headerLine = contentLines[0];
  const delimiter: ';' | ',' = headerLine.line.includes(';') ? ';' : ',';
  const headers = parseCsvLine(headerLine.line, delimiter).map(normalizedHeader);
  const isSigenergyTotalLoad = headers.length === 3
    && headers[0] === 'entity_id'
    && headers[1] === 'state'
    && headers[2] === 'last_changed';

  if (isSigenergyTotalLoad) {
    return parseSigenergyTotalLoad(contentLines, delimiter, fileName);
  }

  const hasDailyGridColumns = headers.some((header) => header === 'date' || header === 'datum')
    && headers.some(isDailyGridConsumptionHeader);
  if (hasDailyGridColumns) {
    return parseDailyGridConsumption(contentLines, headers, delimiter, fileName);
  }

  throw new EnergyUsageCsvParseError(
    `${fileName}: unrecognized energy CSV. Expected daily grid data or the Sigenergy total-load Home Assistant export.`,
  );
}
