export function getStripeDashboardUrl(resourcePath: string, isTest: boolean) {
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  return `https://dashboard.stripe.com${isTest ? "/test" : ""}${path}`;
}

/**
 * Opens a URL in a new tab, trying to break out of embedded preview iframes.
 * Falls back to navigating the top window if popups are blocked.
 */
export function openExternalUrl(url: string) {
  // Try opening from the top-level browsing context first.
  try {
    const topWin = window.top ?? window;
    const opened = topWin.open(url, "_blank", "noopener,noreferrer");
    if (opened) return;
  } catch {
    // ignore
  }

  // Fallback to current context.
  try {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) return;
  } catch {
    // ignore
  }

  // Final fallback: navigate (tries to escape iframe via top).
  try {
    (window.top ?? window).location.assign(url);
  } catch {
    window.location.assign(url);
  }
}
