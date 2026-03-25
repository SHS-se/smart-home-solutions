import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: Record<string, unknown>) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[DUMP-DB] ${step}${d}`);
};

/** Serialize a single JS value to a safe SQL literal */
function sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  // Date objects (returned by postgres.js for timestamp/timestamptz columns)
  if (val instanceof Date) return `'${val.toISOString().replace("T", " ").replace("Z", "+00")}'`;
  // Arrays (returned by postgres.js for array columns like text[], uuid[])
  if (Array.isArray(val)) {
    const items = val.map((item) => {
      if (item === null || item === undefined) return "NULL";
      if (typeof item === "boolean") return item ? "true" : "false";
      if (typeof item === "number") return String(item);
      if (item instanceof Date) return `'${item.toISOString().replace("T", " ").replace("Z", "+00")}'`;
      return `'${String(item).replace(/'/g, "''")}'`;
    });
    return `ARRAY[${items.join(", ")}]`;
  }
  // JSONB / JSON objects
  if (typeof val === "object") {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  }
  // Strings (including UUID, numeric-as-string, etc.)
  return `'${String(val).replace(/'/g, "''")}'`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    log("Started");

    // Auth: must be staff
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Unauthorized");

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) throw new Error("Unauthorized");

    const { data: staffRow } = await anonClient
      .from("staff_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!staffRow) throw new Error("Forbidden: staff only");

    log("Auth OK", { userId: user.id });

    // Connect to DB
    const dbUrl = Deno.env.get("SUPABASE_DB_URL")!;
    const { default: postgres } = await import("https://deno.land/x/postgresjs@v3.4.5/mod.js");
    const sql = postgres(dbUrl, { ssl: "prefer" });

    try {
      const lines: string[] = [];
      const now = new Date().toISOString();
      lines.push(`-- Database backup generated at ${now}`);
      lines.push(`-- Schema: public`);
      lines.push(``);
      lines.push(`SET client_encoding = 'UTF8';`);
      lines.push(`SET standard_conforming_strings = on;`);
      lines.push(`SET search_path = public, pg_catalog;`);
      lines.push(`SET check_function_bodies = false;`);
      lines.push(`SET client_min_messages = warning;`);
      lines.push(``);
      lines.push(`BEGIN;`);
      lines.push(``);

      // 1. Get all tables
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
      const tableNames = tables.map((t: any) => t.table_name);
      log("Tables found", { count: tableNames.length });

      // 2. Get columns for each table
      const allCols = await sql`
        SELECT table_name, column_name, data_type, udt_name,
               is_nullable, column_default, ordinal_position, is_identity, identity_generation
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `;

      // 3. Get primary keys
      const pks = await sql`
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      `;
      const pkMap: Record<string, string[]> = {};
      for (const pk of pks) {
        if (!pkMap[pk.table_name]) pkMap[pk.table_name] = [];
        pkMap[pk.table_name].push(pk.column_name);
      }

      // 4. Get custom sequences (not the auto-generated ones for identity columns)
      const sequences = await sql`
        SELECT sequencename, last_value, start_value, increment_by, max_value, min_value, cycle
        FROM pg_sequences
        WHERE schemaname = 'public'
      `;
      log("Sequences found", { count: sequences.length });

      // 5. Emit custom sequence DDL
      if (sequences.length > 0) {
        lines.push(`-- Sequences`);
        for (const seq of sequences) {
          lines.push(`CREATE SEQUENCE IF NOT EXISTS public.${seq.sequencename}`);
          lines.push(`    START WITH ${seq.start_value}`);
          lines.push(`    INCREMENT BY ${seq.increment_by}`);
          lines.push(`    MINVALUE ${seq.min_value}`);
          lines.push(`    MAXVALUE ${seq.max_value}`);
          lines.push(`    ${seq.cycle ? "CYCLE" : "NO CYCLE"};`);
        }
        lines.push(``);
      }

      // 6. Emit CREATE TABLE statements
      const colsByTable: Record<string, any[]> = {};
      for (const col of allCols) {
        if (!colsByTable[col.table_name]) colsByTable[col.table_name] = [];
        colsByTable[col.table_name].push(col);
      }

      for (const tableName of tableNames) {
        const cols = colsByTable[tableName] || [];
        lines.push(`-- Table: ${tableName}`);
        lines.push(`CREATE TABLE IF NOT EXISTS public.${tableName} (`);
        const colDefs: string[] = [];
        for (const col of cols) {
          let colType = col.udt_name;
          // Map array types (udt_name starts with _ for arrays)
          if (colType.startsWith("_")) colType = colType.slice(1) + "[]";
          // Map common internal type names to standard SQL names
          const typeMap: Record<string, string> = {
            int4: "integer",
            int8: "bigint",
            int2: "smallint",
            float4: "real",
            float8: "double precision",
            bool: "boolean",
            timestamptz: "timestamptz",
            varchar: "character varying",
            bpchar: "character",
          };
          colType = typeMap[colType] || colType;

          let def = `  ${col.column_name} ${colType}`;
          // Identity columns use GENERATED ... AS IDENTITY rather than a DEFAULT
          if (col.is_identity === "YES") {
            if (col.identity_generation === "ALWAYS") {
              def += ` GENERATED ALWAYS AS IDENTITY`;
            } else {
              def += ` GENERATED BY DEFAULT AS IDENTITY`;
            }
          } else if (col.column_default) {
            def += ` DEFAULT ${col.column_default}`;
          }
          if (col.is_nullable === "NO") def += " NOT NULL";
          colDefs.push(def);
        }
        // Add PK constraint
        if (pkMap[tableName]) {
          colDefs.push(`  PRIMARY KEY (${pkMap[tableName].join(", ")})`);
        }
        lines.push(colDefs.join(",\n"));
        lines.push(`);\n`);
      }

      // 7. Get foreign keys — emitted AFTER data (see step 10)
      const fks = await sql`
        SELECT tc.constraint_name,
               kcu.table_name, kcu.column_name,
               ccu.table_name AS ref_table, ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      `;

      // 8. Dump data for each table
      for (const tableName of tableNames) {
        log("Dumping data", { table: tableName });
        const rows = await sql`SELECT * FROM ${sql(tableName)}`;
        if (rows.length === 0) {
          lines.push(`-- ${tableName}: 0 rows\n`);
          continue;
        }

        const cols = Object.keys(rows[0]);
        lines.push(`-- ${tableName}: ${rows.length} rows`);

        for (const row of rows) {
          const values = cols.map((col) => sqlLiteral(row[col]));
          lines.push(`INSERT INTO public.${tableName} (${cols.join(", ")}) VALUES (${values.join(", ")});`);
        }
        lines.push("");
      }

      // 9. Emit foreign key constraints now that all data is loaded
      if (fks.length > 0) {
        lines.push(`-- Foreign keys`);
        const seen = new Set<string>();
        for (const fk of fks) {
          if (seen.has(fk.constraint_name)) continue;
          seen.add(fk.constraint_name);
          lines.push(`ALTER TABLE public.${fk.table_name} ADD CONSTRAINT ${fk.constraint_name} FOREIGN KEY (${fk.column_name}) REFERENCES public.${fk.ref_table}(${fk.ref_column});`);
        }
        lines.push("");
      }

      // 10. Reset sequence values so they continue past the highest inserted ID
      if (sequences.length > 0) {
        lines.push(`-- Reset sequences to current values`);
        for (const seq of sequences) {
          const currentVal = seq.last_value ?? seq.start_value;
          lines.push(`SELECT setval('public.${seq.sequencename}', ${currentVal}, true);`);
        }
        lines.push(``);
      }

      lines.push(`COMMIT;`);

      await sql.end();
      log("Dump complete", { totalLines: lines.length });

      const body = lines.join("\n");
      const fileName = `backup-${now.slice(0, 10)}.sql`;

      return new Response(body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/sql",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    } catch (err) {
      await sql.end();
      throw err;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: msg.includes("Unauthorized") ? 401 : msg.includes("Forbidden") ? 403 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
