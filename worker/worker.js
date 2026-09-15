// Cloudflare Worker: relays a tracking-number lookup to the 17TRACK web
// endpoint and returns compact JSON for the parcel-tracker page.
//
// Vars (Workers → Settings → Variables):
//   TRACK17_SIGN     the "sign" field the 17TRACK web app sends (copy from a browser request)
//   ALLOWED_ORIGINS  comma-separated page origins, default https://yuuteng.github.io
//
// GET /?no=CY034468628CN

const UPSTREAM = "https://t.17track.net/track/restapi";
const STATUS = {
  NotFound: ["未查到", ""], InfoReceived: ["已收单", "pick"], InTransit: ["运输中", "warn"],
  Expired: ["已过期", "bad"], AvailableForPickup: ["待取件", "warn"], OutForDelivery: ["派送中", "warn"],
  DeliveryFailure: ["派送失败", "bad"], Delivered: ["已签收", "ok"], Exception: ["异常", "bad"]
};
const COUNTRY = { FR: "法国", CN: "中国", DE: "德国", BE: "比利时", NL: "荷兰", ES: "西班牙", IT: "意大利", GB: "英国", US: "美国", JP: "日本", PL: "波兰", BY: "白俄罗斯", KZ: "哈萨克斯坦" };

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
    if (!env.TRACK17_SIGN) return json({ error: "TRACK17_SIGN not set" }, 500, cors);

    const url = new URL(req.url);
    const no = (url.searchParams.get("no") || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(no)) return json({ error: "bad number" }, 400, cors);

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/?no=" + no);
    const hit = await cache.match(cacheKey);
    if (hit) { const r = new Response(hit.body, hit); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); r.headers.set("X-Cache", "HIT"); return r; }

    const up = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Accept": "*/*",
        "Origin": "https://t.17track.net", "Referer": "https://t.17track.net/zh-cn",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({ data: [{ num: no, fc: 0, sc: 0 }], guid: "", timeZoneOffset: -120, sign: env.TRACK17_SIGN })
    });
    const j = await up.json().catch(() => null);
    if (!j) return json({ error: "17track: bad response (HTTP " + up.status + ")" }, 502, cors);
    const sh = (j.shipments || [])[0];
    if (!sh || !sh.shipment) {
      const code = (j.meta && j.meta.code) || (sh && sh.code) || 0;
      const hint = code === -14 ? " (sign 已失效)" : code === -10 ? " (Referer 被拒)" : "";
      return json({ error: "17track: code " + code + hint, code: code, raw: url.searchParams.has("debug") ? j : undefined }, 502, cors);
    }

    const out = normalize(no, sh);
    const res = json(out, 200, { ...cors, "Cache-Control": "public, max-age=300" });
    if (out.traces.length) await cache.put(cacheKey, res.clone());
    return res;
  }
};

function normalize(no, sh) {
  const s = sh.shipment;
  const providers = (s.tracking && s.tracking.providers) || [];
  const traces = [];
  for (const p of providers) for (const e of (p.events || [])) {
    const a = e.address || {};
    traces.push({
      time: (e.time_iso || e.time_utc || "").replace("T", " ").slice(0, 19),
      info: e.description || "",
      place: e.location || [a.city, a.state, a.country].filter(Boolean).join(", ") || null,
      provider: (p.provider && p.provider.name) || null
    });
  }
  traces.sort((x, y) => y.time.localeCompare(x.time));
  const st = (s.latest_status && s.latest_status.status) || "NotFound";
  const ship = s.shipping_info || {};
  const to = (ship.recipient_address || {}).country || "";
  const from = (ship.shipper_address || {}).country || "";
  const names = providers.map(p => p.provider && p.provider.name).filter(Boolean);
  return {
    no, source: "17track",
    carrier: names.join(" → "), carriers: names,
    status: (STATUS[st] || [st, ""])[0], statusCls: (STATUS[st] || [st, ""])[1], statusRaw: st,
    country: COUNTRY[to] || to, origin: COUNTRY[from] || from,
    traces,
    link: "https://t.17track.net/zh-cn#nums=" + no
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
