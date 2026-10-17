/** A successful quiet wait certifies a joined, continuously observed channel. */
export class NotificationUnavailable extends Error {}

export async function waitForReplan(options: {
  after: string | null;
  read: () => Promise<string | null>;
  subscribe: (changed: () => void) => { ready: Promise<void>; lost: Promise<void>; close: () => Promise<unknown> };
  signal: AbortSignal;
  holdMs?: number;
  readyMs?: number;
}): Promise<string | null> {
  let wake!: () => void;
  const changed = new Promise<void>(resolve => { wake = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
  });
  options.signal.addEventListener('abort', abort, {once: true});
  const subscription = options.subscribe(wake);
  // Install all rejection handlers before checking an already-aborted request.
  const unavailable = subscription.lost.then(() => { throw new NotificationUnavailable('Notification channel closed'); });
  const readyTimeout = new Promise<never>((_, reject) => {
    readinessTimer = setTimeout(() => reject(new NotificationUnavailable('Notification channel did not become ready')), options.readyMs ?? 5_000);
  });
  const ready = Promise.race([subscription.ready, unavailable, readyTimeout, aborted]);
  try {
    if (options.signal.aborted) abort();
    await ready;
    clearTimeout(readinessTimer);
    const read = () => Promise.race([options.read(), unavailable, aborted]);
    const pending = await read();
    if (pending && pending !== options.after) return pending;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, options.holdMs ?? 90_000); });
    await Promise.race([changed, timeout, unavailable, aborted]);
    const updated = await read();
    return updated !== options.after ? updated : null;
  } finally {
    clearTimeout(timer);
    clearTimeout(readinessTimer);
    options.signal.removeEventListener('abort', abort);
    await subscription.close();
  }
}
