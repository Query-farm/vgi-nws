#!/usr/bin/env python3
"""Deterministic NWS/NWPS fixtures. No external network access or live timestamps."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from phase2 import gis, water
from phase3 import extension, low_water_fields
from phase4 import land
from phase5 import extension as additional
from phase6 import extension as api_extension, post as post_extension
from phase7 import extension as file_extension
from phase8 import extension as grib_extension

STAMP = '2026-01-02T12:00:00+00:00'
ROOT = 'https://api.weather.gov'
GRID = ROOT + '/gridpoints/LWX/51,26'

def feature(p, geometry=None):
    return {'type': 'Feature', 'properties': p, 'geometry': geometry}

def collection(rows, next_url=None):
    return {'type': 'FeatureCollection', 'features': rows, 'pagination': {'next': next_url} if next_url else {}}

def quantity(value, unit, qc='V'):
    return {'value': value, 'unitCode': 'wmoUnit:' + unit, 'qualityControl': qc}

POINT = feature({'cwa': 'LWX', 'gridId': 'LWX', 'gridX': 51, 'gridY': 26,
    'forecast': GRID + '/forecast', 'forecastHourly': GRID + '/forecast/hourly',
    'forecastGridData': GRID, 'observationStations': GRID + '/stations',
    'forecastZone': ROOT + '/zones/forecast/VAZ037', 'county': ROOT + '/zones/county/VAC540',
    'fireWeatherZone': ROOT + '/zones/fire/VAZ037', 'timeZone': 'America/New_York',
    'radarStation': 'KLWX', 'relativeLocation': feature({'city': 'Charlottesville', 'state': 'VA'})})
STATION = feature({'stationIdentifier': 'KCHO', 'name': 'Charlottesville Airport',
    'elevation': quantity(195, 'm'), 'timeZone': 'America/New_York', 'forecast': ROOT + '/zones/forecast/VAZ037',
    'county': ROOT + '/zones/county/VAC540'}, {'type': 'Point', 'coordinates': [-78.45, 38.14]})

def observation(i):
    return feature({'station': ROOT + '/stations/KCHO', 'timestamp': f'2026-01-02T{12-i:02}:00:00+00:00',
        'textDescription': 'Clear', 'temperature': quantity(9 - i, 'degC'), 'dewpoint': quantity(0, 'degC'),
        'relativeHumidity': quantity(50, 'percent'), 'windDirection': quantity(350, 'degree_(angle)'),
        'windSpeed': quantity(18, 'km_h-1'), 'windGust': quantity(None, 'km_h-1', 'Z'),
        'barometricPressure': quantity(100541, 'Pa'), 'visibility': quantity(16000, 'm'),
        'precipitationLastHour': quantity(None, 'mm', 'Z'), 'rawMessage': 'METAR KCHO fixture', 'cloudLayers': []})

def alert(i):
    return feature({'id': f'urn:oid:test-{i}', 'event': 'Freeze Warning', 'headline': f'Freeze warning {i}',
        'description': 'Sub-freezing temperatures expected.', 'instruction': 'Protect sensitive plants.',
        'severity': 'Severe', 'certainty': 'Likely', 'urgency': 'Expected', 'status': 'Actual',
        'messageType': 'Alert', 'response': 'Execute', 'senderName': 'NWS Wakefield VA', 'areaDesc': 'Albemarle',
        'sent': STAMP, 'effective': STAMP, 'onset': '2026-01-03T00:00:00-05:00',
        'expires': '2026-01-03T12:00:00+00:00', 'ends': None,
        'affectedZones': [ROOT + '/zones/forecast/VAZ037'], 'geocode': {'UGC': ['VAZ037']},
        'parameters': {'VTEC': ['/O.NEW.KAKQ.FZ.W.0004.260103T0500Z-260103T1200Z/']}, 'references': []})
PRODUCT = {'id': 'test-product', 'productCode': 'AFD', 'productName': 'Area Forecast Discussion',
           'issuingOffice': 'KLWX', 'issuanceTime': STAMP, 'wmoCollectiveId': 'FXUS61',
           'productText': 'FXUS61 KLWX\nAFDLWX\n\n.SYNOPSIS...\nCold high pressure.\n$$\n'}
ZONE = feature({'id': 'VAZ037', 'name': 'Albemarle', 'type': 'forecast', 'state': 'VA',
                'cwa': ['LWX'], 'timeZone': ['America/New_York']},
               {'type': 'Polygon', 'coordinates': [[[-79,38],[-78,38],[-78,39],[-79,38]]]})
ASSET = {'officeId': 'LWX', 'title': 'Cold weather briefing', 'description': 'Cold weather',
         'startTime': STAMP, 'endTime': '2026-01-03T12:00:00Z', 'updateTime': STAMP,
         'download': ROOT + '/offices/LWX/briefing/download/latest', 'altText': 'Cold front map', 'priority': 1}
GAUGE = {'lid': 'RMDV2', 'usgsId': '02037500', 'reachId': 8574021,
    'name': 'James River (VA) at Richmond-Westham', 'latitude': 37.563, 'longitude': -77.547,
    'state': {'abbreviation': 'VA'}, 'county': 'Henrico', 'wfo': {'abbreviation': 'AKQ'},
    'rfc': {'abbreviation': 'MARFC'}, 'timeZone': 'EST5EDT', 'status': {},
    'datums': {'vertical': {'value': [{'abbrev': 'NAVD88', 'value': 98.04}]}}, 'dataAttribution': [],
    'flood': {'stageUnits': 'ft', 'flowUnits': 'cfs',
        'categories': {'action': {'stage': 9, 'flow': 22600}, 'minor': {'stage': 12, 'flow': 42000},
                       'moderate': {'stage': 15, 'flow': 66700}, 'major': {'stage': 22, 'flow': 167000}},
        'impacts': [{'stage': 32, 'statement': 'River stage sensor operating limit'}],
        'crests': {'historic': [{'occurredTime': '1972-06-23T00:00:00Z', 'stage': 28.62, 'flow': 313000,
                                'preliminary': 'R', 'olddatum': True}]}}}

def stageflow(kind):
    return {'pedts': 'HGIRG', 'issuedTime': STAMP, 'wfo': 'AKQ', 'timeZone': 'EST5EDT',
            'primaryName': 'Stage', 'primaryUnits': 'ft', 'secondaryName': 'Flow', 'secondaryUnits': 'kcfs',
            'data': [{'validTime': STAMP, 'generatedTime': STAMP, 'primary': 6 if kind == 'observed' else 8,
                      'secondary': 8.96 if kind == 'observed' else None}]}

GAUGE.update(low_water_fields())
GAUGE['flood']['lowWaters'] = {'historic': [{'occurredTime':'2002-09-01T12:00:00Z','stage':-0.5,'flow':12,'statement':'Historic low'}, {'occurredTime':'0001-01-01T00:00:00Z','stage':None,'flow':None,'statement':'Date unavailable'}]}

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    attempts = set()
    def log_message(self, *_):
        pass
    def send(self, status, value, headers=None):
        data = value if isinstance(value, bytes) else value.encode() if isinstance(value, str) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/geo+json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'public, max-age=60')
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        self.send(*post_extension(urlparse(self.path).path, body))
    def do_GET(self):
        path = urlparse(self.path).path
        q = parse_qs(urlparse(self.path).query)
        prefix = path.split('/')[1]
        server = prefix if prefix in ['gis', 'raster', 'tropical', 'event', 'aviation', 'ndbc', 'swpc', 'mrms'] else None
        if server:
            path = path[len(server)+1:] or '/'
        if not self.headers.get('User-Agent'):
            return self.send(400, {'detail': 'Identifying User-Agent required'})
        if os.getenv('MOCK_API_FLAKY') and self.path not in self.attempts:
            self.attempts.add(self.path)
            return self.send(429, {}, {'Retry-After': '0'})
        extra = grib_extension(path, q, server) or file_extension(path, q, server) or api_extension(path, q, server) or additional(path, q, server) or land(path, q) or extension(path, q) or gis(path, q) or water(path, q)
        if extra is not None: return self.send(*extra)
        body = None
        if path.startswith('/points/'): body = POINT
        elif path == '/alerts/types': body = {'eventTypes': ['Freeze Warning', 'Frost Advisory']}
        elif path in ['/alerts', '/alerts/active']:
            if path == '/alerts/active' and 'limit' in q: return self.send(400, {'detail': 'limit is unsupported for active alerts'})
            if q.get('area') == ['CY']: body = collection([alert(1)], ROOT + path + '?area=CY&cursor=cycle')
            elif q.get('area') == ['XF']: body = collection([alert(1)], 'https://untrusted.invalid/alerts')
            elif q.get('area') == ['ZZ']: body = collection([])
            elif q.get('cursor') == ['2']: body = collection([alert(3)])
            else: body = collection([alert(1), alert(2)], ROOT + path + '?cursor=2')
        elif path.startswith('/alerts/'): body = alert(1)
        elif path == '/stations/KCHO/observations/latest': body = observation(0)
        elif path == '/stations/KCHO/observations':
            body = collection([observation(2)]) if q.get('cursor') else collection([observation(0), observation(1)], ROOT + path + '?cursor=2')
        elif path == '/stations/KCHO': body = STATION
        elif path == '/stations': body = collection([], ROOT + '/stations?cursor=empty-again')
        elif path.endswith('/stations') and path.startswith('/gridpoints/'): body = collection([STATION], ROOT + '/stations?cursor=empty')
        elif path.endswith('/forecast') or path.endswith('/forecast/hourly'):
            body = feature({'updateTime': STAMP, 'generatedAt': STAMP, 'periods': [
                {'number': 1, 'name': 'Tonight', 'startTime': STAMP, 'endTime': '2026-01-03T00:00:00Z',
                 'isDaytime': False, 'temperature': 32, 'temperatureUnit': 'F',
                 'probabilityOfPrecipitation': quantity(None, 'percent'), 'windSpeed': '5 to 10 mph',
                 'windDirection': 'N', 'shortForecast': 'Frost', 'detailedForecast': 'Widespread frost.'}]})
        elif path.startswith('/gridpoints/'):
            body = feature({'updateTime': STAMP, 'temperature': {'uom': 'wmoUnit:degC', 'values': [
                {'validTime': '2026-01-02T12:00:00Z/PT2H', 'value': 0},
                {'validTime': '2026-01-02T14:00:00Z/PT1H', 'value': None}]},
                'minTemperature': {'uom': 'wmoUnit:degC', 'values': [{'validTime': '2026-01-02T12:00:00Z/P1D', 'value': -3}]},
                'weather': {'values': [{'validTime': '2026-01-02T12:00:00Z/PT2H', 'value': [{'weather': 'snow'}]}]}})
        elif path == '/products/types': body = {'@graph': [{'productCode': 'AFD', 'productName': 'Area Forecast Discussion'}, {'productCode': 'FWF', 'productName': 'Fire Weather Forecast'}]}
        elif path.endswith('/locations') and path.startswith('/products/types/'): body = {'locations': {'LWX': 'Sterling', 'AKQ': None}}
        elif path.endswith('/latest') and path.startswith('/products/'): body = PRODUCT
        elif '/locations/' in path and path.startswith('/products/'): body = {'@graph': [{k:v for k,v in PRODUCT.items() if k != 'productText'}]}
        elif path == '/products/test-product': body = PRODUCT
        elif path.startswith('/zones/'): body = ZONE if path.count('/') == 3 else collection([ZONE])
        elif path.endswith('/briefing'): body = {'briefing': None if '/ZZZ/' in path else ASSET}
        elif path.endswith('/weatherstories'): body = {'stories': [ASSET]}
        elif path == '/offices/LWX': body = {'id': 'LWX', 'name': 'Sterling', 'sameAs': 'https://www.weather.gov/lwx', 'responsibleCounties': [], 'responsibleForecastZones': []}
        elif path == '/glossary': body = {'glossary': [{'term': 'Frost', 'definition': 'Ice crystals on a surface.'}]}
        elif path == '/gauges/RMDV2': body = GAUGE
        elif path == '/gauges/RMDV2/stageflow': body = {k:stageflow(k) for k in ['observed','forecast']}
        if body is None: return self.send(404, {'detail': 'Fixture not found: ' + path})
        self.send(200, body)

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    print('PORT:' + str(server.server_port), flush=True)
    server.serve_forever()
