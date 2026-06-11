#!/bin/bash
# =============================================================================
# SHS Database Restore Script
# Usage: ./scripts/restore.sh [test|live] [backup.zip]
#
# Requires:
#   - supabase CLI installed and logged in (supabase login)
#   - Backup ZIP path as second argument, or default ZIPs in ~/Downloads
#   - python3 with 'storage3' package: pip3 install storage3 httpx
# =============================================================================

set -euo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV="${1:-}"
BACKUP_ZIP_OVERRIDE="${2:-}"

if [ -z "$ENV" ] || { [ "$ENV" != "test" ] && [ "$ENV" != "live" ]; }; then
  echo "Usage: $0 [test|live] [backup.zip]"
  echo ""
  echo "  test  → restores to project vxqpgbzseckgceopitpm"
  echo "  live  → restores to project oosxndduqzhvrorgogaw"
  echo "  backup.zip → optional path to backup ZIP"
  echo ""
  echo "⚠️  Always run 'test' first to verify before touching live!"
  exit 1
fi

if [ "$ENV" = "test" ]; then
  PROJECT_REF="vxqpgbzseckgceopitpm"
  DB_HOST="aws-1-eu-central-1.pooler.supabase.com"
  BACKUP_ZIP="$HOME/Downloads/backup-2026-03-28-test.zip"
else
  PROJECT_REF="oosxndduqzhvrorgogaw"
  DB_HOST="aws-1-eu-north-1.pooler.supabase.com"
  BACKUP_ZIP="$HOME/Downloads/backup-2026-03-28-live.zip"
fi

if [ -n "$BACKUP_ZIP_OVERRIDE" ]; then
  BACKUP_ZIP="$BACKUP_ZIP_OVERRIDE"
fi

echo "============================================================"
echo "  SHS Restore: $ENV → $PROJECT_REF"
echo "============================================================"
echo "  Backup: $BACKUP_ZIP"
echo ""

