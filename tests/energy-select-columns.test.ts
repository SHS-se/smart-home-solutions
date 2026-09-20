import { assertEquals } from 'jsr:@std/assert@1';

/**
 * Every column an edge function names against an `energy_optimisation_*` table
 * must exist in the migrations that build it.
 *
 * PostgREST resolves column names at PARSE time in Postgres, so a typo is not a
 * compile error and not a runtime exception either: the call returns
 * `{ data: null, error }`, and code that destructures only `data` reads it as an
 * empty table. `refitPoolModel` did exactly that for two columns
 * (`outdoor_temperature_c` for `temperature_c`, and `device_key` on the slots
 * table rather than on its parent), so every pool fit since the feature shipped
 * trained on zero samples and recorded `insufficient_samples` — a rejection
 * indistinguishable from the honest Swedish-summer one it was designed to give.
 *
 * Nothing else catches this. The generated Supabase types cover the website's
 * client, not the edge functions, which take an untyped `any` client precisely
 * so they can run against the service role.
 */

const COLUMN_TYPES =
  'uuid|text|numeric|timestamptz|jsonb|boolean|integer|int|bigint|date|smallint|double precision|real';
/** Chain members whose first argument is a column name. */
const FILTERS = 'eq|neq|gt|gte|lt|lte|in|is|like|ilike|order|not';

async function readAll(dir: string, suffix: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) out.push(...await readAll(path, suffix));
    else if (entry.name.endsWith(suffix)) out.push([path, await Deno.readTextFile(path)]);
  }
  return out;
}

/** Table to its columns, replayed in migration order so later DDL wins. */
async function schemaFromMigrations(): Promise<Map<string, Set<string>>> {
  const tables = new Map<string, Set<string>>();
  const migrations = (await readAll('supabase/migrations', '.sql')).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [, sql] of migrations) {
    for (const [, table, body] of sql.matchAll(
      /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?public\.(energy_optimisation_[a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const columns = new Set<string>();
      for (const line of body.split('\n')) {
        const declaration = line.trim();
        if (/^(CONSTRAINT|UNIQUE|PRIMARY|FOREIGN|CHECK)\b/i.test(declaration)) continue;
        const match = declaration.match(new RegExp(`^([a-z0-9_]+)\\s+(?:${COLUMN_TYPES})\\b`));
        if (match) columns.add(match[1]);
      }
      tables.set(table, columns);
    }
    // One ALTER may carry several actions (`ADD COLUMN a …, ADD COLUMN b …`),
    // so the statement is isolated first and its actions read from within it.
    for (const statement of sql.matchAll(
      /ALTER TABLE\s+(?:IF EXISTS\s+)?public\.(energy_optimisation_[a-z0-9_]+)([\s\S]*?);/gi,
    )) {
      const columns = tables.get(statement[1]);
      if (!columns) continue;
      const body = statement[2];
      for (const [, column] of body.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z0-9_]+)/gi)) {
        columns.add(column);
      }
      for (const [, column] of body.matchAll(/DROP COLUMN\s+(?:IF EXISTS\s+)?([a-z0-9_]+)/gi)) {
        columns.delete(column);
      }
      for (const [, from, to] of body.matchAll(/RENAME COLUMN\s+([a-z0-9_]+)\s+TO\s+([a-z0-9_]+)/gi)) {
        if (columns.delete(from)) columns.add(to);
      }
    }
  }
  return tables;
}

Deno.test('edge functions only name columns the migrations define', async () => {
  const tables = await schemaFromMigrations();
  const unknown: string[] = [];
  let checked = 0;

  for (const [path, source] of await readAll('supabase/functions', '.ts')) {
    if (path.endsWith('.test.ts')) continue;
    for (const match of source.matchAll(/\.from\(\s*"(energy_optimisation_[a-z0-9_]+)"\s*\)/g)) {
      const table = match[1];
      const columns = tables.get(table);
      if (!columns) continue; // Built outside the migrations scanned here.
      // A chain runs to the end of its statement, or to the next `.from(` when
      // several are built side by side inside one `Promise.all`.
      const rest = source.slice(match.index! + match[0].length);
      const stop = Math.min(
        ...[rest.indexOf('.from('), rest.indexOf(';')].filter((at) => at >= 0),
        rest.length,
      );
      const chain = rest.slice(0, stop);

      const named: string[] = [];
      const select = chain.match(/\.select\(\s*"([^"]*)"/);
      if (select) named.push(...select[1].split(',').map((column) => column.trim()));
      for (const filter of chain.matchAll(new RegExp(`\\.(?:${FILTERS})\\(\\s*"([^"]*)"`, 'g'))) {
        named.push(filter[1]);
      }

      for (const column of named) {
        if (column === '' || column === '*') continue;
        checked += 1;
        if (!columns.has(column)) {
          unknown.push(`${path.replace('supabase/functions/', '')}: ${table}.${column}`);
        }
      }
    }
  }

  // A guard that silently matches nothing is worse than no guard.
  assertEquals(checked > 40, true, `only ${checked} columns checked; the scan stopped matching`);
  assertEquals(unknown, [], `columns named in edge functions that no migration defines:\n${unknown.join('\n')}`);
});
