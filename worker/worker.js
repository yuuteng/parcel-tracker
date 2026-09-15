// Cloudflare Worker: looks a tracking number up on 17TRACK and returns a
// compact JSON the parcel-tracker page can render. The 17TRACK token stays
// here as a secret; the page only ever talks to this Worker.
//
// Secrets / vars (Workers → Settings → Variables):
//   TRACK17_TOKEN    17TRACK API key (Settings → API in the 17TRACK dashboard)
//   ALLOWED_ORIGINS  comma-separated page origins, default https://yuuteng.github.io
//
// GET /?no=CY034468628CN

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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);
    if (!env.TRACK17_TOKEN) return json({ error: "TRACK17_TOKEN not set" }, 500, cors);

    const url = new URL(req.url);
    const no = (url.searchParams.get("no") || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(no)) return json({ error: "bad number" }, 400, cors);

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/?no=" + no);
    const hit = await cache.match(cacheKey);
    if (hit) { const r = new Response(hit.body, hit); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); r.headers.set("X-Cache", "HIT"); return r; }

    let info = await call17(env, "gettrackinfo", no);
    if (info.rejected && info.rejected.code === -18019901) {          // never registered: register, then read again
      const reg = await call17(env, "register", no);
      if (reg.rejected && reg.rejected.code !== -18019902) return json({ error: reg.rejected.message || "register failed", code: reg.rejected.code }, 502, cors);
      info = await call17(env, "gettrackinfo", no);
    }
    if (info.rejected) return json({ error: info.rejected.message || "17track error", code: info.rejected.code }, 502, cors);

    const out = normalize(no, info.accepted);
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

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
