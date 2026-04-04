export async function getResponseErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const status = response.status
    ? `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
    : "";
  const suffix = status ? ` (${status})` : "";

  try {
    const payload = await response.clone().json();
    if (payload && typeof payload === "object") {
      const errorMessage =
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.message === "string"
            ? payload.message
            : "";

      if (errorMessage) {
        return `${fallbackMessage}: ${errorMessage}${suffix}`;
      }
    }
  } catch {
    // Ignore JSON parse failures and fall back to plain text.
  }

  try {
    const text = (await response.text()).trim();
    if (text) {
      return `${fallbackMessage}: ${text}${suffix}`;
    }
  } catch {
    // Ignore response body read failures and use the fallback below.
  }

  return `${fallbackMessage}${suffix}`;
}
