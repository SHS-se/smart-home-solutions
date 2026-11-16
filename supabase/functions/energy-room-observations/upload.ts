const quarterMs = 15 * 60_000;
const historyMs = 8 * 24 * 60 * 60_000;
type Room = { name: string; source_key: string | null };
type Reading = { room_key: string; start_ts: string; temperature_c: number };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Scope comes from the device token. The body contains only local room identities. */
export function parseRoomUpload(body: unknown, now: number) {
  if (!object(body) || !object(body.rooms) || !Array.isArray(body.slots)) return null;
  const rooms = new Map<string, Room>();
  for (const [key, value] of Object.entries(body.rooms)) {
    if (!key.trim() || !object(value) || typeof value.name !== "string" || !value.name.trim() ||
      !(value.source_key === null || typeof value.source_key === "string" && /^[0-9a-f]{64}$/.test(value.source_key))) return null;
    rooms.set(key, { name: value.name, source_key: value.source_key });
  }
  const readings = new Map<string, Reading>();
  let ignored = 0;
  const completedThrough = Math.floor(now / quarterMs) * quarterMs - quarterMs;
  for (const row of body.slots) {
    const start = object(row) && typeof row.start === "string" ? Date.parse(row.start) : NaN;
    if (!object(row) || typeof row.room_key !== "string" || !rooms.get(row.room_key)?.source_key ||
      !Number.isFinite(start) || start % quarterMs !== 0 || start > completedThrough || start < completedThrough - historyMs ||
      typeof row.temperature_c !== "number" || !Number.isFinite(row.temperature_c) ||
      row.temperature_c < -50 || row.temperature_c > 80) {
      ignored++;
      continue;
    }
    const key = JSON.stringify([row.room_key, start]);
    if (readings.has(key)) { ignored++; continue; }
    readings.set(key, { room_key: row.room_key, start_ts: new Date(start).toISOString(), temperature_c: row.temperature_c });
  }
  return { rooms: Object.fromEntries(rooms), slots: [...readings.values()], ignored };
}