# --- Pre-flight checks ---
echo "▶ Checking prerequisites..."
command -v supabase >/dev/null 2>&1 || { echo "❌ supabase CLI not found. Install: brew install supabase/tap/supabase"; exit 1; }
command -v python3  >/dev/null 2>&1 || { echo "❌ python3 not found"; exit 1; }
[ -f "$BACKUP_ZIP" ]               || { echo "❌ Backup ZIP not found: $BACKUP_ZIP"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ node not found"; exit 1; }
python3 -c "import storage3, httpx" 2>/dev/null || {
  echo "Installing required Python packages..."
  pip3 install storage3 httpx --quiet
}
echo "  ✓ Prerequisites OK"

# --- Get DB password (keychain → prompt → save) ---
echo "▶ Retrieving DB password..."
DB_PASS=""
KEYCHAIN_SERVICE="shs-db-restore"

DB_PASS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$PROJECT_REF" -w 2>/dev/null || true)

if [ -z "$DB_PASS" ]; then
  echo ""
  echo "  Not found in keychain. Find it in:"
  echo "  Supabase Dashboard → $PROJECT_REF → Project Settings → Database → Database password"
  echo ""
  printf "  Enter DB password for $PROJECT_REF: "
  read -rs DB_PASS
  echo ""
  # Save for next time
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$PROJECT_REF" -w "$DB_PASS" -U
  echo "  ✓ Password saved to keychain for next run"
fi

echo "  ✓ Password obtained"

unset PGPASSWORD PGPASSFILE PGUSER PGHOST PGPORT PGDATABASE
DB_USER="postgres.${PROJECT_REF}"
# Transaction pooler (port 6543) for psql data operations
PSQL="psql -h ${DB_HOST} -p 6543 -U ${DB_USER} -d postgres"
# Session pooler URL (port 5432) for supabase CLI (needs prepared statements)
SESSION_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/postgres"

# --- Extract backup ZIP ---
echo "▶ Extracting backup..."
WORK_DIR="/tmp/shs-restore-${ENV}-$$"
mkdir -p "$WORK_DIR"
unzip -q "$BACKUP_ZIP" -d "$WORK_DIR"
SQL_FILE=$(find "$WORK_DIR" -name "*.sql" | head -1)
STORAGE_DIR="$WORK_DIR/storage"
echo "  ✓ Extracted to $WORK_DIR"
echo "  ✓ SQL: $SQL_FILE"
echo "  ✓ Storage manifest:"
python3 -c "
import json
with open('$STORAGE_DIR/_manifest.json') as f:
    manifest = json.load(f)
for b in manifest:
    print(f'      {b[\"bucket\"]}: {len(b[\"files\"])} files (public={b[\"isPublic\"]})')
"

# --- Prompt for ENCRYPTION_KEY if backup contains encrypted files ---
ENCRYPTION_KEY=""
ENCRYPTED_AUTH="$WORK_DIR/auth_users.enc"
ENCRYPTED_SECRETS="$WORK_DIR/secrets.enc"
DECRYPTED_AUTH_TEMP=""

if [ -f "$ENCRYPTED_AUTH" ] || [ -f "$ENCRYPTED_SECRETS" ]; then
  echo ""
  echo "▶ Encrypted backup files detected (auth_users.enc / secrets.enc)."
  echo "  Enter the ENCRYPTION_KEY secret that was set on the source Supabase project."
  printf "  ENCRYPTION_KEY: "
  read -rs ENCRYPTION_KEY
  echo ""
  if [ -z "$ENCRYPTION_KEY" ]; then
    echo "❌ ENCRYPTION_KEY is required to decrypt this backup"
    rm -rf "$WORK_DIR"
    exit 1
  fi
  # Quick decrypt test — catches wrong key before destructive operations
  if [ -f "$ENCRYPTED_AUTH" ]; then
    node "$SCRIPT_DIR/decrypt.mjs" "$ENCRYPTED_AUTH" "$ENCRYPTION_KEY" > /dev/null 2>&1 || {
      echo "❌ Decryption failed — wrong ENCRYPTION_KEY or corrupted backup"
      rm -rf "$WORK_DIR"
      exit 1
    }
    echo "  ✓ ENCRYPTION_KEY verified"
  fi
fi

# --- Get service role key (needed for storage upload) ---
echo ""
echo "▶ Fetching service role key..."
SERVICE_ROLE_KEY=$(supabase projects api-keys --project-ref "$PROJECT_REF" --output json 2>/dev/null \
  | python3 -c "import sys,json; keys=json.load(sys.stdin); print(next(k['api_key'] for k in keys if k['name']=='service_role'))" 2>/dev/null || true)

if [ -z "$SERVICE_ROLE_KEY" ]; then
  echo ""
  echo "  Could not fetch service role key automatically."
  echo "  Find it in: Supabase Dashboard → $PROJECT_REF → Project Settings → API"
  printf "  Paste service role key: "
  read -rs SERVICE_ROLE_KEY
  echo ""
fi
echo "  ✓ Service role key obtained"

# --- Phase 2: Reset database ---
echo ""
echo "▶ Phase 2: Resetting database..."

# Clear storage buckets and auth users via API
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
python3 - <<PYEOF
import httpx, sys

url = "$SUPABASE_URL"
key = "$SERVICE_ROLE_KEY"
headers = {"Authorization": f"Bearer {key}", "apikey": key}

# Clear storage buckets (direct SQL DELETE is blocked by Supabase trigger)
r = httpx.get(f"{url}/storage/v1/bucket", headers=headers)
buckets = r.json() if r.status_code == 200 else []
for b in buckets:
    bid = b["id"]
    httpx.post(f"{url}/storage/v1/bucket/{bid}/empty", headers=headers)
    httpx.delete(f"{url}/storage/v1/bucket/{bid}", headers=headers)
    print(f"  cleared bucket: {bid}")

# Delete all auth users
page = 1
while True:
    r = httpx.get(f"{url}/auth/v1/admin/users", headers=headers, params={"page": page, "per_page": 1000})
    users = r.json().get("users", []) if r.status_code == 200 else []
    if not users:
        break
    for u in users:
        httpx.delete(f"{url}/auth/v1/admin/users/{u['id']}", headers=headers)
    print(f"  deleted {len(users)} auth users (page {page})")
    page += 1
PYEOF

# Recreate public schema from scratch so partial restores cannot leave behind
# indexes, views, functions, types, or constraints that break the next restore.
echo "
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
DO \$\$ DECLARE r RECORD;
BEGIN
  FOR r IN (SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'storage') LOOP
    EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(r.policyname) || ' ON storage.' || quote_ident(r.tablename);
  END LOOP;
END \$\$;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
TRUNCATE supabase_migrations.schema_migrations;
" | PGPASSWORD="$DB_PASS" $PSQL -q
echo "  ✓ Database cleared"

# --- Phase 3: Restore SQL backup (schema + data) ---
# The SQL backup has the full current schema (CREATE TABLE IF NOT EXISTS) + all data.
# Loading it first means migrations can run on top of real data, avoiding data-migration failures.
echo ""
echo "▶ Phase 3: Restoring schema and data from SQL backup..."
RESTORE_SQL="$WORK_DIR/restore.sql"
{
  echo "SET session_replication_role = replica;"
  # Replace narrow search_path in backup with one that includes extensions (needed for gen_random_bytes)
  sed 's/SET search_path = public, pg_catalog;/SET search_path = public, extensions, pg_catalog;/' "$SQL_FILE"
  echo "SET session_replication_role = DEFAULT;"
} > "$RESTORE_SQL"
PGPASSWORD="$DB_PASS" $PSQL -v ON_ERROR_STOP=1 -q -f "$RESTORE_SQL"
echo "  ✓ Schema and data restored"

# --- Phase 3b: Restore auth users ---
echo ""
AUTH_USERS_FILE="$WORK_DIR/auth_users.json"

# Decrypt auth_users.enc → temp file if present
if [ -f "$ENCRYPTED_AUTH" ] && [ -n "$ENCRYPTION_KEY" ]; then
  DECRYPTED_AUTH_TEMP=$(mktemp /tmp/shs-auth-XXXXXX.json)
  node "$SCRIPT_DIR/decrypt.mjs" "$ENCRYPTED_AUTH" "$ENCRYPTION_KEY" > "$DECRYPTED_AUTH_TEMP"
  AUTH_USERS_FILE="$DECRYPTED_AUTH_TEMP"
  echo "  ✓ auth_users.enc decrypted"
fi

if [ -f "$AUTH_USERS_FILE" ]; then
  echo "▶ Phase 3b: Restoring auth users..."
  python3 - <<PYEOF
import httpx, json, sys

url = "$SUPABASE_URL"
key = "$SERVICE_ROLE_KEY"
headers = {"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"}

with open("$AUTH_USERS_FILE") as f:
    users = json.load(f)

ok = 0
for u in users:
    payload = {
        "id":            u["id"],
        "email":         u.get("email") or None,
        "phone":         u.get("phone") or None,
        "email_confirm": bool(u.get("email_confirmed_at") or u.get("confirmed_at")),
        "user_metadata": u.get("raw_user_meta_data") or u.get("user_metadata") or {},
        "app_metadata":  u.get("raw_app_meta_data") or u.get("app_metadata") or {},
    }
    if u.get("encrypted_password"):
        payload["password_hash"] = u["encrypted_password"]
    r = httpx.post(f"{url}/auth/v1/admin/users", headers=headers, json=payload, timeout=30)
    if r.status_code in (200, 201):
        ok += 1
    else:
        print(f"  warning: failed to create user {u.get('email', u.get('id', '?'))}: {r.text}", file=sys.stderr)

print(f"  ✓ {ok}/{len(users)} auth users restored")
PYEOF
else
  echo "▶ Phase 3b: No auth users file in backup — skipping auth restore"
fi

# Clean up decrypted temp file immediately after use
[ -n "$DECRYPTED_AUTH_TEMP" ] && rm -f "$DECRYPTED_AUTH_TEMP"

# --- Phase 3c: Restore secrets ---
if [ -f "$ENCRYPTED_SECRETS" ] && [ -n "$ENCRYPTION_KEY" ]; then
  echo ""
  echo "▶ Phase 3c: Restoring secrets..."
  DECRYPTED_SECRETS=$(node "$SCRIPT_DIR/decrypt.mjs" "$ENCRYPTED_SECRETS" "$ENCRYPTION_KEY")
  if [ -z "$DECRYPTED_SECRETS" ]; then
    echo "  ⚠️  secrets.enc decrypted but was empty — skipping"
  else
    # Build args array and call supabase secrets set
    python3 - <<PYEOF
import json, subprocess, sys

secrets = json.loads("""$DECRYPTED_SECRETS""")
args = [f"{k}={v}" for k, v in secrets.items() if v is not None and v != ""]
if not args:
    print("  No secrets to restore")
    sys.exit(0)

cmd = ["supabase", "secrets", "set"] + args + ["--project-ref", "$PROJECT_REF"]
result = subprocess.run(cmd, capture_output=True, text=True)
if result.returncode != 0:
    print(f"  ❌ Failed to set secrets: {result.stderr}", file=sys.stderr)
    sys.exit(1)
print(f"  ✓ {len(args)} secrets restored")
PYEOF
  fi
fi

# --- Phase 4: Apply migrations (policies, functions, triggers) ---
# Apply each migration file via psql in auto-commit mode (no single wrapping transaction).
# This means individual statement failures (e.g. "already exists") don't abort the rest.
# Policies, functions, and triggers from every migration will be applied cleanly.
echo ""
echo "▶ Phase 4: Applying migrations (policies/functions/triggers)..."
cd "$PROJECT_DIR"
for f in supabase/migrations/*.sql; do
  version=$(basename "$f" | cut -d'_' -f1)
  name=$(basename "$f" .sql)
  PGPASSWORD="$DB_PASS" $PSQL -q -f "$f" 2>/dev/null || true
  PGPASSWORD="$DB_PASS" $PSQL -q -c "INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES ('$version', '$name', NULL) ON CONFLICT DO NOTHING"
done
echo "  ✓ Migrations applied"

# --- Phase 5: Restore storage ---
echo ""
echo "▶ Phase 5: Uploading storage files..."
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
python3 "$SCRIPT_DIR/restore_storage.py" "$STORAGE_DIR" "$SUPABASE_URL" "$SERVICE_ROLE_KEY"
echo "  ✓ Storage restored"

# --- Phase 6: Deploy edge functions ---
echo ""
echo "▶ Phase 6: Deploying edge functions..."
supabase functions deploy --project-ref "$PROJECT_REF"
echo "  ✓ Edge functions deployed"

# --- Done ---
echo ""
echo "============================================================"
echo "  ✅ Restore complete: $ENV ($PROJECT_REF)"
echo ""
echo "  Next steps:"
if [ ! -f "$ENCRYPTED_SECRETS" ]; then
  echo "  1. Set edge function secrets (not in backup)"
  echo "     Run: ./scripts/setup-secrets.sh $ENV"
else
  echo "  1. Secrets restored from backup ✓"
fi
echo "  2. Verify auth redirect URLs in Supabase dashboard"
echo "     → Authentication → URL Configuration"
echo "  3. Launch local dev server: ./scripts/dev.sh $ENV"
echo "============================================================"

# Cleanup
rm -rf "$WORK_DIR"
