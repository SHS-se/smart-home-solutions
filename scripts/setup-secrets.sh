#!/bin/bash
# setup-secrets.sh — Set edge function secrets for test or live Supabase project
# Usage: ./scripts/setup-secrets.sh [test|live]
#
# Prompts for each secret interactively. Nothing is written to disk.
# Secrets are piped directly to the Supabase CLI.

set -e

ENV="${1:-test}"

case "$ENV" in
  test)
    PROJECT_REF="vxqpgbzseckgceopitpm"
    APP_ENV_VALUE="test"
    APP_ORIGIN_ALLOWLIST_DEFAULT="http://localhost:3000,https://preview--smarthomesolutions.lovable.app,https://98b52ef2-a9b8-4c1d-b3d5-ed16c32dda05.lovableproject.com"
    ;;
  live|prod)
    PROJECT_REF="oosxndduqzhvrorgogaw"
    APP_ENV_VALUE="live"
    APP_ORIGIN_ALLOWLIST_DEFAULT="https://smarthomesolutions.se,http://localhost:3000,https://preview--smarthomesolutions.lovable.app,https://98b52ef2-a9b8-4c1d-b3d5-ed16c32dda05.lovableproject.com,https://id-preview--98b52ef2-a9b8-4c1d-b3d5-ed16c32dda05.lovable.app"
    ;;
  *)
    echo "Usage: $0 [test|live]"
    exit 1
    ;;
esac

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Setting secrets for: $ENV ($PROJECT_REF)  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "The SUPABASE_* secrets are auto-provisioned — you don't need to enter those."
echo "Enter each value when prompted. Press Enter to skip (keeps existing value)."
echo ""

prompt_secret() {
  local name="$1"
  local hint="$2"
  echo -n "  $name ($hint): "
  read -r value
  echo "$value"
}

prompt_secret_with_default() {
  local name="$1"
  local hint="$2"
  local default_value="$3"
  echo -n "  $name ($hint) [$default_value]: "
  read -r value
  if [ -n "$value" ]; then
    echo "$value"
  else
    echo "$default_value"
  fi
}

# Collect secrets
echo "── Resend ──────────────────────────────────────────────"
RESEND_KEY=$(prompt_secret "RESEND_API_KEY" "re_... — resend.com/api-keys")
RESEND_RECEIVING=$(prompt_secret "RESEND_RECEIVING_API_KEY" "re_... — leave blank to reuse RESEND_API_KEY")
RESEND_SIGNING=$(prompt_secret "RESEND_SIGNING_SECRET" "resend.com/webhooks signing secret")

echo ""
echo "── Email addresses ──────────────────────────────────────"
CONTACT_TO=$(prompt_secret "CONTACT_TO" "sales contact email, e.g. sales@smarthomesolutions.se")
SUPPORT_TO=$(prompt_secret "SUPPORT_TO" "support email, e.g. support@smarthomesolutions.se")

echo ""
echo "── App config ──────────────────────────────────────────"
echo "  APP_ENV → $APP_ENV_VALUE (auto-set)"
APP_ORIGIN_ALLOWLIST=$(prompt_secret_with_default "APP_ORIGIN_ALLOWLIST" "comma-separated allowed frontend origins" "$APP_ORIGIN_ALLOWLIST_DEFAULT")
BANKGIRO_NUMBER=$(prompt_secret "BANKGIRO_NUMBER" "bankgiro number shown on invoices")

# Build the secrets list, skipping blank entries
SECRETS=()
SECRETS+=("APP_ENV=$APP_ENV_VALUE")
SECRETS+=("APP_ORIGIN_ALLOWLIST=$APP_ORIGIN_ALLOWLIST")
[ -n "$BANKGIRO_NUMBER" ] && SECRETS+=("BANKGIRO_NUMBER=$BANKGIRO_NUMBER")

[ -n "$RESEND_KEY" ]     && SECRETS+=("RESEND_API_KEY=$RESEND_KEY")
[ -n "$RESEND_SIGNING" ] && SECRETS+=("RESEND_SIGNING_SECRET=$RESEND_SIGNING")
[ -n "$CONTACT_TO" ]     && SECRETS+=("CONTACT_TO=$CONTACT_TO")
[ -n "$SUPPORT_TO" ]     && SECRETS+=("SUPPORT_TO=$SUPPORT_TO")

# RESEND_RECEIVING_API_KEY falls back to RESEND_API_KEY if blank
if [ -n "$RESEND_RECEIVING" ]; then
  SECRETS+=("RESEND_RECEIVING_API_KEY=$RESEND_RECEIVING")
elif [ -n "$RESEND_KEY" ]; then
  SECRETS+=("RESEND_RECEIVING_API_KEY=$RESEND_KEY")
fi

echo ""
echo "→ Setting ${#SECRETS[@]} secrets on project $PROJECT_REF..."
supabase secrets set "${SECRETS[@]}" --project-ref "$PROJECT_REF"

echo ""
echo "✓ Done! Verify with:"
echo "  supabase secrets list --project-ref $PROJECT_REF"
