import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js';

type ResponseLike = {
  clone?: () => ResponseLike;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  status?: number;
  headers?: {
    get?: (name: string) => string | null;
  };
};

type ErrorWithContext = {
  message?: string;
  context?: ResponseLike;
};

async function readErrorMessageFromContext(context: ResponseLike | undefined): Promise<string | null> {
  if (!context) return null;

  const response = typeof context.clone === "function" ? context.clone() : context;

  try {
    if (typeof response.json === "function") {
      const payload = await response.json();
      if (payload && typeof payload === "object") {
        const message = "error" in payload
          ? payload.error
          : "message" in payload
            ? payload.message
            : null;
        if (typeof message === "string" && message.trim().length > 0) {
          return message;
        }
      }
    }
  } catch {
    // Fall through to plain-text parsing.
  }

  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      if (text.trim().length > 0) {
        return text;
      }
    }
  } catch {
    // Ignore response parsing failures and use the fallback message.
  }

  return null;
}

export async function getEdgeFunctionErrorMessage(error: unknown): Promise<string> {
  const response =
    typeof error === "object" && error !== null
      ? (error as ErrorWithContext).context
      : undefined;

  const fallback =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected edge function error";
  const parsedMessage = await readErrorMessageFromContext(response);
  if (parsedMessage) {
    return parsedMessage;
  }

  if (error instanceof FunctionsRelayError) {
    return "Supabase relay could not reach the Edge Function";
  }

  if (error instanceof FunctionsFetchError) {
    return error.message;
  }

  const status = response?.status;
  if (error instanceof FunctionsHttpError && typeof status === "number") {
    return `Edge Function failed with HTTP ${status}`;
  }

  return fallback;
}
