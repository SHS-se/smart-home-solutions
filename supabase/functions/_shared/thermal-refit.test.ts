import { assertEquals } from "jsr:@std/assert@1";
import { zoneRefitIsDue } from "./thermal-training.ts";

const NOW = Date.parse("2026-10-19T17:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

Deno.test("trained rooms refit once a day", () => {
  const attempts = [{ room_key: "bedroom", trained: true, last_attempted_at: ago(3) }];
  assertEquals(zoneRefitIsDue(NOW, attempts, ["bedroom"]), false);
  assertEquals(zoneRefitIsDue(NOW, [{ ...attempts[0], last_attempted_at: ago(25) }], ["bedroom"]), true);
  assertEquals(zoneRefitIsDue(NOW, [], ["bedroom"]), true);
});

Deno.test("a planned room without a trained model is retried hourly", () => {
  // The bathroom was mapped after the bedroom's daily fit: its history should
  // not wait the rest of that day.
  const attempts = [{ room_key: "bedroom", trained: true, last_attempted_at: ago(3) }];
  assertEquals(zoneRefitIsDue(NOW, attempts, ["bedroom", "master_bathroom"]), true);
  // A failed attempt half an hour ago waits for the hour.
  const untrained = [...attempts, { room_key: "master_bathroom", trained: false, last_attempted_at: ago(0.5) }];
  assertEquals(zoneRefitIsDue(NOW, untrained, ["bedroom", "master_bathroom"]), false);
  assertEquals(zoneRefitIsDue(NOW, untrained.map((a) => ({ ...a, last_attempted_at: ago(2) })),
    ["bedroom", "master_bathroom"]), true);
});
