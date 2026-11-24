import { assert, assertEquals } from "@std/assert";
import { ROOM_LEARNER_VERSION_FILE, roomLearnerDigest, roomLearnerSources, roomLearnerVersionSource } from "../scripts/room-learner-version.ts";

Deno.test("the room learner version is the digest of its current source", async () => {
  const stored = await Deno.readTextFile(ROOM_LEARNER_VERSION_FILE);
  assertEquals(stored, roomLearnerVersionSource(await roomLearnerDigest()),
    "The room learner changed. Run `deno task generate:room-learner-version` so every room refits with it.");
});

Deno.test("the room learner version covers the fitting code and excludes tests and itself", async () => {
  const sources = await roomLearnerSources();
  assert(sources.includes("supabase/functions/_shared/device-learning/room/measured-response.ts"));
  assert(sources.includes("supabase/functions/_shared/device-model-learning/room.ts"));
  assert(!sources.some(path => /\.(test|fixture)\.ts$/.test(path)));
  assert(!sources.includes(ROOM_LEARNER_VERSION_FILE));
});
