/** Broadcasts are wakeups only. Read durable state after subscribing and after waking. */
export async function waitForReplan(options: {
  after: string | null;
  read: () => Promise<string | null>;
  subscribe: (changed: () => void) => { ready: Promise<void>; close: () => Promise<unknown> };
  signal: AbortSignal;
  holdMs?: number;
}): Promise<string | null> {
  let wake!: () => void;
  const changed = new Promise<void>(resolve => { wake = resolve; });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, options.holdMs ?? 20_000); });
  let onAbort!: () => void;
  const aborted = new Promise<void>(resolve => { onAbort = resolve; });
  options.signal.addEventListener('abort', onAbort, { once: true });
  let subscription: ReturnType<typeof options.subscribe> | undefined;
  try {
    subscription = options.subscribe(wake);
    await Promise.race([subscription.ready, timeout, aborted]);
    options.signal.throwIfAborted();
    const pending = await options.read();
    if (pending && pending !== options.after) return pending;
    await Promise.race([changed, timeout, aborted]);
    options.signal.throwIfAborted();
    const updated = await options.read();
    return updated !== options.after ? updated : null;
  } finally {
    clearTimeout(timer!);
    options.signal.removeEventListener('abort', onAbort);
    await subscription?.close();
  }
}
