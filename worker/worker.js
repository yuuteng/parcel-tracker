// Cloudflare Worker: looks a tracking number up on 17TRACK and returns a
// compact JSON the parcel-tracker page can render. The 17TRACK token stays
// here as a secret; the page only ever talks to this Worker.
//
// Secrets / vars (Workers → Settings → Variables):
//   TRACK17_TOKEN    17TRACK API key (Settings → API in the 17TRACK dashboard)
//   ALLOWED_ORIGINS  comma-separated page origins, default https://yuuteng.github.io
//
//   LISTS            KV namespace holding one list per name (key list:<name>)
//
// GET /?no=CY034468628CN           tracking lookup
// GET /list?u=<name>               the list saved under that name
// PUT /list?u=<name>  {state}      save it; merged with the stored one when `base` is stale
// Error codes: -18019902 = number not registered, -18019901 = already registered.

const API = "https://api.17track.net/track/v2.2/";
const STATUS = {
  NotFound: ["未查到", ""], InfoReceived: ["已收单", "pick"], InTransit: ["运输中", "warn"],
  Expired: ["已过期", "bad"], AvailableForPickup: ["待取件", "warn"], OutForDelivery: ["派送中", "warn"],
  DeliveryFailure: ["派送失败", "bad"], Delivered: ["已签收", "ok"], Exception: ["异常", "bad"]
};
const COUNTRY = { FR: "法国", CN: "中国", DE: "德国", BE: "比利时", NL: "荷兰", ES: "西班牙", IT: "意大利", GB: "英国", US: "美国", JP: "日本" };

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://yuuteng.github.io").split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);

    const url = new URL(req.url);
    if (url.pathname === "/list") return handleList(req, env, url, cors);
    if (!env.TRACK17_TOKEN) return json({ error: "TRACK17_TOKEN not set" }, 500, cors);
    const no = (url.searchParams.get("no") || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(no)) return json({ error: "bad number" }, 400, cors);

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/?no=" + no);
    const hit = await cache.match(cacheKey);
    if (hit) { const r = new Response(hit.body, hit); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); r.headers.set("X-Cache", "HIT"); return r; }

    let registered = false;
    let info = await call17(env, "gettrackinfo", no);
    if (info.rejected && info.rejected.code === -18019902) {          // not registered yet: register (costs 1 quota), then read again
      const reg = await call17(env, "register", no);
      if (reg.rejected && reg.rejected.code !== -18019901) return json({ error: reg.rejected.message || "register failed", code: reg.rejected.code }, 502, cors);
      registered = true;
      await new Promise(r => setTimeout(r, 2500));
      info = await call17(env, "gettrackinfo", no);
    }
    if (info.rejected) return json({ error: info.rejected.message || "17track error", code: info.rejected.code }, 502, cors);

    const out = normalize(no, info.accepted);
    out.registered = registered;
    const res = json(out, 200, { ...cors, "Cache-Control": "public, max-age=300" });
    if (out.traces.length) await cache.put(cacheKey, res.clone());
    return res;
  }
};

async function call17(env, method, no) {
  const r = await fetch(API + method, {
    method: "POST",
    headers: { "Content-Type": "application/json", "17token": env.TRACK17_TOKEN },
    body: JSON.stringify([{ number: no }])
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) return { rejected: { code: j.code, message: j.message || ("HTTP " + r.status) } };
  const acc = (j.data && j.data.accepted || [])[0];
  const rej = (j.data && j.data.rejected || [])[0];
  if (acc) return { accepted: acc };
  return { rejected: (rej && rej.error) || { code: -1, message: "empty response" } };
}

function normalize(no, acc) {
  const ti = acc.track_info || {};
  const providers = (ti.tracking && ti.tracking.providers) || [];
  const events = [];
  for (const p of providers) for (const e of (p.events || [])) {
    const a = e.address || {};
    events.push({
      time: (e.time_iso || e.time_utc || "").replace("T", " ").slice(0, 19),
      info: e.description || "",
      place: e.location || [a.city, a.state, a.country].filter(Boolean).join(", ") || null,
      stage: e.stage || null
    });
  }
  events.sort((x, y) => y.time.localeCompare(x.time));
  const st = (ti.latest_status && ti.latest_status.status) || "NotFound";
  const ship = ti.shipping_info || {};
  const to = (ship.recipient_address || {}).country || "";
  const from = (ship.shipper_address || {}).country || "";
  const prov = providers[0] && providers[0].provider || {};
  const eta = ti.time_metrics && ti.time_metrics.estimated_delivery_date || null;
  return {
    no, source: "17track", carrier: prov.name || String(acc.carrier || ""), carrierCountry: prov.country || from,
    status: (STATUS[st] || [st, ""])[0], statusCls: (STATUS[st] || [st, ""])[1], statusRaw: st,
    country: COUNTRY[to] || to, origin: COUNTRY[from] || from,
    eta: eta && (eta.from || eta.to) ? { from: eta.from, to: eta.to } : null,
    days: ti.time_metrics ? ti.time_metrics.days_of_transit : null,
    traces: events,
    link: "https://t.17track.net/zh-cn#nums=" + no
  };
}

const NAME_MAX = 40, LIST_MAX = 200, NUM_RE = /^[A-Z0-9-]{4,40}$/;
function normName(s) {
  return String(s || "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}
function cleanState(s, name) {
  const nums = x => Array.isArray(x) ? [...new Set(x.map(v => String(v).trim().toUpperCase()).filter(v => NUM_RE.test(v)))].slice(0, LIST_MAX) : [];
  const out = { name: String((s && s.name) || name || "").normalize("NFC").trim().replace(/\s+/g, " ").slice(0, NAME_MAX),
                numbers: nums(s && s.numbers), hidden: nums(s && s.hidden), delivered: {}, order: nums(s && s.order), updated: 0 };
  const d = (s && s.delivered) || {};
  for (const k of Object.keys(d)) { const K = String(k).toUpperCase(), t = +d[k]; if (NUM_RE.test(K) && t > 0) out.delivered[K] = t; }
  return out;
}
async function handleList(req, env, url, cors) {
  if (!env.LISTS) return json({ error: "LISTS KV not bound" }, 500, cors);
  const raw = url.searchParams.get("u"), key = normName(raw);
  if (!key || key.length > NAME_MAX) return json({ error: "bad name" }, 400, cors);
  const h = { ...cors, "Cache-Control": "no-store" };
  const kv = "list:" + key;
  const old = await env.LISTS.get(kv, "json");
  if (req.method === "GET") return json(old || cleanState(null, raw), 200, h);
  if (req.method !== "PUT") return json({ error: "method not allowed" }, 405, h);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, h); }
  const next = cleanState(body, raw);
  if (old && +body.base !== old.updated) {
    const uniq = a => [...new Set(a)];
    next.numbers = uniq(next.numbers.concat(old.numbers || []));
    next.hidden = uniq(next.hidden.concat(old.hidden || []));
    for (const k of Object.keys(old.delivered || {})) if (!(next.delivered[k] > old.delivered[k])) next.delivered[k] = old.delivered[k];
    next.order = uniq(next.order.concat(old.order || []));
  }
  next.updated = Date.now();
  await env.LISTS.put(kv, JSON.stringify(next));
  return json(next, 200, h);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
