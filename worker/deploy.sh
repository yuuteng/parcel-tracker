#!/usr/bin/env bash
# Upload worker.js to Cloudflare via the REST API (no wrangler needed).
# Usage: source ~/.config/parcel-tracker/cloudflare.env; worker/deploy.sh [--token KEY] [--dhl KEY] [--origins ORIGINS]
set -euo pipefail
NAME=parcel-17track
DIR=$(cd "$(dirname "$0")" && pwd)
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
KV_LISTS_ID=${KV_LISTS_ID:-}
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

TOKEN=""; ORIGINS=""; DHL=""
while [ $# -gt 0 ]; do case "$1" in --token) TOKEN=$2; shift 2;; --origins) ORIGINS=$2; shift 2;; --dhl) DHL=$2; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done

# Bindings: keep whatever is already set unless overridden on the command line.
# Change emails: RESEND_API_KEY, NOTIFY_EMAIL and RUN_KEY are taken from the environment when set.
BINDINGS=$(python3 - "$TOKEN" "$ORIGINS" "$KV_LISTS_ID" "$DHL" "${RESEND_API_KEY:-}" "${NOTIFY_EMAIL:-}" "${RUN_KEY:-}" <<'PY'
import json,sys
token,origins,kv,dhl,resend,email,runkey=sys.argv[1:8]
b=[]
if kv: b.append({"type":"kv_namespace","name":"LISTS","namespace_id":kv})
if token: b.append({"type":"secret_text","name":"TRACK17_TOKEN","text":token})
if dhl: b.append({"type":"secret_text","name":"DHL_API_KEY","text":dhl})
if resend: b.append({"type":"secret_text","name":"RESEND_API_KEY","text":resend})
if email: b.append({"type":"secret_text","name":"NOTIFY_EMAIL","text":email})
if runkey: b.append({"type":"secret_text","name":"RUN_KEY","text":runkey})
if origins: b.append({"type":"plain_text","name":"ALLOWED_ORIGINS","text":origins})
print(json.dumps({"main_module":"worker.js","compatibility_date":"2026-09-01","bindings":b,"keep_bindings":["secret_text","plain_text","kv_namespace"]}))
PY
)
echo "$BINDINGS" > "$DIR/.metadata.json"
curl -sS -X PUT "$API/scripts/$NAME" "${AUTH[@]}" \
  -F "metadata=@$DIR/.metadata.json;type=application/json" \
  -F "worker.js=@$DIR/worker.js;type=application/javascript+module" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('upload:', 'ok' if d.get('success') else d.get('errors'))"
rm -f "$DIR/.metadata.json"

# Cron for change emails: every 2 hours at :17.
curl -sS -X PUT "$API/scripts/$NAME/schedules" "${AUTH[@]}" -H "Content-Type: application/json" -d '[{"cron":"17 */2 * * *"}]' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('cron:', 'ok' if d.get('success') else d.get('errors'))"

# workers.dev subdomain + enable it for this script
SUB=$(curl -sS "$API/subdomain" "${AUTH[@]}" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('result') or {}).get('subdomain') or '')")
if [ -z "$SUB" ]; then
  SUB="yuuteng"
  curl -sS -X PUT "$API/subdomain" "${AUTH[@]}" -H "Content-Type: application/json" -d "{\"subdomain\":\"$SUB\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print('subdomain:', 'ok' if d.get('success') else d.get('errors'))"
fi
curl -sS -X POST "$API/scripts/$NAME/subdomain" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"enabled":true,"previews_enabled":false}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('workers.dev route:', 'ok' if d.get('success') else d.get('errors'))"
echo "URL: https://$NAME.$SUB.workers.dev"
