// Cloudflare Worker: looks a tracking number up on 17TRACK and returns a
// compact JSON the parcel-tracker page can render. The 17TRACK token stays
// here as a secret; the page only ever talks to this Worker.
//
// Secrets / vars (Workers → Settings → Variables):
//   TRACK17_TOKEN    17TRACK API key (Settings → API in the 17TRACK dashboard)
//   DHL_API_KEY      DHL "Shipment Tracking - Unified" key (developer.dhl.com)
//   ALLOWED_ORIGINS  comma-separated page origins, default https://yuuteng.github.io
//
//   LISTS            KV namespace holding one list per name (key list:<name>)
//   RESEND_API_KEY   Resend key for change emails
//   NOTIFY_EMAIL     where change emails go
//   NOTIFY_OWNER     the one list name allowed to subscribe (default teng)
//   RUN_KEY          header X-Run-Key for POST /watch/run
//
// GET /?no=CY034468628CN           tracking lookup
// GET /dhl?no=617006259            DHL events for a linked last-mile number
// GET /list?u=<name>               the list saved under that name
// PUT /list?u=<name>  {state}      save it; merged with the stored one when `base` is stale
// GET /shared                      numbers everyone sees: { no: { by, t } }
// POST /shared {no, name, on}      share (on) or unshare (off, sharer only)
// GET /watch?u=<name>              { owner, watched: [no] }
// POST /watch {u, no, on}          subscribe a number to change emails (owner only)
// POST /watch/run                  run the email check now (needs X-Run-Key)
// Cron: checks subscribed numbers and emails new events in one message per run.
// Error codes: -18019902 = number not registered, -18019901 = already registered.

const API = "https://api.17track.net/track/v2.2/";
const STATUS = {
  NotFound: ["未查到", ""], InfoReceived: ["已收单", "pick"], InTransit: ["运输中", "warn"],
  Expired: ["已过期", "bad"], AvailableForPickup: ["待取件", "warn"], OutForDelivery: ["派送中", "warn"],
  DeliveryFailure: ["派送失败", "bad"], Delivered: ["已签收", "ok"], Exception: ["异常", "bad"]
};
const COUNTRY = { FR: "法国", CN: "中国", DE: "德国", BE: "比利时", NL: "荷兰", ES: "西班牙", IT: "意大利", GB: "英国", US: "美国", JP: "日本" };

export default {
  async scheduled(_ev, env, ctx) { ctx.waitUntil(checkWatched(env)); },
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://yuuteng.github.io").split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);

    const url = new URL(req.url);
    if (url.pathname === "/list") return handleList(req, env, url, cors);
    if (url.pathname === "/shared") return handleShared(req, env, url, cors);
    if (url.pathname === "/dhl") return handleDhl(env, url, cors);
    if (url.pathname === "/watch") return handleWatch(req, env, url, cors);
    if (url.pathname === "/watch/run") {
      if (req.method !== "POST" || !env.RUN_KEY || req.headers.get("X-Run-Key") !== env.RUN_KEY) return json({ error: "forbidden" }, 403, cors);
      return json(await checkWatched(env), 200, cors);
    }
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

async function handleDhl(env, url, cors) {
  if (!env.DHL_API_KEY) return json({ error: "DHL_API_KEY not set" }, 500, cors);
  const no = (url.searchParams.get("no") || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(no)) return json({ error: "bad number" }, 400, cors);
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/dhl?v=2&no=" + no);
  const hit = await cache.match(cacheKey);
  if (hit) { const r = new Response(hit.body, hit); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); r.headers.set("X-Cache", "HIT"); return r; }
  const r = await fetch("https://api-eu.dhl.com/track/shipments?trackingNumber=" + encodeURIComponent(no), {
    headers: { "DHL-API-Key": env.DHL_API_KEY, "Accept": "application/json" }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) return json({ error: j.detail || j.title || ("HTTP " + r.status), code: r.status }, 502, cors);
  const sh = (j.shipments || [])[0] || {};
  const traces = (sh.events || []).map(e => {
    const a = (e.location && e.location.address) || {};
    return {
      time: String(e.timestamp || "").replace("T", " ").slice(0, 19),
      info: e.description || e.status || "",
      place: [a.addressLocality, a.countryCode].filter(Boolean).join(", ") || null,
      code: e.statusCode || null
    };
  }).filter(t => t.time).sort((x, y) => y.time.localeCompare(x.time));
  const due = /^\d{4}-\d{2}-\d{2}/.test(sh.agreedDeliveryDate || "") ? sh.agreedDeliveryDate.slice(0, 10) : null;
  const res = json({ no, source: "dhl", statusCode: (sh.status && sh.status.statusCode) || null, due, traces }, 200, { ...cors, "Cache-Control": "public, max-age=900" });
  if (traces.length) await cache.put(cacheKey, res.clone());
  return res;
}

const NAME_MAX = 40, LIST_MAX = 200, NUM_RE = /^[A-Z0-9-]{4,40}$/;
function normName(s) {
  return String(s || "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}
function cleanState(s, name) {
  const nums = x => Array.isArray(x) ? [...new Set(x.map(v => String(v).trim().toUpperCase()).filter(v => NUM_RE.test(v)))].slice(0, LIST_MAX) : [];
  const out = { name: String((s && s.name) || name || "").normalize("NFC").trim().replace(/\s+/g, " ").slice(0, NAME_MAX),
                numbers: nums(s && s.numbers), hidden: nums(s && s.hidden), delivered: {}, order: nums(s && s.order), links: {}, updated: 0 };
  const d = (s && s.delivered) || {};
  for (const k of Object.keys(d)) { const K = String(k).toUpperCase(), t = +d[k]; if (NUM_RE.test(K) && t > 0) out.delivered[K] = t; }
  out.links = {};
  const l = (s && s.links) || {};
  for (const k of Object.keys(l).slice(0, LIST_MAX)) { const K = String(k).toUpperCase(), V = String(l[k]).trim().toUpperCase(); if (NUM_RE.test(K) && NUM_RE.test(V)) out.links[K] = V; }
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
    for (const k of Object.keys(old.links || {})) if (!(k in next.links)) next.links[k] = old.links[k];
  }
  next.updated = Date.now();
  await env.LISTS.put(kv, JSON.stringify(next));
  return json(next, 200, h);
}

async function handleShared(req, env, url, cors) {
  if (!env.LISTS) return json({ error: "LISTS KV not bound" }, 500, cors);
  const h = { ...cors, "Cache-Control": "no-store" };
  const cur = (await env.LISTS.get("shared", "json")) || {};
  if (req.method === "GET") return json(cur, 200, h);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, h);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, h); }
  const no = String(b.no || "").trim().toUpperCase(), key = normName(b.name);
  const disp = String(b.name || "").normalize("NFC").trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
  if (!NUM_RE.test(no) || !key) return json({ error: "bad request" }, 400, h);
  if (b.on) { if (!cur[no]) cur[no] = { by: disp, t: Date.now() }; }
  else if (cur[no]) {
    if (normName(cur[no].by) !== key) return json({ error: "shared by someone else" }, 403, h);
    delete cur[no];
  }
  await env.LISTS.put("shared", JSON.stringify(cur));
  return json(cur, 200, h);
}

