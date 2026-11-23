import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";

const HISTORY_SECONDS = 400 * 86_400;
const MAX_ROWS = HISTORY_SECONDS / 900;
interface CaptureFormat { timeBytes: 4 | 8; timeUnitMs: number }
// The existing band codec remains the explicit format of archived/probe inputs.
const BAND_FORMAT: CaptureFormat = { timeBytes: 4, timeUnitMs: 1000 };
// Chronological captures also retain fractional-second native/legacy seams.
const RESPONSE_FORMAT: CaptureFormat = { timeBytes: 8, timeUnitMs: 1 };
const DURATION = [undefined, 900, 3600] as const;
const COOLING = [null, false, true] as const;
const ATTRIBUTED = [undefined, false, true] as const;
const MEASUREMENTS = ["room_c", "outdoor_c", "house_c", "solar_w_per_m2", "heat_w", "band_forcing_c_per_h"] as const;
const FORCING_ABSENT = 0x40;

function captureTime(fromAt: string, format: CaptureFormat) {
  const from = Date.parse(fromAt);
  if (!Number.isFinite(from)) throw new Error("Invalid room band capture start");
  return { from, origin: Math.floor(from / format.timeUnitMs) * format.timeUnitMs };
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The staged fit owns a compact derived numeric view of a fixed capture.
 * Each row stores its relative start, interval tags and six IEEE-754 values.
 * Presence bits preserve unavailable observations and an omitted forcing term. */
async function encodeCapture(rows: readonly RoomMeanQuarter[], fromAt: string, format: CaptureFormat):
  Promise<{ base64: string; sha256: string; row_count: number }> {
  const { from, origin } = captureTime(fromAt, format);
  const rowBytes = format.timeBytes + 66;
  if (rows.length > MAX_ROWS) throw new Error("Room band capture exceeds its history window");
  const bytes = new Uint8Array(rows.length * rowBytes), view = new DataView(bytes.buffer);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], at = index * rowBytes, offset = (row.start_ms - origin) / format.timeUnitMs;
    const duration = DURATION.indexOf(row.duration_s), cooling = COOLING.indexOf(row.cooling);
    const attributed = ATTRIBUTED.indexOf(row.heat_attributed);
    if (!Number.isInteger(offset) || row.start_ms < from || offset * format.timeUnitMs >= HISTORY_SECONDS * 1000 ||
      duration < 0 || cooling < 0 || attributed < 0) throw new Error("Invalid room band capture interval");
    if (format.timeBytes === 4) view.setUint32(at, offset, true);
    else view.setFloat64(at, offset, true);
    bytes[at + format.timeBytes] = duration | cooling << 2 | attributed << 4;
    if (row.operation_fact !== undefined) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.operation_fact)) {
        throw new Error("Invalid room operation fact identity");
      }
      bytes[at + format.timeBytes] |= 0x40;
      const hex = row.operation_fact.replaceAll("-", "");
      for (let j = 0; j < 16; j++) bytes[at + format.timeBytes + 50 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
    let presence = row.band_forcing_c_per_h === undefined ? FORCING_ABSENT : 0;
    for (let j = 0; j < MEASUREMENTS.length; j++) {
      const field = MEASUREMENTS[j], value = row[field];
      if (value === null || (value === undefined && field === "band_forcing_c_per_h")) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid room band capture measurement");
      presence |= 1 << j;
      view.setFloat64(at + format.timeBytes + 2 + 8 * j, value, true);
    }
    bytes[at + format.timeBytes + 1] = presence;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { base64: btoa(binary), sha256: await digest(bytes), row_count: rows.length };
}

async function decodeCapture(base64: string, fromAt: string, sha256: string, format: CaptureFormat): Promise<RoomMeanQuarter[]> {
  const { from, origin } = captureTime(fromAt, format);
  const rowBytes = format.timeBytes + 66;
  const maxBase64Chars = 4 * Math.ceil(MAX_ROWS * rowBytes / 3);
  if (base64.length > maxBase64Chars || base64.length % 4 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid room band capture envelope");
  }
  const raw = atob(base64);
  if (raw.length % rowBytes) throw new Error("Invalid room band capture length");
  const bytes = new Uint8Array(raw.length), view = new DataView(bytes.buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (await digest(bytes) !== sha256) throw new Error("Room band capture digest mismatch");
  const rows: RoomMeanQuarter[] = [];
  for (let at = 0; at < bytes.length; at += rowBytes) {
    const offset = format.timeBytes === 4 ? view.getUint32(at, true) : view.getFloat64(at, true);
    const start_ms = origin + offset * format.timeUnitMs;
    const tags = bytes[at + format.timeBytes], presence = bytes[at + format.timeBytes + 1];
    const duration = tags & 3, cooling = (tags >> 2) & 3, attributed = (tags >> 4) & 3;
    if (!Number.isSafeInteger(offset) || start_ms < from || offset * format.timeUnitMs >= HISTORY_SECONDS * 1000 || tags > 0x7f || presence > 0x7f ||
      duration === 3 || cooling === 3 || attributed === 3 || ((presence & FORCING_ABSENT) && (presence & 0x20))) {
      throw new Error("Invalid room band capture interval");
    }
    const readings = MEASUREMENTS.map((_, j) => presence & (1 << j) ? view.getFloat64(at + format.timeBytes + 2 + 8 * j, true) : null);
    if (readings.some(value => value !== null && !Number.isFinite(value))) throw new Error("Invalid room band capture measurement");
    const [room_c, outdoor_c, house_c, solar_w_per_m2, heat_w, band_forcing_c_per_h] = readings;
    const row: RoomMeanQuarter = { start_ms, room_c, outdoor_c, house_c, solar_w_per_m2, heat_w, cooling: COOLING[cooling] };
    const operation = Array.from(bytes.subarray(at + format.timeBytes + 50, at + rowBytes), byte => byte.toString(16).padStart(2, "0")).join("");
    if (tags & 0x40) row.operation_fact = operation.slice(0, 8) + "-" + operation.slice(8, 12) + "-" +
      operation.slice(12, 16) + "-" + operation.slice(16, 20) + "-" + operation.slice(20);
    else if (operation !== "0".repeat(32)) throw new Error("Unexpected room operation fact identity");
    if (duration !== 0) row.duration_s = DURATION[duration];
    if (attributed !== 0) row.heat_attributed = ATTRIBUTED[attributed];
    if (!(presence & FORCING_ABSENT)) row.band_forcing_c_per_h = band_forcing_c_per_h;
    rows.push(row);
  }
  return rows;
}


/** Archived band captures have their own fixed, seconds-based wire format. */
export const encodeRoomBandFitCapture = (rows: readonly RoomMeanQuarter[], fromAt: string) => encodeCapture(rows, fromAt, BAND_FORMAT);
export const decodeRoomBandFitCapture = (base64: string, fromAt: string, sha256: string) => decodeCapture(base64, fromAt, sha256, BAND_FORMAT);

/** Envelope-4 numerical captures preserve each interval's millisecond start. */
export const encodeRoomResponseFitCapture = (rows: readonly RoomMeanQuarter[], fromAt: string) => encodeCapture(rows, fromAt, RESPONSE_FORMAT);
export const decodeRoomResponseFitCapture = (base64: string, fromAt: string, sha256: string) => decodeCapture(base64, fromAt, sha256, RESPONSE_FORMAT);
