#!/usr/bin/env bash
# Upload worker.js to Cloudflare via the REST API (no wrangler needed).
# Usage: source ~/.config/parcel-tracker/cloudflare.env; worker/deploy.sh [--sign SIGN] [--origins ORIGINS]
set -euo pipefail
NAME=parcel-17track
DIR=$(cd "$(dirname "$0")" && pwd)
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

SIGN=""; ORIGINS=""
while [ $# -gt 0 ]; do case "$1" in --sign) SIGN=$2; shift 2;; --origins) ORIGINS=$2; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done

# Bindings: keep whatever is already set unless overridden on the command line.
BINDINGS=$(python3 - "$SIGN" "$ORIGINS" <<'PY'
import json,sys
sign,origins=sys.argv[1],sys.argv[2]
b=[]
if sign: b.append({"type":"secret_text","name":"TRACK17_SIGN","text":sign})
if origins: b.append({"type":"plain_text","name":"ALLOWED_ORIGINS","text":origins})
print(json.dumps({"main_module":"worker.js","compatibility_date":"2026-09-01","bindings":b,"keep_bindings":["secret_text","plain_text"]}))
PY
)
echo "$BINDINGS" > "$DIR/.metadata.json"
curl -sS -X PUT "$API/scripts/$NAME" "${AUTH[@]}" \
  -F "metadata=@$DIR/.metadata.json;type=application/json" \
  -F "worker.js=@$DIR/worker.js;type=application/javascript+module" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('upload:', 'ok' if d.get('success') else d.get('errors'))"
rm -f "$DIR/.metadata.json"

# workers.dev subdomain + enable it for this script
SUB=$(curl -sS "$API/subdomain" "${AUTH[@]}" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('result') or {}).get('subdomain') or '')")
if [ -z "$SUB" ]; then
  SUB="yuuteng"
  curl -sS -X PUT "$API/subdomain" "${AUTH[@]}" -H "Content-Type: application/json" -d "{\"subdomain\":\"$SUB\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print('subdomain:', 'ok' if d.get('success') else d.get('errors'))"
fi
curl -sS -X POST "$API/scripts/$NAME/subdomain" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"enabled":true,"previews_enabled":false}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('workers.dev route:', 'ok' if d.get('success') else d.get('errors'))"
echo "URL: https://$NAME.$SUB.workers.dev"