// ---- change emails ----
const PAGE_URL = "https://yuuteng.github.io/parcel-tracker/";
const DELIVERED_RE = /签收|delivered/i;
const owner = env => normName(env.NOTIFY_OWNER || "teng");

async function handleWatch(req, env, url, cors) {
  if (!env.LISTS) return json({ error: "LISTS KV not bound" }, 500, cors);
  const h = { ...cors, "Cache-Control": "no-store" };
  const w = (await env.LISTS.get("watch", "json")) || {};
  if (req.method === "GET") {
    const me = normName(url.searchParams.get("u")) === owner(env) && !!env.RESEND_API_KEY;
    return json({ owner: me, watched: me ? Object.keys(w) : [] }, 200, h);
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, h);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, h); }
  if (normName(b.u) !== owner(env)) return json({ error: "forbidden" }, 403, h);
  const no = String(b.no || "").trim().toUpperCase();
  if (!NUM_RE.test(no)) return json({ error: "bad number" }, 400, h);
  if (b.on) { if (!w[no]) w[no] = { t: Date.now(), seen: null }; }
  else delete w[no];
  await env.LISTS.put("watch", JSON.stringify(w));
  return json({ owner: true, watched: Object.keys(w) }, 200, h);
}

function looseJson(t) {
  try { return JSON.parse(t); } catch (e) {}
  const i = t.search(/[{[]/);
  return i < 0 ? null : JSON.parse(t.slice(i));
}
const ev = (time, info, place) => ({ time: String(time || "").replace("T", " ").slice(0, 19), info: String(info || ""), place: place || null });

async function srcNextsls(no) {
  const r = await fetch("https://tracking.nextsls.com/rest/trace/tracking/lists?app=642e7f7573f04222943d090e&number=" + encodeURIComponent(no));
  if (!r.ok) throw new Error("nextsls HTTP " + r.status);
  const s = (looseJson(await r.text()) || {}).data?.shipment;
  if (!s) return null;
  return { delivered: s.status === "delivered", traces: (s.traces || []).map(t => ev(t.time, t.info, t.location)) };
}
async function srcItdida(nos) {
  const out = {};
  for (let i = 0; i < nos.length; i += 10) {
    if (i) await new Promise(r => setTimeout(r, 1500));
    const r = await fetch("https://yen.itdida.com/itdida-api/queryTracks?no=" + encodeURIComponent(nos.slice(i, i + 10).join(",")));
    if (!r.ok) continue;
    for (const item of (looseJson(await r.text()) || {}).data || []) {
      const tl = item.trackList || [];
      if (tl.length) out[String(item.no).toUpperCase()] = { traces: tl.map(t => ev(t.time, t.desc || t.eventCodeDesc, t.localtion || [t.eventCity, t.eventCountry].filter(Boolean).join(", "))) };
    }
  }
  return out;
}
async function src17(env, no) {
  if (!env.TRACK17_TOKEN) return null;
  const info = await call17(env, "gettrackinfo", no);
  if (!info.accepted) return null;
  const n = normalize(no, info.accepted);
  return n.traces.length ? { delivered: n.statusRaw === "Delivered", traces: n.traces } : null;
}
async function srcDhl(env, no) {
  if (!env.DHL_API_KEY) return null;
  const r = await fetch("https://api-eu.dhl.com/track/shipments?trackingNumber=" + encodeURIComponent(no), { headers: { "DHL-API-Key": env.DHL_API_KEY, "Accept": "application/json" } });
  if (!r.ok) return null;
  const sh = ((await r.json().catch(() => ({}))).shipments || [])[0];
  if (!sh) return null;
  return {
    delivered: (sh.status && sh.status.statusCode) === "delivered",
    traces: (sh.events || []).map(e => { const a = (e.location && e.location.address) || {}; return ev(e.timestamp, e.description || e.status, [a.addressLocality, a.countryCode].filter(Boolean).join(", ")); })
  };
}

async function checkWatched(env) {
  const w = (await env.LISTS.get("watch", "json")) || {};
  const nos = Object.keys(w);
  if (!nos.length) return { checked: 0, changed: 0 };
  const list = (await env.LISTS.get("list:" + owner(env), "json")) || {};
  const links = list.links || {};
  const it = await srcItdida(nos).catch(() => ({}));
  const changes = [];
  for (const no of nos) {
    let s = await srcNextsls(no).catch(() => null);
    if (!s) s = it[no] || null;
    if (!s) s = await src17(env, no).catch(() => null);
    const d = links[no] ? await srcDhl(env, links[no]).catch(() => null) : null;
    if (!s && !d) continue;
    const seenMin = new Set();
    const traces = [...(s ? s.traces : []), ...(d ? d.traces : [])].filter(t => t.time)
      .sort((x, y) => y.time.localeCompare(x.time))
      .filter(t => { const k = t.time.slice(0, 16); if (seenMin.has(k)) return false; seenMin.add(k); return true; });
    if (!traces.length) continue;
    const newest = traces[0].time, last = w[no].seen;
    const done = !!(s && s.delivered) || !!(d && d.delivered) || DELIVERED_RE.test(traces[0].info);
    if (last == null) { w[no].seen = newest; if (done) delete w[no]; continue; }
    if (newest <= last) continue;
    changes.push({ no, link: links[no] || null, done, events: traces.filter(t => t.time > last).slice(0, 8) });
    if (done) delete w[no]; else w[no].seen = newest;
  }
  if (changes.length) {
    const sent = await sendMail(env, changes);
    if (!sent.ok) return { checked: nos.length, changed: changes.length, error: sent.error };
  }
  await env.LISTS.put("watch", JSON.stringify(w));
  return { checked: nos.length, changed: changes.length };
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
async function sendMail(env, changes) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return { ok: false, error: "email not configured" };
  const one = changes[0];
  const subject = changes.length === 1
    ? `${one.no} ${one.done ? "已签收" : "有新动态"}：${one.events[0].info.slice(0, 60)}`
    : `${changes.length} 个包裹有新动态` + (changes.some(c => c.done) ? `（${changes.filter(c => c.done).length} 个已签收）` : "");
  const page = PAGE_URL + "#u=" + encodeURIComponent(env.NOTIFY_OWNER || "teng");
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#222">` + changes.map(c =>
    `<h3 style="margin:18px 0 6px;font-size:15px">${esc(c.no)}${c.link ? ` <span style="color:#888;font-weight:400">· ${esc(c.link)}</span>` : ""}${c.done ? ` <span style="color:#2a8a3a">· 已签收</span>` : ""}</h3>` +
    `<table style="border-collapse:collapse">` + c.events.map(e =>
      `<tr><td style="padding:2px 12px 2px 0;color:#888;white-space:nowrap;font-family:monospace">${esc(e.time.slice(5, 16))}</td><td style="padding:2px 0">${esc(e.info)}${e.place ? ` <span style="color:#888">· ${esc(e.place)}</span>` : ""}</td></tr>`).join("") +
    `</table>`).join("") + `<p style="margin-top:20px"><a href="${page}">打开包裹追踪</a></p></div>`;
  const text = changes.map(c => `${c.no}${c.done ? " · 已签收" : ""}\n` + c.events.map(e => `  ${e.time.slice(5, 16)}  ${e.info}${e.place ? " · " + e.place : ""}`).join("\n")).join("\n\n") + `\n\n${page}`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "包裹追踪 <onboarding@resend.dev>", to: [env.NOTIFY_EMAIL], subject, html, text })
  });
  return r.ok ? { ok: true } : { ok: false, error: "resend HTTP " + r.status + " " + (await r.text()).slice(0, 200) };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
