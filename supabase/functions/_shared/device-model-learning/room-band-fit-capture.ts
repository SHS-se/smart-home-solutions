import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";

const HISTORY_SECONDS = 400 * 86_400;
const MAX_ROWS = HISTORY_SECONDS / 900;
interface CaptureFormat { timeBytes: 4 | 8; timeUnitMs: number; peers?: true }
// The existing band codec remains the explicit format of archived/probe inputs.
const BAND_FORMAT: CaptureFormat = { timeBytes: 4, timeUnitMs: 1000 };
// Chronological captures also retain fractional-second native/legacy seams.
const RESPONSE_FORMAT: CaptureFormat = { timeBytes: 8, timeUnitMs: 1, peers: true };
export const ROOM_RESPONSE_CAPTURE_REVISION = "response_native_peers_v1";
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
  Promise<{ base64: string; sha256: string; row_count: number; header_bytes: number; row_bytes: number }> {
  const { from, origin } = captureTime(fromAt, format);
  const keys = format.peers ? [...new Set(rows.flatMap(row => Object.keys(row.peer_c ?? {})))].sort() : [];
  if (keys.some(key => !key.length)) throw new Error("Invalid room peer identity");
  const dictionary = format.peers ? new TextEncoder().encode(JSON.stringify(keys)) : new Uint8Array();
  const header = format.peers ? 4 + dictionary.length : 0;
  const peerTags = Math.ceil(keys.length / 4);
  const coreBytes = format.timeBytes + 66;
  const rowBytes = coreBytes + (format.peers ? 1 + peerTags + keys.length * 8 : 0);
  if (!format.peers && rows.length > MAX_ROWS) throw new Error("Room band capture exceeds its history window");
  const bytes = new Uint8Array(header + rows.length * rowBytes), view = new DataView(bytes.buffer);
  if (format.peers) { view.setUint32(0, dictionary.length, true); bytes.set(dictionary, 4); }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], at = header + index * rowBytes, offset = (row.start_ms - origin) / format.timeUnitMs;
    const duration = DURATION.indexOf(row.duration_s), cooling = COOLING.indexOf(row.cooling);
    const attributed = ATTRIBUTED.indexOf(row.heat_attributed);
    if (!Number.isSafeInteger(offset) || row.start_ms < from || !format.peers && offset * format.timeUnitMs >= HISTORY_SECONDS * 1000 ||
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
    if (format.peers && row.peer_c !== undefined) {
      if (!row.peer_c || typeof row.peer_c !== "object" || Array.isArray(row.peer_c)) throw new Error("Invalid room peers");
      bytes[at + coreBytes] = 1;
      keys.forEach((key, j) => {
        if (!Object.hasOwn(row.peer_c!, key)) return;
        const value = row.peer_c![key];
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid room peer measurement");
        bytes[at + coreBytes + 1 + (j >> 2)] |= (value === null ? 1 : 2) << ((j % 4) * 2);
        if (value !== null) view.setFloat64(at + coreBytes + 1 + peerTags + j * 8, value, true);
      });
    }
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { base64: btoa(binary), sha256: await digest(bytes), row_count: rows.length, header_bytes: header, row_bytes: rowBytes };
}

