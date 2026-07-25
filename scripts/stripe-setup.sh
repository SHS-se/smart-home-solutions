#!/usr/bin/env bash
#
# One-shot, idempotent Stripe setup for the monthly subscription.
# Creates (or reuses) the Product, the recurring Price, and the webhook
# endpoint that feeds our own-invoice generation. Run it instead of clicking
# around the Stripe dashboard.
#
# Reads the secret key from a gitignored *.local env file — the key is never
# printed, never passed on the command line, never committed. The webhook
# signing secret (sensitive) is written to a *.local file, not to stdout.
#
# Usage:
#   bash scripts/stripe-setup.sh                       # uses .env.stripe.test.local
#   ENV_FILE=.env.stripe.live.local bash scripts/stripe-setup.sh
#
# Safety: refuses to run unless the secret key is a TEST key (sk_test_/rk_test_),
# unless ALLOW_LIVE=1 is explicitly set.

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.stripe.test.local}"

# ── config (smallest currency unit: SEK öre, so 32000 = 320.00 kr) ───────────
PRODUCT_NAME="${PRODUCT_NAME:-Smart Home Solutions Prenumeration}"
PRODUCT_DESC="${PRODUCT_DESC:-Månatlig prenumeration på Smart Home Solutions-tjänster}"
PRICE_AMOUNT="${PRICE_AMOUNT:-32000}"
PRICE_CURRENCY="${PRICE_CURRENCY:-sek}"
PRICE_INTERVAL="${PRICE_INTERVAL:-month}"
PRICE_LOOKUP_KEY="${PRICE_LOOKUP_KEY:-shs_subscription_monthly}"

# Test Supabase project ref (vxqpgbzseckgceopitpm); override for prod.
WEBHOOK_URL="${WEBHOOK_URL:-https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/stripe-webhook}"
WEBHOOK_SECRET_FILE="${WEBHOOK_SECRET_FILE:-.env.stripe.webhook.test.local}"

# Everything stripe-webhook/index.ts switches on. Kept in one place because the
# list is synced onto an existing endpoint too, not just used at creation.
WEBHOOK_EVENTS=(
  invoice.created
  invoice.paid
  invoice.payment_failed
  customer.subscription.updated
  customer.subscription.deleted
  charge.dispute.created
)

# ── load the secret key without echoing it ───────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Put STRIPE_SECRET_KEY=... in it (gitignored *.local)." >&2
  exit 1
fi
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
: "${STRIPE_SECRET_KEY:?STRIPE_SECRET_KEY is not set in $ENV_FILE}"

case "$STRIPE_SECRET_KEY" in
  sk_test_*|rk_test_*) MODE="test" ;;
  sk_live_*|rk_live_*)
    if [ "${ALLOW_LIVE:-0}" = "1" ]; then MODE="live"; else
      echo "REFUSING: live key detected. Re-run with ALLOW_LIVE=1 once you're ready for production." >&2
      exit 1
    fi ;;
  *) echo "ERROR: STRIPE_SECRET_KEY is not a recognizable Stripe key." >&2; exit 1 ;;
esac
echo "Running in ${MODE} mode against Stripe."

API="https://api.stripe.com/v1"
# Extracts a dotted path (supports name[idx]) from JSON on stdin; exits on Stripe error.
PYEXTRACT='import sys,json
d=json.load(sys.stdin)
if isinstance(d,dict) and "error" in d:
    sys.stderr.write("Stripe error: "+str(d["error"].get("message","unknown"))+"\n"); sys.exit(2)
cur=d
try:
    for p in sys.argv[1].split("."):
        if not p: continue
        if p.endswith("]"):
            n,i=p[:-1].split("["); cur=(cur[n] if n else cur)[int(i)]
        else:
            cur=cur.get(p) if isinstance(cur,dict) else None
        if cur is None: break
except (KeyError,IndexError,TypeError):
    cur=None
print(cur if cur is not None else "")'
extract(){ printf '%s' "$1" | python3 -c "$PYEXTRACT" "$2"; }
scall(){ curl -sS -u "$STRIPE_SECRET_KEY:" "$@"; }

# ── 1. Price (reuse by lookup_key) + its Product ─────────────────────────────
echo "Looking up price by lookup_key '$PRICE_LOOKUP_KEY'..."
existing=$(scall -G "$API/prices" \
  --data-urlencode "lookup_keys[]=$PRICE_LOOKUP_KEY" \
  --data-urlencode "expand[]=data.product")
PRICE_ID=$(extract "$existing" "data[0].id")
PRODUCT_ID=$(extract "$existing" "data[0].product.id")

