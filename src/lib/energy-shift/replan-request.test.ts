import { assertEquals } from 'jsr:@std/assert@1';
import {
  REPLAN_OVERDUE_MS,
  replanCompleted,
  replanState,
  type ReplanRow,
} from './replan-request.ts';

const REQUESTED_AT = '2026-09-07T10:00:00.000Z';
const NOW = Date.parse('2026-09-07T10:02:00.000Z');
const ID = '2f1c0c74-9d31-4f0e-9a45-9c6f2f5f0a11';
const NEWER = 'a4f0b0f3-0c2b-4b5f-8a2e-6f2f9d4b1c33';

const row = (over: Partial<ReplanRow> = {}): ReplanRow => ({
  replan_request_id: null,
  replan_requested_at: null,
  replan_completed_request_id: null,
  replan_error: null,
  ...over,
});

Deno.test('a home nobody has asked to replan is idle', () => {
  assertEquals(replanState(row(), NOW).status, 'idle');
  assertEquals(replanState(null, NOW).status, 'idle');
});

Deno.test('a request the house has not answered is still being waited on', () => {
  const state = replanState(
    row({ replan_request_id: ID, replan_requested_at: REQUESTED_AT }),
    NOW,
  );
  assertEquals(state, {
    status: 'waiting',
    requestId: ID,
    waitedMs: 120_000,
    overdue: false,
  });
});

Deno.test('a wait past the house\'s own cadence is called out', () => {
  const state = replanState(
    row({ replan_request_id: ID, replan_requested_at: REQUESTED_AT }),
    Date.parse(REQUESTED_AT) + REPLAN_OVERDUE_MS,
  );
  assertEquals(state.status === 'waiting' && state.overdue, true);
});

Deno.test('a request settled by a plan leaves the row idle, not waiting', () => {
  // The completed id stays on the row as the record of the last request. Read
  // naively that is indistinguishable from an outstanding one, which would have
  // left the panel waiting for ever on a replan that had already arrived.
  const state = replanState(
    row({
      replan_request_id: ID,
      replan_requested_at: REQUESTED_AT,
      replan_completed_request_id: ID,
    }),
    NOW,
  );
  assertEquals(state.status, 'idle');
});

Deno.test('a house that could not answer says why instead of spinning', () => {
  const state = replanState(
    row({
      replan_request_id: ID,
      replan_requested_at: REQUESTED_AT,
      replan_error: 'kitchen: no trained thermal model is available',
    }),
    NOW,
  );
  assertEquals(state, {
    status: 'failed',
    requestId: ID,
    detail: 'kitchen: no trained thermal model is available',
  });
});

Deno.test('a failure that a later plan overtook no longer counts as one', () => {
  // The device reports a failure and the next quarter's push succeeds anyway.
  // The plan is the newer fact, and the server clears the error when it lands;
  // this only has to agree that a completed request is not a failed one.
  const state = replanState(
    row({
      replan_request_id: ID,
      replan_requested_at: REQUESTED_AT,
      replan_completed_request_id: ID,
      replan_error: 'transient sensor read failure',
    }),
    NOW,
  );
  assertEquals(state.status, 'idle');
});

Deno.test('an unreadable request time reads as new rather than overdue', () => {
  const state = replanState(
    row({ replan_request_id: ID, replan_requested_at: 'not a timestamp' }),
    NOW,
  );
  assertEquals(state, {
    status: 'waiting',
    requestId: ID,
    waitedMs: 0,
    overdue: false,
  });
});

Deno.test('only the browser that asked is told its own request landed', () => {
  const settled = row({
    replan_request_id: ID,
    replan_requested_at: REQUESTED_AT,
    replan_completed_request_id: ID,
  });
  assertEquals(replanCompleted(settled, ID), true);
  // A visitor arriving after the fact, and one waiting on a newer request,
  // must not be told a plan they never asked for has just been rebuilt.
  assertEquals(replanCompleted(settled, null), false);
  assertEquals(replanCompleted(settled, NEWER), false);
});
