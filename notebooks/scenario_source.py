"""Isolated synthetic NOAA-shaped HTTP inputs; no forwarding or real account access."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOTS = {
    "NWS_API_BASE_URL": "weather",
    "NWPS_API_BASE_URL": "water",
    "NWS_GIS_BASE_URL": "gis",
    "NWS_RASTER_BASE_URL": "raster",
    "NWS_TROPICAL_BASE_URL": "tropical",
    "NWS_EVENT_BASE_URL": "event",
    "NWS_AVIATION_BASE_URL": "aviation",
    "NWS_NDBC_BASE_URL": "ndbc",
    "NWS_SWPC_BASE_URL": "swpc",
    "NWS_MRMS_BASE_URL": "mrms",
}


def collection(rows, next_url=None):
    return {
        "type": "FeatureCollection",
        "features": rows,
        "pagination": {"next": next_url} if next_url else {},
    }


class ScenarioSource:
    """Serve bounded, explicit teaching payloads on loopback; restore environment on close."""

    def __init__(self):
        folder = Path(__file__).parent / "synthetic"
        body = (folder / "scenario.json").read_bytes()
        manifest = json.loads((folder / "manifest.json").read_text())
        if hashlib.sha256(body).hexdigest() != manifest["scenario_sha256"]:
            raise ValueError("Synthetic scenario checksum mismatch")
        self.data = json.loads(body)
        self.requests = []
        self.closed = False
        self.previous = {key: os.environ.pop(key, None) for key in [*ROOTS, "NWS_USER_AGENT"]}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, method):
                u = urlsplit(self.path)
                payload = None
                if method == "POST":
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size < 1024:
                        self.send_error(400, "Synthetic read-only request size rejected")
                        return
                    payload = json.loads(self.rfile.read(size))
                try:
                    value = owner.route(method, unquote(u.path), parse_qs(u.query), payload)
                    status = 200
                except (ValueError, KeyError, AssertionError, StopIteration):
                    status, value = 400, {"detail": "Outside synthetic scenario; no network fallback"}
                owner.requests.append(
                    {"method": method, "path": u.path, "query": parse_qs(u.query), "status": status}
                )
                encoded = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.send_header("Cache-Control", "public, max-age=3600")
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                self.respond("GET")

            def do_POST(self):
                self.respond("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = f"http://127.0.0.1:{self.server.server_port}"
        os.environ.update({key: base + "/" + service for key, service in ROOTS.items()})
        os.environ["NWS_USER_AGENT"] = "Query.Farm synthetic notebook (https://query.farm)"

    def route(self, method, path, q, payload):
        d = self.data

        def one(k, default=""):
            return q.get(k, [default])[0]

        if method == "POST":
            if path != "/water/gauges/raag" or payload != {"rivers": ["RMDV2"]}:
                raise ValueError("Only the synthetic read-only river summary is supported")
            return d["raag"]
        if path == "/weather/points/38.0293,-78.4767":
            assert not q
            return d["point"]
        if path == "/weather/gridpoints/LWX/51,26/stations":
            return collection(d["stations"])
        if path in [
            "/weather/gridpoints/LWX/51,26/forecast",
            "/weather/gridpoints/LWX/51,26/forecast/hourly",
        ]:
            return d["forecasts"]["hourly" if path.endswith("hourly") else "period"]
        match = re.fullmatch(r"/weather/stations/(KCHO|KEXA)(/observations(?:/latest)?)?", path)
        if match:
            code, suffix = match.groups()
            if suffix is None:
                return next(s for s in d["stations"] if s["properties"]["stationIdentifier"] == code)
            rows = list(reversed(d["observations"][code]))
            if suffix.endswith("latest"):
                return rows[0]
            assert set(q) <= {"limit", "start", "end", "cursor"}
            size = int(one("limit", "500"))
            assert 1 <= size <= 500
            offset = int(one("cursor", "0"))
            chosen = rows[offset : offset + size]
            next_url = None
            if offset + size < len(rows):
                next_url = (
                    f"https://api.weather.gov/stations/{code}/observations?limit={size}"
                    f"&cursor={offset + size}"
                )
            return collection(chosen, next_url)
        if path == "/weather/zones/forecast":
            assert q == {"area": ["VA"]}
            return collection([d["zone_index"]])
        if path == "/weather/zones/forecast/VAZ037":
            return d["zone"]
        if path == "/weather/offices/LWX":
            return d["office"]
        if path == "/weather/glossary":
            return {"glossary": d["glossary"]}
        if path == "/weather/alerts/types":
            return {"eventTypes": ["Freeze Warning", "Frost Advisory"]}
        if path in ["/weather/alerts", "/weather/alerts/active"]:
            assert set(q) <= {"area", "point", "event", "limit", "start", "end"}
            rows = d["alerts"][:2] if "point" in q else d["alerts"]
            if "point" in q:
                assert one("point") == "38.0293,-78.4767"
            if "area" in q:
                assert one("area") == "VA"
            if one("event"):
                rows = [r for r in rows if r["properties"]["event"] == one("event")]
            return collection(rows)
        if path.startswith("/weather/alerts/urn:oid:synthetic-"):
            return next(a for a in d["alerts"] if path.endswith(a["properties"]["id"]))
        if path == "/weather/products/types":
            return {
                "@graph": [
                    {"productCode": "AFD", "productName": "Area Forecast Discussion"},
                    {"productCode": "HWO", "productName": "Hazardous Weather Outlook"},
                ]
            }
        if path == "/weather/products/types/AFD/locations":
            return {"locations": {"LWX": "Synthetic office label", "AKQ": None}}
        if path == "/weather/products/types/AFD/locations/LWX":
            return {"@graph": [{k: v for k, v in row.items() if k != "productText"} for row in d["products"]]}
        if path == "/weather/products/types/AFD/locations/LWX/latest":
            return d["products"][-1]
        if path.startswith("/weather/products/synthetic-afd-"):
            return next(p for p in d["products"] if path.endswith(p["id"]))
        if path == "/weather/offices/LWX/briefing":
            return {"briefing": d["briefing"]}
        if path == "/weather/offices/LWX/weatherstories":
            return {"stories": [d["story"]]}
        if path == "/water/gauges":
            assert set(q) == {"bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax", "srid"}
            assert one("srid") == "EPSG_4326"
            w, s, e, n = [float(one(k)) for k in ["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"]]
            assert w < e and s < n and e - w <= 20.000001 and n - s <= 20.000001
            return {
                "gauges": [g for g in d["gauges"] if w <= g["longitude"] <= e and s <= g["latitude"] <= n]
            }
        if path == "/water/gauges/RMDV2":
            return d["gauge"]
        if path == "/water/gauges/RMDV2/stageflow":
            return d["stageflow"]
        if path == "/water/gauges/RMDV2/riverflow":
            return d["network"]
        if path == "/water/gauges/RMDV2/ratings":
            assert set(q) == {"limit", "sort", "onlyTenths"}
            limit = int(one("limit"))
            assert (
                1 <= limit <= 10000
                and one("sort") in ["ASC", "DESC"]
                and one("onlyTenths") in ["true", "false"]
            )
            body = copy.deepcopy(d["rating"])
            if one("sort") == "DESC":
                body["data"].reverse()
            body["data"] = body["data"][:limit]
            return body
        if path == "/water/reaches/8574021":
            return d["reach"]
        if path == "/water/reaches/8574021/streamflow":
            assert q == {"series": ["long_range"]}
            return d["model"]
        if path == "/gis/outlooks":
            assert q == {"f": ["json"]}
            return {
                "services": [
                    {"name": s.removesuffix("/MapServer"), "type": "MapServer"}
                    for s in d["services"]
                    if s.startswith("outlooks/")
                ]
            }
        if path.startswith("/gis/"):
            return self.map_route(path[5:], q)
        raise ValueError("Unknown synthetic route")

    def map_route(self, path, q):
        def one(k, default=""):
            return q.get(k, [default])[0]

        services = self.data["services"]
        if path in services:
            assert q == {"f": ["json"]}
            service = services[path]
            return {
                "maxRecordCount": 2,
                "serviceDescription": "Synthetic teaching polygons; not current hazards",
                "layers": [
                    {
                        "id": 101,
                        "name": service["label"],
                        "type": "Feature Layer",
                        "parentLayerId": -1,
                        "geometryType": "esriGeometryPolygon",
                    }
                ],
            }
        match = re.fullmatch(r"(.+/MapServer)/101(/query)?", path)
        if not match or match[1] not in services:
            raise ValueError("Unknown synthetic map layer")
        service = services[match[1]]
        if match[2] is None:
            assert q == {"f": ["json"]}
            return {"id": 101, "name": service["label"], "type": "Feature Layer", "fields": service["fields"]}
        required = {
            "f": "geojson",
            "outFields": "*",
            "orderByFields": "objectid ASC",
            "outSR": "4326",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
        }
        assert all(one(k) == v for k, v in required.items())
        assert one("returnGeometry") in ["true", "false"]
        where = one("where")
        assert where == "1=1" or re.fullmatch(r"objectid > \d+", where)
        after = 0 if where == "1=1" else int(where.split(">")[1])
        size = int(one("resultRecordCount"))
        assert 1 <= size <= 2
        g = json.loads(one("geometry", "null"))
        if g:
            assert g["spatialReference"] == {"wkid": 4326}

        def intersects(row):
            if g is None:
                return True
            rects = service["rectangles"][str(row["id"])]
            if one("geometryType") == "esriGeometryPoint":
                return any(w <= g["x"] <= e and s <= g["y"] <= n for w, s, e, n in rects)
            assert one("geometryType") == "esriGeometryEnvelope"
            return any(
                w <= g["xmax"] and e >= g["xmin"] and s <= g["ymax"] and n >= g["ymin"]
                for w, s, e, n in rects
            )

        rows = [copy.deepcopy(row) for row in service["features"] if row["id"] > after and intersects(row)]
        chosen = rows[:size]
        for row in chosen:
            if one("returnGeometry") == "false":
                row["geometry"] = None
        return {
            "type": "FeatureCollection",
            "features": chosen,
            "properties": {"exceededTransferLimit": len(rows) > size},
        }

    def audit(self):
        if not self.requests or any(r["status"] != 200 for r in self.requests):
            raise AssertionError("Synthetic request audit failed")
        return list(self.requests)

    def close(self):
        if self.closed:
            return
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.closed = True
