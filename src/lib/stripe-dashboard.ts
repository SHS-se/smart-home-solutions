export function getStripeDashboardUrl(resourcePath: string, isTest: boolean) {
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  return `https://dashboard.stripe.com${isTest ? "/test" : ""}${path}`;
}

/**
 * Opens a URL in a new tab, trying to break out of embedded preview iframes.
 * If popups are blocked (common inside embedded previews), it falls back to copying
 * the URL and showing a prompt so the user can open it manually.
 */
export function openExternalUrl(url: string) {
  const tryOpen = (openFn: () => Window | null) => {
    try {
      const opened = openFn();
      if (opened) {
        try {
          opened.opener = null;
        } catch {
          // ignore
        }
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  };

  // 1) Try opening via the top browsing context (best chance to escape preview iframes)
  const topWin = (() => {
    try {
      return window.top;
    } catch {
      return null;
    }
  })();

  if (topWin && topWin !== window) {
    if (tryOpen(() => topWin.open(url, "_blank", "noopener,noreferrer"))) return;
  }

  // 2) Try opening in the current context
  if (tryOpen(() => window.open(url, "_blank", "noopener,noreferrer"))) return;

  // 3) Try a native anchor click (sometimes allowed even when window.open is blocked)
  const tryAnchor = (doc: Document) => {
    const a = doc.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    doc.body.appendChild(a);
    a.click();
    a.remove();
  };

  try {
    tryAnchor(document);
    return;
  } catch {
    // ignore
  }

  try {
    if (topWin?.document?.body) {
      tryAnchor(topWin.document);
      return;
    }
  } catch {
    // ignore
  }

  // 4) Final fallback: copy + prompt (do NOT navigate inside the preview iframe)
  try {
    void navigator.clipboard?.writeText?.(url);
  } catch {
    // ignore
  }
  try {
    window.prompt("Copy this Stripe link and open it in a normal browser tab:", url);
  } catch {
    // ignore
  }
}
