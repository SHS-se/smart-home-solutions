/** A failed refit can omit retained parameters only when updating a stored row.
 * PostgreSQL checks an upsert's proposed insert before resolving its conflict,
 * so a partial upsert fails the fitted-or-rejected constraint even if the
 * existing row contains a complete fit. */
export async function storePoolModelRow(
  db: PoolModelDatabase,
  row: PoolModelRow,
  hasExistingModel: boolean,
): Promise<PoolModelWriteResult> {
  const table = db.from("energy_optimisation_pool_model");
  return hasExistingModel
    ? await table.update(row).eq("home_id", row.home_id)
    : await table.upsert(row, { onConflict: "home_id" });
}
type PoolModelRow = Record<string, unknown> & { home_id: string };
type PoolModelWriteResult = { error: { message: string } | null };

interface PoolModelDatabase {
  from(table: "energy_optimisation_pool_model"): {
    upsert(row: PoolModelRow, options: { onConflict: "home_id" }): PromiseLike<PoolModelWriteResult>;
    update(row: PoolModelRow): {
      eq(column: "home_id", value: string): PromiseLike<PoolModelWriteResult>;
    };
  };
}

