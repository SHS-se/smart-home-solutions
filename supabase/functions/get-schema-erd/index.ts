import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    // Verify caller is staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: staffRow } = await anonClient
      .from("staff_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!staffRow) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse direction from body
    let direction = "TB";
    try {
      const body = await req.json();
      if (body?.direction === "LR") direction = "LR";
    } catch { /* no body or invalid JSON, use default */ }

    const dbUrl = Deno.env.get("SUPABASE_DB_URL")!;
    return await generateFromDirectSQL(dbUrl, direction, corsHeaders);
  } catch (err: any) {
    console.error("ERD generation error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function generateFromDirectSQL(
  dbUrl: string,
  direction: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Dynamic import of postgres
  const { default: postgres } = await import("https://deno.land/x/postgresjs@v3.4.5/mod.js");
  const sql = postgres(dbUrl, { ssl: "prefer" });

  try {
    // Get all tables in public schema
    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    // Get all columns
    const cols = await sql`
      SELECT table_name, column_name, data_type, udt_name,
             is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `;

    // Get primary keys
    const pks = await sql`
      SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
    `;

    // Get unique constraints
    const uqs = await sql`
      SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'UNIQUE'
        AND tc.table_schema = 'public'
    `;

    // Get foreign keys
    const fks = await sql`
      SELECT
        kcu.table_name AS from_table,
        kcu.column_name AS from_column,
        ccu.table_name AS to_table,
        ccu.column_name AS to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `;

    // Get views
    const views = await sql`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
    `;

    const viewNames = new Set(views.map((v: any) => v.table_name));
    const pkSet = new Set(pks.map((p: any) => `${p.table_name}.${p.column_name}`));
    const uqSet = new Set(uqs.map((u: any) => `${u.table_name}.${u.column_name}`));
    const fkSet = new Set(fks.map((f: any) => `${f.from_table}.${f.from_column}`));
    const tableNames = new Set(tables.map((t: any) => t.table_name));

    // Build Mermaid ERD
    let erd = `erDiagram\n    direction ${direction}\n`;

    // Group columns by table
    const tableColumns: Record<string, any[]> = {};
    for (const col of cols) {
      if (!tableNames.has(col.table_name)) continue;
      if (!tableColumns[col.table_name]) tableColumns[col.table_name] = [];
      tableColumns[col.table_name].push(col);
    }

    // Map postgres types to simpler display types
    function mapType(udtName: string, dataType: string): string {
      const typeMap: Record<string, string> = {
        uuid: "uuid",
        text: "text",
        varchar: "varchar",
        int4: "int",
        int8: "bigint",
        float8: "float",
        numeric: "numeric",
        bool: "boolean",
        timestamptz: "timestamptz",
        timestamp: "timestamp",
        date: "date",
        jsonb: "jsonb",
        json: "json",
        _text: "text[]",
        _uuid: "uuid[]",
        _int4: "int[]",
        _jsonb: "jsonb[]",
      };
      return typeMap[udtName] || dataType;
    }

    // Emit table definitions
    for (const tableName of Array.from(tableNames).sort()) {
      const tableCols = tableColumns[tableName] || [];
      erd += `\n    ${tableName} {\n`;
      for (const col of tableCols) {
        const type = mapType(col.udt_name, col.data_type);
        const isPk = pkSet.has(`${tableName}.${col.column_name}`);
        const isUq = uqSet.has(`${tableName}.${col.column_name}`);
        const isFk = fkSet.has(`${tableName}.${col.column_name}`);

        let markers = "";
        if (isPk) markers += "PK";
        if (isFk) markers += (markers ? "," : "") + "FK";
        if (isUq && !isPk) markers += (markers ? "," : "") + "UK";

        const nullable = col.is_nullable === "YES" && !isPk ? '"nullable"' : "";

        erd += `        ${type} ${col.column_name}`;
        if (markers) erd += ` ${markers}`;
        if (nullable && !markers) erd += ` ${nullable}`;
        erd += `\n`;
      }
      erd += `    }\n`;
    }

    // Emit view placeholders (as entities with a comment)
    for (const vName of Array.from(viewNames).sort()) {
      // Only include views that have columns in public schema
      const viewCols = cols.filter((c: any) => c.table_name === vName);
      if (viewCols.length > 0) {
        erd += `\n    ${vName} {\n`;
        for (const col of viewCols) {
          const type = mapType(col.udt_name, col.data_type);
          erd += `        ${type} ${col.column_name} "view"\n`;
        }
        erd += `    }\n`;
      }
    }

    // Emit relationships from foreign keys
    // Only emit relationships where both tables exist
    erd += `\n`;
    const seenRelationships = new Set<string>();
    for (const fk of fks) {
      if (!tableNames.has(fk.from_table) && !viewNames.has(fk.from_table)) continue;
      if (!tableNames.has(fk.to_table) && !viewNames.has(fk.to_table)) continue;

      const relKey = `${fk.from_table}-${fk.to_table}-${fk.from_column}`;
      if (seenRelationships.has(relKey)) continue;
      seenRelationships.add(relKey);

      erd += `    ${fk.to_table} ||--o{ ${fk.from_table} : "${fk.from_column}"\n`;
    }

    await sql.end();

    return new Response(JSON.stringify({ erd }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    await sql.end();
    throw err;
  }
}
