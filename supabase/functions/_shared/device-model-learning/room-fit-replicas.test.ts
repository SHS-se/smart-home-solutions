import { assert, assertEquals, assertRejects } from "@std/assert";
import { syntheticConnectedPlant, syntheticConnectedResponse } from "../connected-exchange.fixture.ts";
import { advanceConnectedProcessInference, beginConnectedProcessInference, connectedProcessResponse } from "../device-learning/room/connected-process.ts";
import { beginConnectedRoomFit } from "../device-learning/room/connected-response.ts";
import { advanceRoomFitReplica, checkpointConnectedFit, finishConnectedFit } from "./room-fit-replicas.ts";

Deno.test("a split mid-copy resumes each replica through native pages and publishes the original ordered uncertainty", async () => {
  const model = syntheticConnectedResponse(false);
  const rows = syntheticConnectedPlant(true).slice(0, 12).map((row, i) => i === 6 || i === 11
    ? { ...row, room_c: null, peer_c: {} } : row);
  const result = { response: model, model: null, learning: {}, issues: [] };
  const fit = beginConnectedRoomFit({ fullRows: rows, trainingRows: rows },
    { peers: ["peer"], observedOnly: true, ratedPowerW: null, basis: model.basis });
  const through = rows.at(-1)!.start_ms + 900_000;
  const initial = beginConnectedProcessInference(model, rows, undefined, 24);
  let interrupted = initial;
  // Take exactly one conceptual particle per call until the kernel has
  // retained a continuation and an earlier replica has advanced to the next row.
  const realNow = performance.now;
  let ticks = 0;
  try {
    performance.now = () => ++ticks;
    while (!(interrupted.work && interrupted.work.replica > 0 && interrupted.work.copy > 0 &&
      interrupted.work.continuation?.retained !== undefined)) {
      interrupted = advanceConnectedProcessInference(rows, interrupted, through, 1);
      assert(!interrupted.complete);
    }
  } finally { performance.now = realNow; }
  const remains = await checkpointConnectedFit({ ...fit, stage: "process_posterior", result, processPosterior: interrupted }, rows);
  assert(remains.kind === "start_process");
  assert(!remains.shared.result.response.process_belief);
  const { shared, replicas } = remains;
  assert(replicas.some(r => r.row > interrupted.cursor));
  assert(replicas.some(r => r.row === interrupted.cursor));
  for (const index of [2, 3, 1, 0]) {
    let previous = replicas[index];
    while (!previous.done) {
      const page = rows.slice(previous.row, previous.row + 3);
      const next = await advanceRoomFitReplica({ kind: "replica", model: shared.result.response, priors: shared.priors, replica: previous,
        window: { base64: "", sha256: "", from_at: model.basis.history_from, row_from: previous.row, total_rows: rows.length } }, page, 2);
      previous = JSON.parse(JSON.stringify(next.replica));
    }
    replicas[index] = previous;
  }
  const finished = await finishConnectedFit({ kind: "finish", shared, replicas }, rows.length);
  let reference = initial;
  while (!reference.complete) reference = advanceConnectedProcessInference(rows, reference, through, 60);
  assertEquals(finished.response, connectedProcessResponse(reference));
  await assertRejects(() => finishConnectedFit({ kind: "finish", shared, replicas: replicas.slice(1) }, rows.length), Error, "Incomplete");
});
