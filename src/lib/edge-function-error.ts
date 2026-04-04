type ResponseLike = {
  clone?: () => ResponseLike;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
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
  const fallback =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected edge function error";

  const context = typeof error === "object" && error !== null
    ? (error as ErrorWithContext).context
    : undefined;

  return (await readErrorMessageFromContext(context)) ?? fallback;
}
