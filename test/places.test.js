// node test/places.test.js — runs the pure place functions of index.html over recorded carrier events.
const fs = require("fs"), path = require("path"), assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const part = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert(i >= 0 && j > i, "marker " + a); return src.slice(i, j); };
const api = new Function(part("  var KNOWN = {", "  function $(") + part("  // ---- places: begin", "  // ---- places: end") +
  "; return { placeOf, locOf, refCityOf, knownLL, placeLike, sane, kmBetween };")();
const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
const hits = fx("geocoder-hits.json");
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok  " + name); };

// Places per fixture, oldest first; "?" marks a guess.
const places = (f) => { const t = fx(f), ref = api.refCityOf(t); return t.slice().reverse().map((e) => api.locOf(e, ref)).filter(Boolean).map((l) => (l.guess ? "?" : "") + l.place); };

test("rail parcel, delivered: stations and carrier towns, status notes carry no place", () => {
  assert.deepStrictEqual(places("rail-delivered.json"), [
    "?已下单", "?深圳", "?深圳", "?已发运", "?江油", "?玉门东", "?鄯善", "?阿拉山口", "?多斯特克",
    "Beskol", "Balkhash", "NUR-SULTAN", "Kushmurun", "Aydyrlya", "Orenburg", "Bezenchuk", "Vyazma", "布列斯特",
    "Brussels, BE", "Brussels, BE", "Corbeil Essonnes, FR", "Corbeil Essonnes, FR", "St Ouen, FR", "St Ouen, FR", "St Ouen, FR", "SURESNES, FR"]);
});
test("rail parcel, moving", () => {
  assert.deepStrictEqual(places("rail-moving.json"), ["?已下单", "?深圳", "?深圳", "?已发运", "?羊木", "?金昌", "?天山"]);
});
test("sea parcel: only the carrier's location field", () => {
  assert.deepStrictEqual([...new Set(places("sea-delivered.json"))], ["深圳总部", "DUISBURG,DE", "MARNE-LA-VALLEE,FR", "SURESNES,FR"]);
});
test("free-text notes have no place", () => {
  for (const s of ["清关完成，待预约交仓", "更新：10.1号交仓", "已提柜，预计10.2号清关", "预计9.30号提柜", "到达海外仓，待分拣", "11.2号装柜，11.9号班列",
    "当前海域：南海", "Shipper created a label, UPS has not received the package yet. , BE", "Shipment in warehouse - Delivery appointment booked"])
    assert.strictEqual(api.placeOf(s), null, s);
});
test("a guess needs a town or station of exactly that name", () => {
  const ok = (q) => (hits[q] || []).some((h) => api.placeLike(h, q));
  for (const q of ["羊木", "金昌", "天山", "玉门东", "鄯善", "阿拉山口", "重庆", "Malaszewicze"]) assert(ok(q), q);
  for (const q of ["已发运", "已下单", "已交仓", "Delivered"]) assert(!ok(q), q);
});

// The route as buildRoute assembles it: KNOWN, then recorded geocoder hits, then the coordinates below.
const LL = { "Aydyrlya": [52.04, 59.8], "Orenburg": [51.77, 55.1], "Bezenchuk": [52.98, 49.43], "Vyazma": [55.21, 34.3],
  "Brussels, BE": [50.85, 4.35], "Corbeil Essonnes, FR": [48.61, 2.48], "St Ouen, FR": [48.91, 2.33], "SURESNES, FR": [48.87, 2.23] };
const DEST = [48.87, 2.23];
function route(f, extra) {
  const t = fx(f), ref = api.refCityOf(t), pts = [];
  t.slice().reverse().forEach((e, i) => {
    const loc = api.locOf(e, ref); if (!loc) return;
    const known = api.knownLL(loc.place), hit = loc.guess ? (hits[loc.place] || []).find((h) => api.placeLike(h, loc.place)) : null;
    const ll = known || (hit ? [+hit.lat, +hit.lon] : LL[loc.place]);
    if (ll) pts.push({ i, ll, place: loc.place, soft: loc.guess && !known });
  });
  (extra || []).forEach((p) => pts.push(p));
  pts.sort((a, b) => a.i - b.i);
  return { pts, kept: api.sane(pts, DEST) };
}
test("rail route keeps every real stop", () => {
  const r = route("rail-delivered.json");
  assert.strictEqual(r.pts.length, 24);
  assert.deepStrictEqual(r.kept, r.pts);
  const m = route("rail-moving.json");
  assert.deepStrictEqual(m.kept.map((p) => p.place), ["深圳", "深圳", "羊木", "金昌", "天山"]);
});
test("a soft point that doubles back across the continent is left out", () => {
  const stray = { i: 22.5, ll: [23.1, 113.3], place: "stray", soft: true };
  const r = route("rail-delivered.json", [stray]);
  assert.deepStrictEqual(r.kept, r.pts.filter((p) => p !== stray));
});
test("two stray soft points in a row are both left out", () => {
  const a = { i: 22.4, ll: [23.1, 113.3], place: "a", soft: true };
  const b = { i: 22.6, ll: [26.6, 102.6], place: "b", soft: true };
  const r = route("rail-delivered.json", [a, b]);
  assert.deepStrictEqual(r.kept, r.pts.filter((p) => p !== a && p !== b));
});
test("a stray newest point is checked against the destination", () => {
  const stray = { i: 99, ll: [36.06, 127.0], place: "stray", soft: true };
  const r = route("rail-moving.json", [stray]);
  assert(!r.kept.includes(stray));
});
test("a firm point is never left out", () => {
  const far = { i: 22.5, ll: [23.1, 113.3], place: "far", soft: false };
  assert(route("rail-delivered.json", [far]).kept.includes(far));
});
test("a real stop before a stray one stays", () => {
  const stray = { i: 99, ll: [36.06, 127.0], place: "stray", soft: true };
  assert.deepStrictEqual(route("rail-moving.json", [stray]).kept.map((p) => p.place), ["深圳", "深圳", "羊木", "金昌", "天山"]);
});
console.log(n + " tests passed");
