# 17TRACK relay Worker

Looks up a tracking number on 17TRACK and returns the events as compact JSON for `index.html`. Keeps the API key out of the page.

## Deploy (Cloudflare dashboard, no CLI)

1. 17TRACK: sign up at https://www.17track.net, open the API dashboard (https://api.17track.net), copy the API key. Free plan: 100 tracking registrations per month.
2. Cloudflare: Workers & Pages → Create → Create Worker → name it (e.g. `parcel-17track`) → Deploy.
3. Edit code → replace everything with `worker.js` → Deploy.
4. Settings → Variables and Secrets → add secret `TRACK17_TOKEN` = the 17TRACK key. Optional var `ALLOWED_ORIGINS` (default `https://yuuteng.github.io`).
5. Copy the Worker URL (`https://parcel-17track.<account>.workers.dev`) into `WORKER_URL` at the top of `index.html`.

Test: `curl "https://<worker>/?no=CY034468628CN" -H "Origin: https://yuuteng.github.io"`.

The Worker caches each number for 5 minutes. A number is registered on 17TRACK the first time it is asked for; later lookups are free.
