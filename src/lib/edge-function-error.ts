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

function isResponseLike(value: unknown): value is ResponseLike {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    typeof (value as ResponseLike).json === "function" ||
    typeof (value as ResponseLike).text === "function" ||
    typeof (value as ResponseLike).status === "number"
  );
}

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

function humanizeEdgeFunctionMessage(message: string): string {
  const normalized = message.trim();

  if (/^(authentication error:\s*)?invalid jwt$/i.test(normalized)) {
    return 'The signed-in session for this environment is invalid. Sign out, sign back in, and try again.';
  }

  if (/jwt expired/i.test(normalized)) {
    return 'Your session has expired. Sign in again and retry the action.';
  }

  if (/no authorization header provided|missing authorization header/i.test(normalized)) {
    return 'No signed-in session was sent with the request. Reload the page and sign in again.';
  }

  if (/access denied: staff only|staff access required/i.test(normalized)) {
    return 'This account is signed in but does not have staff access in the current environment.';
  }

  return normalized;
}

export async function getEdgeFunctionErrorMessage(error: unknown, response?: ResponseLike): Promise<string> {
  const errorContext =
    typeof error === "object" && error !== null
      ? (error as ErrorWithContext).context
      : undefined;
  const parsedResponse = isResponseLike(response)
    ? response
    : isResponseLike(error)
      ? error
      : undefined;

  const fallback =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected edge function error";
  const parsedMessage = await readErrorMessageFromContext(parsedResponse ?? errorContext);
  if (parsedMessage) {
    return humanizeEdgeFunctionMessage(parsedMessage);
  }

  if (error instanceof FunctionsRelayError) {
    return "Supabase relay could not reach the Edge Function";
  }

  if (error instanceof FunctionsFetchError) {
    return error.message;
  }

  const status = parsedResponse?.status ?? errorContext?.status;
  if (typeof status === "number" && error instanceof FunctionsHttpError) {
    return `Edge Function failed with HTTP ${status}`;
  }

  if (typeof status === "number") {
    return `Edge Function failed with HTTP ${status}`;
  }

  return humanizeEdgeFunctionMessage(fallback);
}
