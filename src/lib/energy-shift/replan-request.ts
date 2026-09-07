// Where a requested replan has got to.
//
// "Planera om nu" used to re-solve the snapshot already stored beside the plan.
// That snapshot is only replaced when Home Assistant pushes one, so for most of
// every quarter it was older than the planner's fifteen-minute freshness limit
// and the button answered `captured_at must describe a fresh snapshot`. The
// request was not wrong; it was unanswerable from stored state.
//
// So the button now records a request and the house answers it on the ordinary
// ingest path, which means the portal has to show a wait rather than a result.
// The three fields the device writes say everything about that wait, so this is
// derived from the row rather than remembered in the browser: a reload, a
// second tab and a returning visitor all see the same request.

/** The replan columns of `energy_optimisation_current`. */
export interface ReplanRow {
  replan_request_id: string | null;
  replan_requested_at: string | null;
  replan_completed_request_id: string | null;
  replan_error: string | null;
}

export type ReplanState =
  | { status: 'idle' }
  | {
    status: 'waiting';
    requestId: string;
    waitedMs: number;
    /** The house has had longer than its own cadence needs. Say so. */
    overdue: boolean;
  }
  | { status: 'failed'; requestId: string; detail: string };

/**
 * How long a house may take before the wait is worth remarking on.
 *
 * The integration answers a request on its own status poll, and a house that
 * knows nothing about requests still pushes fresh measurements every quarter,
 * which settles it anyway. Past both of those the delay is no longer the
 * protocol's, so the panel stops implying the answer is moments away.
 */
export const REPLAN_OVERDUE_MS = 20 * 60_000;

export function replanState(
  row: ReplanRow | null | undefined,
  now: number = Date.now(),
): ReplanState {
  const requestId = row?.replan_request_id;
  if (!requestId) return { status: 'idle' };
  // A completed request stays on the row as the record of the last one; only a
  // request the house has not yet answered is still in progress.
  if (requestId === row?.replan_completed_request_id) return { status: 'idle' };
  if (row?.replan_error) {
    return { status: 'failed', requestId, detail: row.replan_error };
  }
  const requestedAt = row?.replan_requested_at
    ? Date.parse(row.replan_requested_at)
    : Number.NaN;
  // An unparseable stamp must not read as an instant reply: a request with no
  // usable age is shown as freshly made rather than as overdue.
  const waitedMs = Number.isFinite(requestedAt)
    ? Math.max(0, now - requestedAt)
    : 0;
  return {
    status: 'waiting',
    requestId,
    waitedMs,
    overdue: waitedMs >= REPLAN_OVERDUE_MS,
  };
}

/**
 * Whether the request this browser made has now been answered with a plan.
 *
 * The row alone cannot say that: it reports the state of the house, not of the
 * person watching. Only a caller holding the id it was given can tell its own
 * completed request from one that was already finished when the page loaded.
 */
export function replanCompleted(
  row: ReplanRow | null | undefined,
  awaitedRequestId: string | null,
): boolean {
  return (
    awaitedRequestId !== null &&
    row?.replan_completed_request_id === awaitedRequestId
  );
}
