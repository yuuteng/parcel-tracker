# 17TRACK relay Worker

Relays a tracking-number lookup to the 17TRACK web endpoint (`t.17track.net/track/restapi`) and returns compact JSON for `index.html`. The endpoint only answers requests whose `Referer` is 17TRACK itself and that carry the web app's `sign` value, so the page cannot call it directly; the Worker sets both.

Deployed as `parcel-17track` on the Cloudflare account; the page's `WORKER_URL` points at it.

## Vars
- `TRACK17_SIGN` — the `sign` string from a browser request to `t.17track.net/track/restapi` (DevTools → Network → copy from the JSON body). Not bound to number or session. If lookups start returning `code -14`, capture a fresh one and update the var.
- `ALLOWED_ORIGINS` — comma-separated page origins, default `https://yuuteng.github.io`.

## Deploy from this Mac
Credentials live in `~/.config/parcel-tracker/cloudflare.env` (API token + account id, not in the repo).

```sh
source ~/.config/parcel-tracker/cloudflare.env
worker/deploy.sh            # uploads worker.js, keeps existing vars
worker/deploy.sh --sign "$(cat sign.txt)"   # also (re)sets TRACK17_SIGN
```

Test: `curl "https://parcel-17track.<account>.workers.dev/?no=CY034468628CN"`.

The Worker caches each number for 5 minutes.
