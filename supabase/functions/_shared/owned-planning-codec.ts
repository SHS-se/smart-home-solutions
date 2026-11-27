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
  try {
    const binary = atob(value), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await decompressForecastValue(bytes) as T;
  }
  catch { throw new OwnedPlanningArtifactError("Unreadable derived planning artifact"); }
}
