import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { diskTree, type SourceTree } from "../scripts/module-graph.ts";
import { ROOM_LEARNER_VERSION_FILE, roomLearnerDigest, roomLearnerSources, roomLearnerVersionSource, readRoomLearnerManifest } from "../scripts/room-learner-version.ts";

const tree = diskTree(Deno.cwd());
function replacing(path: string, before: string, after: string): SourceTree {
  const original = tree.read(path);
  assert(original !== null && original.includes(before), `Missing mutation target in ${path}`);
  return { isFile: tree.isFile, read: file => file === path ? original.replace(before, after) : tree.read(file) };
}

Deno.test("the committed room learner manifest matches its pure semantics", async () => {
  const stored = await Deno.readTextFile(ROOM_LEARNER_VERSION_FILE);
  const manifest = readRoomLearnerManifest(stored);
  assertEquals(stored, roomLearnerVersionSource(await roomLearnerDigest(), manifest.version),
    "The mathematical learner changed. Run `deno task generate:room-learner-version`.");
});

Deno.test("the learner follows transitive numerical and source-policy dependencies", async () => {
  const sources = await roomLearnerSources();
  for (const path of [
    "device-learning/room/measured-response.ts", "device-learning/room/connected-response.ts",
    "device-learning/room/connected-process.ts", "device-learning/room/fit-policy.ts",
    "device-model-learning/room-fit-evidence.ts", "planner/models/room/connected-exchange.ts",
    "planner/models/room/observation.ts",
  ]) assert(sources.includes(`supabase/functions/_shared/${path}`), path);
  assert(!sources.some(path => /\.(test|fixture)\.ts$/.test(path)));
  assert(!sources.includes(ROOM_LEARNER_VERSION_FILE));
  assert(!sources.includes("supabase/functions/_shared/device-learning-worker.ts"));
  assert(!sources.includes("supabase/functions/_shared/device-model-learning/room-response-run.ts"));
});

Deno.test("source policy, evidence qualification and transitive fit mathematics change learner identity", async () => {
  const digest = await roomLearnerDigest();
  const mutations = [
    ["device-learning/room/fit-policy.ts", "ROOM_FIT_WINDOW_DAYS = 30", "ROOM_FIT_WINDOW_DAYS = 31"],
    ["device-learning/room/fit-policy.ts", "models.roomHeating?.[key] ?? models.roomObserved?.[key]", "models.roomHeating?.[key]"],
    ["device-model-learning/room-fit-evidence.ts", "training.length !== length", "training.length < length"],
    ["device-learning/room/connected-process.ts", "CONNECTED_PROCESS_POINTS = 256", "CONNECTED_PROCESS_POINTS = 255"],
    ["device-learning/room/fit-policy.ts", "start < to", "start < from"],
    ["device-model-learning/room-band-fit-capture.ts", "bytes[at + coreBytes] = 1", "bytes[at + coreBytes] = 0"],
    ["device-model-learning/room.ts", "receiver) < 0.0001", "receiver) < 20"],
    ["device-model-learning/room-fit-input.ts", "ratedPowerW: metadata.ratedPowerW", "ratedPowerW: null"],
    ["device-model-learning/room-fit-input.ts", "(last.duration_s ?? 900) * 1000", "(last.duration_s ?? 900) * 2000"],
    ["device-model-learning/room.ts", "row.version !== ROOM_SHARED_METADATA_VERSION", "row.version === ROOM_SHARED_METADATA_VERSION"],
  ];
  for (const [path, before, after] of mutations) {
    assertNotEquals(await roomLearnerDigest(replacing(`supabase/functions/_shared/${path}`, before, after)), digest, path);
  }
});

Deno.test("transport edits and generated identity do not restart compatible fitting", async () => {
  const digest = await roomLearnerDigest();
  // This adapter lives beside pure publication code. Tree shaking must remove
  // it, rather than fingerprinting the whole file because an export was used.
  assertEquals(await roomLearnerDigest(replacing("supabase/functions/_shared/device-model-learning/room.ts",
    "get_energy_room_evidence_work", "transport_only_rpc_rename")), digest);
  assertEquals(await roomLearnerDigest(replacing(ROOM_LEARNER_VERSION_FILE,
    'ROOM_LEARNER_VERSION = "room-learner:', 'ROOM_LEARNER_VERSION = "changed:')), digest);
  assertEquals(await roomLearnerDigest(replacing("supabase/functions/_shared/device-learning/room/fit-policy.ts",
    "export const ROOM_FIT_WINDOW_DAYS", "// Deployment comment\nexport const ROOM_FIT_WINDOW_DAYS")), digest);
});
