import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: Record<string, unknown>) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[DUMP-DB] ${step}${d}`);
};

/**
 * Encrypt plaintext with AES-256-GCM + PBKDF2-SHA256 key derivation.
 * Wire format: [16-byte salt][12-byte IV][ciphertext + 16-byte GCM tag]
 * Compatible with the Python decrypt.py helper in scripts/.
 */
async function encryptData(plaintext: string, passphrase: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));

  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));

  const out = new Uint8Array(16 + 12 + ciphertext.byteLength);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(new Uint8Array(ciphertext), 28);
  return out;
}

// Secrets exported from edge function env — ENCRYPTION_KEY itself is always excluded.
// SUPABASE_* keys are auto-provisioned by the new project and never exported.
const EXPORTED_SECRET_NAMES = [
  "RESEND_API_KEY",
  "RESEND_RECEIVING_API_KEY",
  "RESEND_SIGNING_SECRET",
  "CONTACT_TO",
  "SUPPORT_TO",
  "APP_ENV",
  "APP_ORIGIN_ALLOWLIST",
];

/** Serialize a single JS value to a safe SQL literal for non-JSONB columns */
function sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return `'${val.toISOString().replace("T", " ").replace("Z", "+00")}'`;
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
  if (typeof val === "object") {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

function sqlJsonbLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  const json = val instanceof Date
    ? JSON.stringify(val.toISOString())
    : JSON.stringify(val);
  return `'${json.replace(/'/g, "''")}'::jsonb`;
}

/** Generate the SQL dump string */
async function generateSqlDump(sql: any): Promise<string> {
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

  // 4. Get custom sequences
  const sequences = await sql`
    SELECT sequencename, last_value, start_value, increment_by, max_value, min_value, cycle
    FROM pg_sequences
    WHERE schemaname = 'public'
  `;

  // 5. Emit sequence DDL
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
      if (colType.startsWith("_")) colType = colType.slice(1) + "[]";
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
    if (pkMap[tableName]) {
      colDefs.push(`  PRIMARY KEY (${pkMap[tableName].join(", ")})`);
    }
    lines.push(colDefs.join(",\n"));
    lines.push(`);\n`);
  }

  // 7. Get foreign keys
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

  // 7b. Get UNIQUE constraints (constraint-based, not index-based)
  const uniqueConstraints = await sql`
    SELECT tc.constraint_name, tc.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
  `;

  // 7c. Get UNIQUE indexes created directly (CREATE UNIQUE INDEX style)
  const uniqueIndexes = await sql`
    SELECT indexname, tablename, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    ORDER BY tablename, indexname
  `;

  // 8. Dump data
  for (const tableName of tableNames) {
    log("Dumping data", { table: tableName });
    const rows = await sql`SELECT * FROM ${sql(tableName)}`;
    if (rows.length === 0) {
      lines.push(`-- ${tableName}: 0 rows\n`);
      continue;
    }

    const cols = Object.keys(rows[0]);
    const jsonbCols = new Set(
      (colsByTable[tableName] || [])
        .filter((c: any) => c.udt_name === "jsonb" || c.udt_name === "json")
        .map((c: any) => c.column_name)
    );
    lines.push(`-- ${tableName}: ${rows.length} rows`);

    for (const row of rows) {
      const values = cols.map((col) =>
        jsonbCols.has(col) ? sqlJsonbLiteral(row[col]) : sqlLiteral(row[col])
      );
      lines.push(`INSERT INTO public.${tableName} (${cols.join(", ")}) VALUES (${values.join(", ")});`);
    }
    lines.push("");
  }

  // 9. Foreign key constraints
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

  // 9b. UNIQUE constraints
  if (uniqueConstraints.length > 0) {
    lines.push(`-- Unique constraints`);
    const ucMap: Record<string, { table: string; cols: string[] }> = {};
    for (const uc of uniqueConstraints) {
      if (!ucMap[uc.constraint_name]) ucMap[uc.constraint_name] = { table: uc.table_name, cols: [] };
      ucMap[uc.constraint_name].cols.push(uc.column_name);
    }
    for (const [name, { table, cols }] of Object.entries(ucMap)) {
      lines.push(`ALTER TABLE public.${table} ADD CONSTRAINT ${name} UNIQUE (${cols.join(", ")});`);
    }
    lines.push("");
  }

  // 9c. UNIQUE indexes (CREATE UNIQUE INDEX style)
  if (uniqueIndexes.length > 0) {
    lines.push(`-- Unique indexes`);
    for (const idx of uniqueIndexes) {
      lines.push(`${idx.indexdef};`);
    }
    lines.push("");
  }

  // 10. Reset sequences
  if (sequences.length > 0) {
    lines.push(`-- Reset sequences to current values`);
    for (const seq of sequences) {
      const currentVal = seq.last_value ?? seq.start_value;
      lines.push(`SELECT setval('public.${seq.sequencename}', ${currentVal}, true);`);
    }
    lines.push(``);
  }

  lines.push(`COMMIT;`);
  return lines.join("\n");
}