async function decodeCapture(base64: string, fromAt: string, sha256: string, format: CaptureFormat): Promise<RoomMeanQuarter[]> {
  const { from, origin } = captureTime(fromAt, format);
  if (base64.length % 4 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid room band capture envelope");
  }
  const raw = atob(base64);
  if (!format.peers && raw.length % (format.timeBytes + 66)) throw new Error("Invalid room band capture length");
  const bytes = new Uint8Array(raw.length), view = new DataView(bytes.buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (await digest(bytes) !== sha256) throw new Error("Room band capture digest mismatch");
  let header = 0, keys: string[] = [];
  if (format.peers) {
    if (bytes.length < 4) throw new Error("Invalid room peer dictionary");
    header = 4 + view.getUint32(0, true);
    if (header > bytes.length) throw new Error("Invalid room peer dictionary");
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, header)));
    if (!Array.isArray(decoded) || decoded.some((key, i) => typeof key !== "string" || !key.length || i > 0 && key <= decoded[i - 1])) {
      throw new Error("Invalid room peer dictionary");
    }
    keys = decoded;
  }
  const peerTags = Math.ceil(keys.length / 4), coreBytes = format.timeBytes + 66;
  const rowBytes = coreBytes + (format.peers ? 1 + peerTags + keys.length * 8 : 0);
  if ((raw.length - header) % rowBytes || !format.peers && (raw.length - header) / rowBytes > MAX_ROWS) throw new Error("Invalid room band capture length");
  const rows: RoomMeanQuarter[] = [];
  for (let at = header; at < bytes.length; at += rowBytes) {
    const offset = format.timeBytes === 4 ? view.getUint32(at, true) : view.getFloat64(at, true);
    const start_ms = origin + offset * format.timeUnitMs;
    const tags = bytes[at + format.timeBytes], presence = bytes[at + format.timeBytes + 1];
    const duration = tags & 3, cooling = (tags >> 2) & 3, attributed = (tags >> 4) & 3;
    if (!Number.isSafeInteger(offset) || start_ms < from || !format.peers && offset * format.timeUnitMs >= HISTORY_SECONDS * 1000 || tags > 0x7f || presence > 0x7f ||
      duration === 3 || cooling === 3 || attributed === 3 || ((presence & FORCING_ABSENT) && (presence & 0x20))) {
      throw new Error("Invalid room band capture interval");
    }
    const readings = MEASUREMENTS.map((_, j) => presence & (1 << j) ? view.getFloat64(at + format.timeBytes + 2 + 8 * j, true) : null);
    if (readings.some(value => value !== null && !Number.isFinite(value))) throw new Error("Invalid room band capture measurement");
    const [room_c, outdoor_c, house_c, solar_w_per_m2, heat_w, band_forcing_c_per_h] = readings;
    const row: RoomMeanQuarter = { start_ms, room_c, outdoor_c, house_c, solar_w_per_m2, heat_w, cooling: COOLING[cooling] };
    const operation = Array.from(bytes.subarray(at + format.timeBytes + 50, at + coreBytes), byte => byte.toString(16).padStart(2, "0")).join("");
    if (tags & 0x40) row.operation_fact = operation.slice(0, 8) + "-" + operation.slice(8, 12) + "-" +
      operation.slice(12, 16) + "-" + operation.slice(16, 20) + "-" + operation.slice(20);
    else if (operation !== "0".repeat(32)) throw new Error("Unexpected room operation fact identity");
    if (duration !== 0) row.duration_s = DURATION[duration];
    if (attributed !== 0) row.heat_attributed = ATTRIBUTED[attributed];
    if (!(presence & FORCING_ABSENT)) row.band_forcing_c_per_h = band_forcing_c_per_h;
    if (format.peers) {
      const present = bytes[at + coreBytes];
      if (present > 1) throw new Error("Invalid room peer presence");
      const peers: Record<string, number | null> = {};
      keys.forEach((key, j) => {
        const tag = (bytes[at + coreBytes + 1 + (j >> 2)] >> ((j % 4) * 2)) & 3;
        const value = view.getFloat64(at + coreBytes + 1 + peerTags + j * 8, true);
        if (tag === 3 || !present && tag !== 0 || tag !== 2 && value !== 0 || tag === 2 && !Number.isFinite(value)) {
          throw new Error("Invalid room peer measurement");
        }
        if (tag) peers[key] = tag === 1 ? null : value;
      });
      if (present) row.peer_c = peers;
    }
    rows.push(row);
  }
  return rows;
}


/** Archived band captures have their own fixed, seconds-based wire format. */
export const encodeRoomBandFitCapture = (rows: readonly RoomMeanQuarter[], fromAt: string) => encodeCapture(rows, fromAt, BAND_FORMAT);
export const decodeRoomBandFitCapture = (base64: string, fromAt: string, sha256: string) => decodeCapture(base64, fromAt, sha256, BAND_FORMAT);

/** Envelope-6 numerical captures preserve native starts and named peer means. */
export const encodeRoomResponseFitCapture = (rows: readonly RoomMeanQuarter[], fromAt: string) => encodeCapture(rows, fromAt, RESPONSE_FORMAT);
export const decodeRoomResponseFitCapture = (base64: string, fromAt: string, sha256: string) => decodeCapture(base64, fromAt, sha256, RESPONSE_FORMAT);
