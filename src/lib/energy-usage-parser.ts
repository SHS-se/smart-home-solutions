export interface ParsedEnergyUsageReading {
  readingDate: string;
  consumptionKwh: number;
}

export interface ParsedEnergyUsageCsv {
  readings: ParsedEnergyUsageReading[];
  delimiter: ';' | ',';
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
const CONSUMPTION_HEADER_PATTERN =
  /(^|[^a-z])(cons|consumption|energy|energi|forbrukning|forbruk|kwh)([^a-z]|$)/;

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

function findColumn(headers: string[], predicate: (header: string) => boolean): number {
  return headers.findIndex(predicate);
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

  const headerLine = contentLines[0];
  const delimiter: ';' | ',' = headerLine.line.includes(';') ? ';' : ',';
  const headers = parseCsvLine(headerLine.line, delimiter).map(normalizedHeader);
  const dateColumn = findColumn(headers, (header) => header === 'date' || header === 'datum');
  const consumptionColumn = findColumn(
    headers,
    (header) => CONSUMPTION_HEADER_PATTERN.test(header),
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
    const consumptionKwh = parseNumber(columns[consumptionColumn] ?? '', lineNumber);
    dates.add(readingDate);
    readings.push({ readingDate, consumptionKwh });

    if (readings.length > MAX_READINGS_PER_FILE) {
      throw new EnergyUsageCsvParseError(
        `${fileName}: a single file may contain at most ${MAX_READINGS_PER_FILE} daily readings.`,
      );
    }
  }

  if (readings.length === 0) {
    throw new EnergyUsageCsvParseError(`${fileName}: no readings were found.`);
  }

  readings.sort((a, b) => a.readingDate.localeCompare(b.readingDate));
  return {
    readings,
    delimiter,
    dateRange: {
      start: readings[0].readingDate,
      end: readings[readings.length - 1].readingDate,
    },
  };
}
