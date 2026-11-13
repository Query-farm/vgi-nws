#!/usr/bin/env python3
"""Refresh coarse NWPS query bounds from official NWS state features. No runtime dependency."""
import concurrent.futures
import datetime
import json
from pathlib import Path
import urllib.parse
import urllib.request

URL = 'https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/3'
def get(params):
    request = urllib.request.Request(URL+'/query?'+urllib.parse.urlencode(dict(params,f='json')),headers={'User-Agent':'vgi-nws/0.2.0 (https://query.farm)'})
    with urllib.request.urlopen(request,timeout=30) as response:
        data=json.load(response)
    if 'error' in data: raise RuntimeError(data['error'])
    return data

def extent(feature):
    p=feature['attributes']
    if not str(p['objectid']).isdigit(): raise ValueError('Invalid object ID')
    data=get({'where':f"objectid={p['objectid']}",'outSR':4326,'returnExtentOnly':'true'})['extent']
    return p['state'],[data[k] for k in ['xmin','ymin','xmax','ymax']]

features=get({'where':'1=1','outFields':'objectid,state','returnGeometry':'false'})
if features.get('exceededTransferLimit'): raise RuntimeError('Incomplete state index')
results={}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for state,bounds in pool.map(extent,features['features']):
        results.setdefault(state,[]).append(bounds)
# Alaska's single multipolygon wraps the antimeridian. Split its nearly-global
# envelope into two conservative regions enclosing the Aleutians and mainland.
if 'AK' in results:
    south=min(b[1] for b in results['AK']); north=max(b[3] for b in results['AK'])
    results['AK']=[[-180,south,-129,north],[170,south,180,north]]
header=f'/** NWS state envelopes, retrieved {datetime.date.today().isoformat()}.\n * Source: {URL}\n * Regenerate with python3 scripts/update_state_bounds.py; Alaska is split at the dateline.\n */\nimport type {{ Bounds }} from "./spatial.ts";\n'
target=Path(__file__).resolve().parents[1]/'src/state_bounds.ts'
target.write_text(header+'export const STATE_BOUNDS: Record<string, Bounds[]> = '+json.dumps(results,indent=2,sort_keys=True)+';\n')
print(f'Wrote {len(results)} state/territory bounds to {target}')
