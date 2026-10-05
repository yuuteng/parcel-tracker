#!/usr/bin/env python3
"""Collect vessel positions for vessels.json into ships.json.

aisstream.io gives exact fixes near its shore receivers; VesselFinder's public
pages give whole-degree positions at sea plus speed, course, destination, ETA.
searoute turns the fixes into a path along shipping lanes: `path` from the
vessel's `from` port through every fix, `ahead` from the latest fix to `toward`.
Usage: AISSTREAM_KEY=... scripts/ships.py vessels.json ships.json
"""
import asyncio
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
LISTEN_S = 60
TRACK_MAX = 300
STALE_EXACT_S = 6 * 3600


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def epoch(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp() if s else 0


def sea(points):
    """Shipping-lane path through [lat, lon] points, as [[lat, lon], ...]."""
    import searoute
    out = []
    for a, b in zip(points, points[1:]):
        if abs(a[0] - b[0]) + abs(a[1] - b[1]) < 0.05:
            continue
        try:
            seg = searoute.searoute([a[1], a[0]], [b[1], b[0]]).geometry["coordinates"]
        except Exception as e:
            print(f"searoute {a}->{b}: {e}", file=sys.stderr)
            seg = [[a[1], a[0]], [b[1], b[0]]]
        pts = [[round(c[1], 3), round(c[0], 3)] for c in seg]
        out.extend(pts[1:] if out else pts)
    return out


def first(*vals):
    return next((v for v in vals if v is not None), None)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.vesselfinder.com/", "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def vesselfinder(mmsi, imo):
    out = {}
    try:
        c = json.loads(get(f"https://www.vesselfinder.com/api/pub/click/{mmsi}"))
        out.update(name=c.get("name"), sog=c.get("ss"), cog=c.get("cu"), dest=c.get("dest"),
                   eta=iso(c["etaTS"]) if c.get("etaTS") else None, time=iso(c["ts"]) if c.get("ts") else None)
    except Exception as e:
        print(f"vesselfinder click {mmsi}: {e}", file=sys.stderr)
    try:
        page = get(f"https://www.vesselfinder.com/vessels/details/{imo}")
        m = re.search(r"data-json='([^']+)'", page)
        if m:
            d = json.loads(m.group(1))
            out.update(lat=d.get("ship_lat"), lon=d.get("ship_lon"))
            out.setdefault("sog", d.get("ship_sog"))
            out.setdefault("cog", d.get("ship_cog"))
        m = re.search(r"Last Port.*?<a[^>]*>([^<]+)</a>", page, re.S)
        if m:
            out["lastPort"] = m.group(1).strip()
    except Exception as e:
        print(f"vesselfinder page {imo}: {e}", file=sys.stderr)
    return out


async def ais_fixes(key, mmsis):
    import websockets
    fixes = {}
    try:
        async with websockets.connect("wss://stream.aisstream.io/v0/stream") as ws:
            await ws.send(json.dumps({"APIKey": key, "BoundingBoxes": [[[-90, -180], [90, 180]]],
                                      "FiltersShipMMSI": mmsis, "FilterMessageTypes": ["PositionReport"]}))
            end = time.time() + LISTEN_S
            while time.time() < end and len(fixes) < len(mmsis):
                try:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - time.time()))
                except asyncio.TimeoutError:
                    break
                if m.get("MessageType") != "PositionReport":
                    continue
                p, meta = m["Message"]["PositionReport"], m.get("MetaData", {})
                t = str(meta.get("time_utc", ""))[:19].replace(" ", "T") + "Z"
                fixes[str(meta["MMSI"])] = {"lat": p["Latitude"], "lon": p["Longitude"], "sog": p["Sog"], "cog": p["Cog"], "time": t}
    except Exception as e:
        print(f"aisstream: {e}", file=sys.stderr)
    return fixes


def main(vessels_path, out_path):
    vessels = json.load(open(vessels_path))
    try:
        prev = json.load(open(out_path)).get("vessels", {})
    except (OSError, ValueError):
        prev = {}
    key = os.environ.get("AISSTREAM_KEY")
    fixes = asyncio.run(ais_fixes(key, [v["mmsi"] for v in vessels.values()])) if key else {}
    result = {}
    for name, v in vessels.items():
        mmsi, imo = v["mmsi"], v["imo"]
        old = prev.get(mmsi, {})
        vf = vesselfinder(mmsi, imo)
        exact = fixes.get(mmsi) or old.get("exact")
        vf_t = epoch(vf.get("time"))
        if exact and (vf.get("lat") is None or epoch(exact["time"]) > vf_t - STALE_EXACT_S):
            pos = dict(exact, approx=False, source="aisstream")
        elif vf.get("lat") is not None:
            pos = {"lat": vf["lat"], "lon": vf["lon"], "time": vf.get("time"), "approx": True, "source": "vesselfinder"}
        else:
            pos = {k: old.get(k) for k in ("lat", "lon", "time", "approx", "source")} if old.get("lat") is not None else None
        rec = {"name": vf.get("name") or name, "mmsi": mmsi, "imo": imo,
               "sog": first((pos or {}).get("sog"), vf.get("sog")),
               "cog": first((pos or {}).get("cog"), vf.get("cog")),
               "dest": vf.get("dest") or old.get("dest"), "eta": vf.get("eta") or old.get("eta"),
               "lastPort": vf.get("lastPort") or old.get("lastPort"),
               "link": f"https://www.vesselfinder.com/vessels/details/{imo}",
               "exact": exact, "track": old.get("track", [])}
        if pos:
            rec.update(lat=pos["lat"], lon=pos["lon"], time=pos["time"], approx=pos["approx"], source=pos["source"])
            pt = [pos["lat"], pos["lon"], pos["time"], 1 if pos["approx"] else 0]
            if not rec["track"] or rec["track"][-1][:2] != pt[:2]:
                rec["track"] = (rec["track"] + [pt])[-TRACK_MAX:]
        if rec.get("lat") is not None:
            fixes_ll = [[t[0], t[1]] for t in rec["track"]]
            rec["path"] = sea(([v["from"]] if v.get("from") else []) + fixes_ll)
            rec["ahead"] = sea([[rec["lat"], rec["lon"]], v["toward"]]) if v.get("toward") else []
        result[mmsi] = rec
        print(f"{name}: {rec.get('source')} {rec.get('lat')},{rec.get('lon')} sog={rec.get('sog')} dest={rec.get('dest')} track={len(rec['track'])}")
    json.dump({"updated": iso(time.time()), "vessels": result}, open(out_path, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:3])
