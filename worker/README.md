# 17TRACK relay Worker

Looks a tracking number up through the official 17TRACK API (v2.2) and returns compact JSON for `index.html`. The API key stays in the Worker as a secret; the page only talks to the Worker.

Deployed as `parcel-17track`; the page's `WORKER_URL` points at it. Only requests from `ALLOWED_ORIGINS` are answered.

## Quota
Registering a new number costs 1 quota; later lookups of the same number are free. The Worker registers a number the first time it is asked for it, then reads the track info (a fresh registration may come back with no events for a minute or two). Results are cached 5 minutes.

## Vars
- `TRACK17_TOKEN` (secret) — API key from admin.17track.net → Settings → API.
- `ALLOWED_ORIGINS` — comma-separated page origins, default `https://yuuteng.github.io`.

## Deploy from this Mac
Credentials live in `~/.config/parcel-tracker/cloudflare.env` (Cloudflare API token + account id + 17TRACK key, not in the repo).

```sh
source ~/.config/parcel-tracker/cloudflare.env
worker/deploy.sh                          # upload worker.js, keep existing vars
worker/deploy.sh --token "$TRACK17_TOKEN" # also (re)set the 17TRACK key
```

Test: `curl "https://parcel-17track.yuuteng.workers.dev/?no=CY034468628CN" -H "Origin: https://yuuteng.github.io"`.
