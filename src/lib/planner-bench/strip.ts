// Reduce a downloaded plan replay to what the planner needs to run again.
//
// A replay file is ~10 MB: the published plan it produced (`expected`) and the
// measured history around it make up almost all of it. The planner reads only
// `entrypoint.arguments`, about 1% of the file, so that is all a test case keeps.
// Every planner version is re-run from the same arguments, which is what makes
// two versions comparable.

import type { BenchInput } from './types';

export const REPLAY_FORMAT = 'shs-energy-optimisation-quarter-replay';

export interface StrippedReplay {
  input: BenchInput;
  capturedAt: string;
  inputHash: string | null;
  /** Suggested case name; the uploader can change it. */
  suggestedName: string;
}

export class ReplayFormatError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function stripReplay(raw: unknown): StrippedReplay {
  if (!isRecord(raw) || raw.format !== REPLAY_FORMAT) {
    throw new ReplayFormatError(`Not a plan replay file (expected format "${REPLAY_FORMAT}").`);
  }
  const args = isRecord(raw.entrypoint) ? raw.entrypoint.arguments : undefined;
  if (!isRecord(args) || !isRecord(args.snapshot) || typeof args.now !== 'string') {
    throw new ReplayFormatError('The replay has no planner arguments (entrypoint.arguments.snapshot and now).');
  }
  const snapshot = args.snapshot as BenchInput['snapshot'];
  if (typeof snapshot.captured_at !== 'string') {
    throw new ReplayFormatError('The replay snapshot has no captured_at time.');
  }
  const input: BenchInput = {
    snapshot,
    now: args.now,
    price_archive: Array.isArray(args.price_archive) ? args.price_archive : [],
    ...(args.resolved_price_outlook !== undefined ? { resolved_price_outlook: args.resolved_price_outlook } : {}),
  };
  const capturedAt = new Date(snapshot.captured_at).toISOString();
  return {
    input,
    capturedAt,
    inputHash: typeof raw.input_hash === 'string' ? raw.input_hash : null,
    suggestedName: `Plan ${capturedAt.slice(0, 16).replace('T', ' ')} UTC`,
  };
}
