

## Remove `include_in_standard_home` from `device_types` table

### Summary
Drop the `include_in_standard_home` column from the `device_types` table. This column is redundant since the same flag now lives on `device_instances`, which is where the code actually reads/writes it.

### Risk Assessment
- No frontend code references `device_types.include_in_standard_home` -- the feature is fully driven by the `device_instances` column
- The `device_types` query uses `SELECT *`, but the result is not checked for this field anywhere in the UI

### Steps

1. **Run a database migration** to drop the column:
   ```sql
   ALTER TABLE public.device_types DROP COLUMN include_in_standard_home;
   ```

2. **Types file** will auto-update after the migration, removing the field from the `device_types` Row/Insert/Update types.

No code changes are needed -- nothing references this column on `device_types`.

