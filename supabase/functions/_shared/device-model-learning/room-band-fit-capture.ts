import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";

const HISTORY_SECONDS = 400 * 86_400;
const MAX_ROWS = HISTORY_SECONDS / 900;
const ROW_BYTES = 54;
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_ROWS * ROW_BYTES / 3);
const DURATION = [undefined, 900, 3600] as const;
const COOLING = [null, false, true] as const;
const ATTRIBUTED = [undefined, false, true] as const;
const MEASUREMENTS = ["room_c", "outdoor_c", "house_c", "solar_w_per_m2", "heat_w", "band_forcing_c_per_h"] as const;
const FORCING_ABSENT = 0x40;

function captureTime(fromAt: string) {
  const from = Date.parse(fromAt);
  if (!Number.isFinite(from)) throw new Error("Invalid room band capture start");
  return { from, origin: Math.floor(from / 1000) * 1000 };
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The staged fit owns a compact derived numeric view of a fixed capture.
 * Each row stores its relative start, interval tags and six IEEE-754 values.
 * Presence bits preserve unavailable observations and an omitted forcing term. */
export async function encodeRoomBandFitCapture(rows: readonly RoomMeanQuarter[], fromAt: string):
  Promise<{ base64: string; sha256: string; row_count: number }> {
  const { from, origin } = captureTime(fromAt);
  if (rows.length > MAX_ROWS) throw new Error("Room band capture exceeds its history window");
  const bytes = new Uint8Array(rows.length * ROW_BYTES), view = new DataView(bytes.buffer);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], at = index * ROW_BYTES, offset = (row.start_ms - origin) / 1000;
    const duration = DURATION.indexOf(row.duration_s), cooling = COOLING.indexOf(row.cooling);
    const attributed = ATTRIBUTED.indexOf(row.heat_attributed);
    if (!Number.isInteger(offset) || row.start_ms < from || offset >= HISTORY_SECONDS ||
      duration < 0 || cooling < 0 || attributed < 0) throw new Error("Invalid room band capture interval");
    view.setUint32(at, offset, true);
    bytes[at + 4] = duration | cooling << 2 | attributed << 4;
    let presence = row.band_forcing_c_per_h === undefined ? FORCING_ABSENT : 0;
    for (let j = 0; j < MEASUREMENTS.length; j++) {
      const field = MEASUREMENTS[j], value = row[field];
      if (value === null || (value === undefined && field === "band_forcing_c_per_h")) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid room band capture measurement");
      presence |= 1 << j;
      view.setFloat64(at + 6 + 8 * j, value, true);
    }
    bytes[at + 5] = presence;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { base64: btoa(binary), sha256: await digest(bytes), row_count: rows.length };
}

export async function decodeRoomBandFitCapture(base64: string, fromAt: string, sha256: string): Promise<RoomMeanQuarter[]> {
  const { from, origin } = captureTime(fromAt);
  if (base64.length > MAX_BASE64_CHARS || base64.length % 4 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid room band capture envelope");
  }
  const raw = atob(base64);
  if (raw.length % ROW_BYTES) throw new Error("Invalid room band capture length");
  const bytes = new Uint8Array(raw.length), view = new DataView(bytes.buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (await digest(bytes) !== sha256) throw new Error("Room band capture digest mismatch");
  const rows: RoomMeanQuarter[] = [];
  for (let at = 0; at < bytes.length; at += ROW_BYTES) {
    const offset = view.getUint32(at, true), start_ms = origin + offset * 1000;
    const tags = bytes[at + 4], presence = bytes[at + 5];
    const duration = tags & 3, cooling = (tags >> 2) & 3, attributed = (tags >> 4) & 3;
    if (start_ms < from || offset >= HISTORY_SECONDS || tags > 0x3f || presence > 0x7f ||
      duration === 3 || cooling === 3 || attributed === 3 || ((presence & FORCING_ABSENT) && (presence & 0x20))) {
      throw new Error("Invalid room band capture interval");
    }
    const readings = MEASUREMENTS.map((_, j) => presence & (1 << j) ? view.getFloat64(at + 6 + 8 * j, true) : null);
    if (readings.some(value => value !== null && !Number.isFinite(value))) throw new Error("Invalid room band capture measurement");
    const [room_c, outdoor_c, house_c, solar_w_per_m2, heat_w, band_forcing_c_per_h] = readings;
    const row: RoomMeanQuarter = { start_ms, room_c, outdoor_c, house_c, solar_w_per_m2, heat_w, cooling: COOLING[cooling] };
    if (duration !== 0) row.duration_s = DURATION[duration];
    if (attributed !== 0) row.heat_attributed = ATTRIBUTED[attributed];
    if (!(presence & FORCING_ABSENT)) row.band_forcing_c_per_h = band_forcing_c_per_h;
    rows.push(row);
  }
  return rows;
}
