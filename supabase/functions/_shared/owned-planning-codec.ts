import { compressForecastValue, decompressForecastValue } from "./room-forecast-catalog.ts";
export function ownedPlanningBase64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export async function packOwnedPlanningValue(value: unknown): Promise<string> {
  return ownedPlanningBase64(await compressForecastValue(value));
}
export class OwnedPlanningArtifactError extends Error {
  constructor(message: string) { super(message); this.name = "OwnedPlanningArtifactError"; }
}
export async function unpackOwnedPlanningValue<T>(value: string): Promise<T> {
  try { return await decompressForecastValue(Uint8Array.from(atob(value), c => c.charCodeAt(0))) as T; }
  catch { throw new OwnedPlanningArtifactError("Unreadable derived planning artifact"); }
}
