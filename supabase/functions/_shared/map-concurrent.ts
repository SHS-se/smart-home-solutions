/** Ordered results with a fixed number of readers, refilled as each read finishes. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, read: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await read(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