if [ -n "$PRICE_ID" ]; then
  # Stripe prices are immutable: when the requested amount/currency/interval
  # differs from the existing price, create a replacement and transfer the
  # lookup_key to it (the app resolves the price by lookup_key), then archive
  # the old price. Existing subscriptions keep their old price; new ones pick
  # up the replacement.
  CUR_AMOUNT=$(extract "$existing" "data[0].unit_amount")
  CUR_CURRENCY=$(extract "$existing" "data[0].currency")
  CUR_INTERVAL=$(extract "$existing" "data[0].recurring.interval")
  if [ "$CUR_AMOUNT" = "$PRICE_AMOUNT" ] && [ "$CUR_CURRENCY" = "$PRICE_CURRENCY" ] && [ "$CUR_INTERVAL" = "$PRICE_INTERVAL" ]; then
    echo "Reusing existing price $PRICE_ID (product $PRODUCT_ID)."
  else
    echo "Price config changed ($CUR_AMOUNT $CUR_CURRENCY/$CUR_INTERVAL -> $PRICE_AMOUNT $PRICE_CURRENCY/$PRICE_INTERVAL)."
    OLD_PRICE_ID="$PRICE_ID"
    price=$(scall "$API/prices" \
      -d "product=$PRODUCT_ID" \
      -d "unit_amount=$PRICE_AMOUNT" \
      -d "currency=$PRICE_CURRENCY" \
      -d "recurring[interval]=$PRICE_INTERVAL" \
      -d "lookup_key=$PRICE_LOOKUP_KEY" \
      -d "transfer_lookup_key=true")
    PRICE_ID=$(extract "$price" "id")
    scall "$API/prices/$OLD_PRICE_ID" -d "active=false" >/dev/null
    echo "  replacement price: $PRICE_ID (lookup_key transferred; $OLD_PRICE_ID archived)"
  fi
else
  echo "Creating product..."
  prod=$(scall "$API/products" -d "name=$PRODUCT_NAME" -d "description=$PRODUCT_DESC")
  PRODUCT_ID=$(extract "$prod" "id")
  echo "  product: $PRODUCT_ID"

  echo "Creating recurring price ($PRICE_AMOUNT $PRICE_CURRENCY / $PRICE_INTERVAL)..."
  price=$(scall "$API/prices" \
    -d "product=$PRODUCT_ID" \
    -d "unit_amount=$PRICE_AMOUNT" \
    -d "currency=$PRICE_CURRENCY" \
    -d "recurring[interval]=$PRICE_INTERVAL" \
    -d "lookup_key=$PRICE_LOOKUP_KEY")
  PRICE_ID=$(extract "$price" "id")
  echo "  price: $PRICE_ID"
fi

# ── 2. Payment method configuration: force Link off ──────────────────────────
# payment_method_types on intents does NOT remove the Link prompt inside the
# Payment Element's card form (the "save my information" section) — that is
# governed by the account's default payment method configuration.
echo "Disabling Link in the default payment method configuration..."
pmclist=$(scall -G "$API/payment_method_configurations" -d "limit=100")
PMC_ID=$(printf '%s' "$pmclist" | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print(next((e["id"] for e in d.get("data",[]) if e.get("is_default")),""))')
if [ -n "$PMC_ID" ]; then
  pmcres=$(scall "$API/payment_method_configurations/$PMC_ID" \
    -d "link[display_preference][preference]=off")
  extract "$pmcres" "id" >/dev/null # surfaces Stripe errors
  echo "  Link turned off in configuration $PMC_ID."
else
  echo "  WARNING: no default payment method configuration found; disable Link in the dashboard." >&2
fi

# ── 3. Webhook endpoint (reuse by URL) ───────────────────────────────────────
echo "Checking webhook endpoint for $WEBHOOK_URL..."
whlist=$(scall -G "$API/webhook_endpoints" -d "limit=100")
WH_ID=$(printf '%s' "$whlist" | python3 -c \
  'import sys,json;d=json.load(sys.stdin);u=sys.argv[1];print(next((e["id"] for e in d.get("data",[]) if e.get("url")==u),""))' \
  "$WEBHOOK_URL")

EVENT_ARGS=()
for e in "${WEBHOOK_EVENTS[@]}"; do EVENT_ARGS+=(-d "enabled_events[]=$e"); done

if [ -n "$WH_ID" ]; then
  echo "Reusing existing webhook endpoint $WH_ID."
  # Re-send the event list: an endpoint created by an earlier run predates any
  # events added since, and Stripe silently drops the ones you never enabled.
  upd=$(scall "$API/webhook_endpoints/$WH_ID" "${EVENT_ARGS[@]}")
  extract "$upd" "id" >/dev/null # surfaces Stripe errors
  echo "  Subscribed events synced: ${WEBHOOK_EVENTS[*]}"
  echo "  (Stripe only reveals the signing secret at creation — if you need it again, roll it in the dashboard.)"
else
  echo "Creating webhook endpoint..."
  wh=$(scall "$API/webhook_endpoints" \
    -d "url=$WEBHOOK_URL" \
    -d "description=SHS subscription -> own invoices ($MODE)" \
    "${EVENT_ARGS[@]}")
  WH_ID=$(extract "$wh" "id")
  WH_SECRET=$(extract "$wh" "secret")
  umask 077
  printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$WH_SECRET" > "$WEBHOOK_SECRET_FILE"
  echo "  endpoint: $WH_ID"
  echo "  signing secret written to $WEBHOOK_SECRET_FILE (gitignored; do not commit)"
fi

# ── 4. Summary (all non-sensitive) ───────────────────────────────────────────
cat <<SUMMARY

──────────────────────────────────────────────
Stripe ${MODE} setup complete.
  Product id : $PRODUCT_ID
  Price id   : $PRICE_ID   (lookup_key: $PRICE_LOOKUP_KEY)
  Webhook    : $WH_ID -> $WEBHOOK_URL

Next:
  • Set Supabase secret SHS_STRIPE_SECRET_KEY (test project) to your sk_test key.
  • Set Supabase secret STRIPE_WEBHOOK_SECRET from $WEBHOOK_SECRET_FILE.
  • Put the publishable (pk_) key in .env.test as VITE_STRIPE_PUBLISHABLE_KEY.
  • Reference price id $PRICE_ID when creating subscriptions.
──────────────────────────────────────────────
SUMMARY
