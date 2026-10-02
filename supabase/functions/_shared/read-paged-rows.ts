/** Read every row of an ordered query; PostgREST caps each response independently. */
export async function readPagedRows<T>(
  read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const page = await read(rows.length, rows.length + 999);
    if (page.error) throw page.error;
    if (!page.data?.length) return rows;
    rows.push(...page.data);
  }
}
