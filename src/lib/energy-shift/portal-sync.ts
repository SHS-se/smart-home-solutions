/** Content-addressed history handles late inserts/corrections without trusting
 * client clocks or database transaction timestamps. One cache belongs to one home. */
export interface SlotRow { start_ts: string }
export interface HistoryDelta<T extends SlotRow> {
  upserts: { row: T; hash: string }[];
  removed: string[];
}
export class HistoryCache<T extends SlotRow> {
  private entries = new Map<string, { row: T; hash: string }>();
  hashes(): Record<string, string> {
    return Object.fromEntries([...this.entries].map(([key, entry]) => [key, entry.hash]));
  }
  apply(delta: HistoryDelta<T>): T[] {
    for (const key of delta.removed) this.entries.delete(key);
    for (const entry of delta.upserts) this.entries.set(entry.row.start_ts, entry);
    return [...this.entries.values()].map(entry => entry.row)
      .sort((a, b) => Date.parse(a.start_ts) - Date.parse(b.start_ts));
  }
}
export interface ChangedValue<T> { hash: string; value: T | null }
