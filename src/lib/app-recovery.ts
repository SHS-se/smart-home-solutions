// Recovering a browser tab that has outlived the build it is running.
//
// A portal tab can stay open for days. Two things go wrong when a deploy lands
// underneath it: the lazy chunks it still wants disappear from the CDN, and
// its queries stop matching a migrated database. The first surfaces as a
// vite:preloadError the app can see; the second surfaces only in the Postgres
// log, as an undefined column on a poll that repeats every thirty seconds.
// Both mean the document is old, and both are cured by fetching it again.

const preloadRecoveryKey = `vite-preload-recovery:${__GIT_COMMIT__}`;
const schemaDriftRecoveryKey = `schema-drift-recovery:${__GIT_COMMIT__}`;
const preloadRecoveryQueryParam = "__shs_recovery";
const preloadRecoveryDelaysMs = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
  30_000,
  30_000,
] as const;
const preloadRecoveryResetMs = 30_000;
let preloadRecoveryScheduled = false;
let preloadRecoveryResetTimer = 0;

export function isRecoveryScheduled(): boolean {
  return preloadRecoveryScheduled;
}

export function resetPreloadRecovery(): void {
  sessionStorage.removeItem(preloadRecoveryKey);
  const url = new URL(window.location.href);
  if (url.searchParams.has(preloadRecoveryQueryParam)) {
    url.searchParams.delete(preloadRecoveryQueryParam);
    window.history.replaceState(window.history.state, "", url);
  }
}

export function reloadWithFreshDocument(attempt: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(
    preloadRecoveryQueryParam,
    `${__GIT_COMMIT__.slice(0, 12)}-${attempt}`,
  );
  window.location.replace(url);
}

export function armPreloadRecovery(): void {
  preloadRecoveryResetTimer = window.setTimeout(
    resetPreloadRecovery,
    preloadRecoveryResetMs,
  );

  window.addEventListener("vite:preloadError", () => {
    if (preloadRecoveryScheduled) return;
    const storedAttempts = Number.parseInt(
      sessionStorage.getItem(preloadRecoveryKey) ?? "0",
      10,
    );
    const attempts = Number.isFinite(storedAttempts) ? storedAttempts : 0;
    const retryDelayMs = preloadRecoveryDelaysMs[attempts];

    if (retryDelayMs === undefined) {
      return;
    }

    window.clearTimeout(preloadRecoveryResetTimer);
    preloadRecoveryScheduled = true;
    sessionStorage.setItem(preloadRecoveryKey, String(attempts + 1));
    window.setTimeout(
      () => reloadWithFreshDocument(String(attempts + 1)),
      retryDelayMs,
    );
  });
}

// A tab whose queries no longer fit the schema is not merely showing stale
// data: it is asking for columns that no longer exist, and anything it writes
// is written by code the database has moved past. Reloading is disruptive, and
// still the lesser risk.
export function recoverFromSchemaDrift(): void {
  if (preloadRecoveryScheduled) return;
  // Once per build. If the freshly loaded document asks for the same missing
  // column, then the database is behind the app rather than the other way
  // round, and reloading would only spin.
  if (sessionStorage.getItem(schemaDriftRecoveryKey)) return;

  sessionStorage.setItem(schemaDriftRecoveryKey, "1");
  preloadRecoveryScheduled = true;
  window.clearTimeout(preloadRecoveryResetTimer);
  console.warn(
    "[RECOVERY] the database no longer matches this build; reloading",
  );
  reloadWithFreshDocument("schema");
}
