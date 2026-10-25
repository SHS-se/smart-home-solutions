import type { DeviceModelBundle } from "./device-model-store.ts";

/** Captured inputs only: this adapter has no client, credentials or network path. */
export interface DeviceLearningReplayInput {
  claim: {
    id: string; home_id: string; customer_id: string; owner_kind: "pool"; owner_key: string;
    generation: number; fence: number;
    input: { location?: { latitude: number; longitude: number } | null; volume_m3?: number; device_keys?: string[] };
  };
  models: Pick<DeviceModelBundle, "rooms" | "pool">;
  /** Rows must already satisfy the captured owner's filters and ordering. */
  tables: Record<string, Record<string, unknown>[] | Record<string, unknown> | null>;
}

/** Replay the actual worker through paginated JSON decoding and publication.
 * Database writes are recorded in memory; unexpected operations fail closed. */
export function createDeviceLearningReplay(input: DeviceLearningReplayInput) {
  if (input.claim.owner_kind !== "pool") throw new Error("Learning replay currently supports the pool owner only");
  const encoded = new Map(Object.entries(input.tables).map(([name, rows]) => [name, JSON.stringify(rows)]));
  const pages = new Map(Object.entries(input.tables).filter(([, rows]) => Array.isArray(rows)).map(([name, rows]) => {
    const values = rows as Record<string, unknown>[];
    const result = new Map<number, string>();
    for (let offset = 0; offset <= values.length; offset += 1000) result.set(offset, JSON.stringify(values.slice(offset, offset + 1000)));
    return [name, result];
  }));
  const publications: Record<string, unknown>[] = [], failures: Record<string, unknown>[] = [];
  const reads: { table: string; from?: number; to?: number }[] = [];
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const db = {
    from(table: string) {
      if (!encoded.has(table)) throw new Error(`Uncaptured learning table: ${table}`);
      const single = () => {
        reads.push({ table });
        return Promise.resolve({ data: JSON.parse(encoded.get(table)!), error: null });
      };
      return {
        select() { return this; }, eq() { return this; }, in() { return this; }, gte() { return this; }, order() { return this; },
        maybeSingle: single,
        range(from: number, to: number) {
          if (!Number.isSafeInteger(from) || from < 0 || to !== from + 999) throw new Error("Unexpected learning page size");
          if (!pages.has(table)) throw new Error(`Learning table is not paginated: ${table}`);
          reads.push({ table, from, to });
          return Promise.resolve({ data: JSON.parse(pages.get(table)!.get(from) ?? "[]"), error: null });
        },
        then: <T>(resolve: (result: { data: unknown; error: null }) => T | PromiseLike<T>) => single().then(resolve),
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      let data: unknown;
      switch (name) {
        case "verify_energy_learning_token": data = true; break;
        case "claim_energy_device_learning": data = input.claim; break;
        case "capture_energy_device_models": data = input.models; break;
        case "publish_energy_device_learning": publications.push(copy(args)); data = true; break;
        case "fail_energy_device_learning": failures.push(copy(args)); data = true; break;
        default: throw new Error(`Uncaptured learning RPC: ${name}`);
      }
      return Promise.resolve({ data: copy(data), error: null });
    },
  };
  return { db, publications, failures, reads };
}
