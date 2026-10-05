export type PurchaseDraftErrorStage =
  | 'supplier_create'
  | 'supplier_update'
  | 'duplicate_check'
  | 'exchange_rate_lookup'
  | 'document_upload'
  | 'purchase_insert'
  | 'line_insert'
  | 'unexpected';

type ErrorWithMetadata = {
  message?: unknown;
  error?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
};

export interface PurchaseDraftErrorDescription {
  message: string;
  stage: PurchaseDraftErrorStage;
  details: string[];
  code: string | null;
  status: number | null;
}

export class PurchaseDraftError extends Error {
  stage: PurchaseDraftErrorStage;
  details: string[];
  code: string | null;
  status: number | null;

  constructor(params: {
    message: string;
    stage: PurchaseDraftErrorStage;
    details?: string[];
    code?: string | null;
    status?: number | null;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'PurchaseDraftError';
    this.stage = params.stage;
    this.details = params.details ?? [];
    this.code = params.code ?? null;
    this.status = params.status ?? null;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value) unique.add(value);
  }
  return [...unique];
}

function describeUnknownError(error: unknown, fallbackMessage: string): Omit<PurchaseDraftErrorDescription, 'stage'> {
  const errorLike = (typeof error === 'object' && error !== null ? error : {}) as ErrorWithMetadata;
  const message = readString(errorLike.message)
    || readString(errorLike.error)
    || (error instanceof Error ? readString(error.message) : null)
    || fallbackMessage;
  const code = readString(errorLike.code);
  const status = readNumber(errorLike.status) ?? readNumber(errorLike.statusCode);
  const details = dedupeStrings([
    readString(errorLike.details),
    readString(errorLike.hint) ? `Hint: ${readString(errorLike.hint)}` : null,
  ]);

  return {
    message,
    details,
    code,
    status,
  };
}

export function toPurchaseDraftError(
  error: unknown,
  params: {
    stage: PurchaseDraftErrorStage;
    fallbackMessage: string;
    extraDetails?: string[];
  },
): PurchaseDraftError {
  if (error instanceof PurchaseDraftError) {
    return new PurchaseDraftError({
      message: error.message,
      stage: params.stage,
      details: dedupeStrings([...error.details, ...(params.extraDetails ?? [])]),
      code: error.code,
      status: error.status,
      cause: error,
    });
  }

  const described = describeUnknownError(error, params.fallbackMessage);
  return new PurchaseDraftError({
    message: described.message,
    stage: params.stage,
    details: dedupeStrings([...described.details, ...(params.extraDetails ?? [])]),
    code: described.code,
    status: described.status,
    cause: error,
  });
}

export function describePurchaseDraftError(
  error: unknown,
  fallbackMessage: string,
): PurchaseDraftErrorDescription {
  if (error instanceof PurchaseDraftError) {
    return {
      message: error.message,
      stage: error.stage,
      details: error.details,
      code: error.code,
      status: error.status,
    };
  }

  const described = describeUnknownError(error, fallbackMessage);
  return {
    ...described,
    stage: 'unexpected',
  };
}
