import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";
import { decodeRoomBandFitCapture, encodeRoomBandFitCapture, decodeRoomResponseFitCapture, encodeRoomResponseFitCapture } from "./room-band-fit-capture.ts";

const start = Date.UTC(2025, 0, 1);
const from = new Date(start - 500).toISOString();
const basic: RoomMeanQuarter = { start_ms: start, room_c: 19 + Math.PI / 100, outdoor_c: -7,
  house_c: 22, solar_w_per_m2: -0, heat_w: 0, cooling: false };

Deno.test("room fit capture retains original mixed interval means and nullable tags", async () => {
  const rows: RoomMeanQuarter[] = [
    basic,
    { ...basic, start_ms: start + 900_000, duration_s: 900, room_c: null, house_c: null, heat_w: null,
      cooling: null, band_forcing_c_per_h: null, heat_attributed: true },
    { ...basic, start_ms: start + 3_600_000, duration_s: 3600, outdoor_c: null, solar_w_per_m2: null,
      heat_w: 253.315, band_forcing_c_per_h: .000000001, cooling: true, heat_attributed: false,
      operation_fact: "01234567-89ab-4cde-8f01-23456789abcd" },
  ];
  const capture = await encodeRoomBandFitCapture(rows, from);
  assertEquals(capture.row_count, 3);
  assertEquals(capture.base64.length, 280);
  const decoded = await decodeRoomBandFitCapture(capture.base64, from, capture.sha256);
  assertEquals(decoded, rows);
  assertEquals(Object.is(decoded[0].solar_w_per_m2, -0), true);
  assertEquals(await encodeRoomBandFitCapture(decoded, from), capture);
});

Deno.test("room fit capture digest changes on explicit missing forcing or changed measurements", async () => {
  const ordinary = await encodeRoomBandFitCapture([basic], from);
  const forcingUnavailable = await encodeRoomBandFitCapture([{ ...basic, band_forcing_c_per_h: null }], from);
  const heatUnavailable = await encodeRoomBandFitCapture([{ ...basic, heat_w: null }], from);
  assertNotEquals(ordinary.sha256, forcingUnavailable.sha256);
  assertNotEquals(ordinary.sha256, heatUnavailable.sha256);
  await assertRejects(() => decodeRoomBandFitCapture(ordinary.base64, from, heatUnavailable.sha256), Error, "digest mismatch");
  await assertRejects(() => decodeRoomBandFitCapture(ordinary.base64.slice(4), from, ordinary.sha256), Error, "capture length");
  await assertRejects(() => encodeRoomBandFitCapture([{ ...basic, room_c: Infinity }], from), Error, "capture measurement");
  await assertRejects(() => encodeRoomBandFitCapture([{ ...basic, start_ms: start - 1000 }], from), Error, "capture interval");
});

Deno.test("room fit transport enforces interval flags even when the digest matches", async () => {
  const bytes = new Uint8Array(70);
  bytes[4] = 3; // Reserved resolution code.
  const base64 = btoa(String.fromCharCode(...bytes));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  await assertRejects(() => decodeRoomBandFitCapture(base64, new Date(start).toISOString(), sha256), Error, "capture interval");
});

Deno.test("chronological numerical captures preserve fractional seams without merging unavailable observations", async () => {
  const rows: RoomMeanQuarter[] = [
    { ...basic, start_ms: start + 123, duration_s: 3600, heat_w: null },
    { ...basic, start_ms: start + 3_600_123, duration_s: 900, room_c: null },
    { ...basic, start_ms: start + 7_200_000, duration_s: 900, cooling: null },
  ];
  const capture = await encodeRoomResponseFitCapture(rows, from);
  assertEquals(await decodeRoomResponseFitCapture(capture.base64, from, capture.sha256), rows);
  assertEquals(await encodeRoomResponseFitCapture(await decodeRoomResponseFitCapture(capture.base64, from, capture.sha256), from), capture);
  const empty = await encodeRoomResponseFitCapture([], from);
  assertEquals(await decodeRoomResponseFitCapture(empty.base64, from, empty.sha256), []);
});

Deno.test("connected numeric capture keeps named peer zero, unknown, absent and prefix-qualified observations distinct", async () => {
  // Synthetic native room means, including a legitimate zero Celsius reading.
  const rows: RoomMeanQuarter[] = [basic, { ...basic, start_ms: start + 900_000, peer_c: {} },
    { ...basic, start_ms: start + 1_800_000, peer_c: { north: 0, south: null } },
    { ...basic, start_ms: start + 2_700_000, peer_c: { south: 21.125, north: -0 } }];
  const encoded = await encodeRoomResponseFitCapture(rows, from);
  assertEquals(await decodeRoomResponseFitCapture(encoded.base64, from, encoded.sha256), rows);
  const reordered = rows.map(row => row.peer_c ? { ...row, peer_c: Object.fromEntries(Object.entries(row.peer_c).reverse()) } : row);
  assertEquals(await encodeRoomResponseFitCapture(reordered, from), encoded);
  await assertRejects(() => encodeRoomResponseFitCapture([{ ...basic, peer_c: { north: Infinity } }], from), Error, "peer measurement");
});

Deno.test("response captures continue beyond a fitted history horizon without discarding native rows", async () => {
  // Independently generated 401-day means plus a late capture many years later.
  const rows = Array.from({ length: 401 * 96 }, (_, i) => ({ ...basic, start_ms: start + i * 900_000 }));
  rows.push({ ...basic, start_ms: start + 1000 * 86400_000 });
  const encoded = await encodeRoomResponseFitCapture(rows, from);
  assertEquals(await decodeRoomResponseFitCapture(encoded.base64, from, encoded.sha256), rows);
  await assertRejects(() => encodeRoomBandFitCapture(rows, from), Error, "history window");
});
