import { ROOM_LEARNER_SEMANTIC_DIGEST, ROOM_LEARNER_VERSION } from "./room-learner-version.ts";
import { ROOM_RESPONSE_CAPTURE_REVISION } from "./device-model-learning/room-band-fit-capture.ts";

/** Envelope 6 retains native means and checkpointed adaptive response state. */
export const ROOM_FIT_CAPTURE_VERSION = 6;
export function roomLearningWorkerCapabilities() {
  return { protocol: 3, learner_version: ROOM_LEARNER_VERSION, semantic_digest: ROOM_LEARNER_SEMANTIC_DIGEST,
    progress_version: ROOM_FIT_CAPTURE_VERSION, capture_revision: ROOM_RESPONSE_CAPTURE_REVISION, runtime: Deno.version.v8 };
}
