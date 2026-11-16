import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { parseRoomUpload } from "./upload.ts";

Deno.test("probe-only quarters do not require a mapped device and reject only unusable samples", () => {
  const correct = { room_key: "hall", start: "2026-11-17T08:00:00Z", temperature_c: 18.5 };
  const upload = parseRoomUpload({
    home_id: "untrusted",
    rooms: { hall: { name: "Hall", source_key: "a".repeat(64) }, garage: { name: "Garage", source_key: null } },
    slots: [correct, correct, { ...correct, room_key: "garage" },
      { ...correct, start: "2026-11-17T08:15:00Z" },
      { ...correct, temperature_c: null }, { ...correct, start: "2026-11-17T07:15:00Z" }],
  }, Date.parse("2026-11-17T08:21:00Z"));
  assertEquals(upload?.ignored, 4);
  assertEquals(upload?.slots, [
    { room_key: "hall", start_ts: "2026-11-17T08:00:00.000Z", temperature_c: 18.5 },
    { room_key: "hall", start_ts: "2026-11-17T07:15:00.000Z", temperature_c: 18.5 },
  ]);
});
