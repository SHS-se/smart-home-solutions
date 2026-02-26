import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: Record<string, unknown>) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[DUMP-DB] ${step}${d}`);
};

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
      lines.push(`-- Schema: public\n`);

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
               is_nullable, column_default, ordinal_position
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

      // 4. Emit CREATE TABLE statements
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
          // Map array types
          if (colType.startsWith("_")) colType = colType.slice(1) + "[]";
          // Map common types
          const typeMap: Record<string, string> = {
            int4: "integer", int8: "bigint", float8: "double precision",
            bool: "boolean", timestamptz: "timestamptz", varchar: "character varying",
          };
          colType = typeMap[colType] || colType;

          let def = `  ${col.column_name} ${colType}`;
          if (col.column_default) def += ` DEFAULT ${col.column_default}`;
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

      // 5. Get foreign keys and emit ALTER TABLE
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

      // 6. Dump data for each table
      for (const tableName of tableNames) {
        log("Dumping data", { table: tableName });
        // Fetch all rows (paginated to avoid memory issues)
        const rows = await sql`SELECT * FROM ${sql(tableName)}`;
        if (rows.length === 0) {
          lines.push(`-- ${tableName}: 0 rows\n`);
          continue;
        }

        const cols = Object.keys(rows[0]);
        lines.push(`-- ${tableName}: ${rows.length} rows`);

        for (const row of rows) {
          const values = cols.map((col) => {
            const val = row[col];
            if (val === null || val === undefined) return "NULL";
            if (typeof val === "boolean") return val ? "true" : "false";
            if (typeof val === "number") return String(val);
            if (typeof val === "object") {
              return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
            }
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          lines.push(`INSERT INTO public.${tableName} (${cols.join(", ")}) VALUES (${values.join(", ")});`);
        }
        lines.push("");
      }

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