/** Download all files from all storage buckets and add to ZIP */
async function addStorageToZip(zip: JSZip, serviceClient: any): Promise<{ bucketCount: number; fileCount: number }> {
  const { data: buckets, error: bucketsErr } = await serviceClient.storage.listBuckets();
  if (bucketsErr) {
    log("Error listing buckets", { error: bucketsErr.message });
    return { bucketCount: 0, fileCount: 0 };
  }

  let totalFiles = 0;
  const storageFolder = zip.folder("storage")!;

  // Also create a manifest of bucket metadata
  const manifest: Array<{ bucket: string; isPublic: boolean; files: string[] }> = [];

  for (const bucket of buckets) {
    log("Processing bucket", { name: bucket.name, public: bucket.public });
    const bucketFolder = storageFolder.folder(bucket.name)!;
    const bucketFiles: string[] = [];

    // Recursively list all files in the bucket
    const listAll = async (prefix: string): Promise<void> => {
      const { data: items, error: listErr } = await serviceClient.storage
        .from(bucket.name)
        .list(prefix || "", { limit: 1000 });

      if (listErr) {
        log("Error listing bucket contents", { bucket: bucket.name, prefix, error: listErr.message });
        return;
      }

      if (!items || items.length === 0) return;

      for (const item of items) {
        const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

        if (item.id === null) {
          // It's a folder, recurse
          await listAll(fullPath);
        } else {
          // It's a file, download it
          try {
            const { data: fileData, error: dlErr } = await serviceClient.storage
              .from(bucket.name)
              .download(fullPath);

            if (dlErr) {
              log("Error downloading file", { bucket: bucket.name, path: fullPath, error: dlErr.message });
              continue;
            }

            if (fileData) {
              const arrayBuf = await fileData.arrayBuffer();
              bucketFolder.file(fullPath, arrayBuf);
              bucketFiles.push(fullPath);
              totalFiles++;
              if (totalFiles % 25 === 0) {
                log("Storage download progress", { filesDownloaded: totalFiles });
              }
            }
          } catch (e) {
            log("Error downloading file", { bucket: bucket.name, path: fullPath, error: String(e) });
          }
        }
      }
    };

    await listAll("");
    manifest.push({ bucket: bucket.name, isPublic: bucket.public ?? false, files: bucketFiles });
    log("Bucket complete", { name: bucket.name, files: bucketFiles.length });
  }

  // Add manifest JSON
  storageFolder.file("_manifest.json", JSON.stringify(manifest, null, 2));

  return { bucketCount: buckets.length, fileCount: totalFiles };
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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

    // Service-role client for storage access (bypasses RLS/bucket privacy)
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Connect to DB
    const dbUrl = Deno.env.get("SUPABASE_DB_URL")!;
    const { default: postgres } = await import("https://deno.land/x/postgresjs@v3.4.5/mod.js");
    const sql = postgres(dbUrl, { ssl: "prefer" });

    try {
      // Generate SQL dump
      const sqlDump = await generateSqlDump(sql);
      await sql.end();
      log("SQL dump complete");

      // Create ZIP
      const zip = new JSZip();
      const now = new Date().toISOString();
      const dateSlug = now.slice(0, 10);

      // Add SQL dump to ZIP
      zip.file(`backup-${dateSlug}.sql`, sqlDump);

      // Add storage files to ZIP
      const storageStats = await addStorageToZip(zip, serviceClient);
      log("Storage export complete", storageStats);

      // Export auth users with encrypted_password via direct SQL
      const dbUrl2 = Deno.env.get("SUPABASE_DB_URL")!;
      const { default: postgres2 } = await import("https://deno.land/x/postgresjs@v3.4.5/mod.js");
      const sql2 = postgres2(dbUrl2, { ssl: "prefer" });
      let allUsers: any[] = [];
      try {
        allUsers = await sql2`
          SELECT id, email, encrypted_password, email_confirmed_at, phone,
                 confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data,
                 created_at, updated_at, is_anonymous
          FROM auth.users
          ORDER BY created_at
        `;
        log("Auth users exported", { count: allUsers.length });
      } catch (e) {
        log("Error exporting auth users", { error: String(e) });
      } finally {
        await sql2.end();
      }

      // Encrypt auth users + secrets if ENCRYPTION_KEY is set.
      // ENCRYPTION_KEY itself is never included in the export.
      const encryptionKey = Deno.env.get("ENCRYPTION_KEY");

      if (encryptionKey && allUsers.length > 0) {
        const encryptedAuth = await encryptData(JSON.stringify(allUsers, null, 2), encryptionKey);
        zip.file("auth_users.enc", encryptedAuth);
        log("Auth users encrypted → auth_users.enc");
      } else {
        zip.file("auth_users.json", JSON.stringify(allUsers, null, 2));
        log(encryptionKey ? "Auth users unencrypted (no users)" : "Auth users unencrypted — set ENCRYPTION_KEY secret to encrypt");
      }

      // Collect and encrypt user-managed secrets
      const secrets: Record<string, string> = {};
      for (const name of EXPORTED_SECRET_NAMES) {
        const val = Deno.env.get(name);
        if (val !== undefined && val !== "") secrets[name] = val;
      }
      log("Secrets collected", { count: Object.keys(secrets).length, names: Object.keys(secrets) });

      if (encryptionKey && Object.keys(secrets).length > 0) {
        const encryptedSecrets = await encryptData(JSON.stringify(secrets), encryptionKey);
        zip.file("secrets.enc", encryptedSecrets);
        log("Secrets encrypted → secrets.enc");
      } else if (!encryptionKey) {
        log("ENCRYPTION_KEY not set — secrets not exported. Add ENCRYPTION_KEY as a Supabase secret to enable.");
      }

      // Generate ZIP
      const zipBlob = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
      log("ZIP generated", { sizeBytes: zipBlob.length });

      const fileName = `backup-${dateSlug}.zip`;

      return new Response(zipBlob, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/zip",
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
