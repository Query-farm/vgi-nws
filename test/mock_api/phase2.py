"""NWS GIS and NWPS discovery fixtures with strict spatial and paging contracts."""
import json
import re

STAMP = 1767355200000  # 2026-01-02T12:00:00Z
SERVICES = {}
def register(service, names):
    # Deliberately different IDs from production: callers must resolve layer names.
    SERVICES[service] = {101+i: name for i,name in enumerate(names)}
register('outlooks/SPC_wx_outlks/MapServer',
         [f'Day {d} Categorical Outlook' for d in range(1,4)] +
         [f'Day {d} Probabilistic {h} Outlook' for d in [1,2] for h in ['Tornado','Hail','Wind']] +
         [f'Day {d} Probabilistic Outlook' for d in range(3,9)])
register('fire_weather/SPC_firewx/MapServer', [f'Day {d} Outlook{h}' for d in [1,2] for h in ['', ' Dry Thunderstorm']] + [f'Day {d} {h}' for d in range(3,9) for h in ['Dry Thunderstorm','Winds and Low Humidity']])
register('hazards/wpc_precip_hazards/MapServer', [f'Excessive Rainfall Day {d}' for d in range(1,6)])
register('precip/wpc_qpf/MapServer', ['QPF 24 Hour Day 1','QPF 24 Hour Day 2','QPF 24 Hour Day 3','QPF 48 Hour Day 4-5','QPF 48 Hour Day 6-7','QPF 48 Hour Day 1-2','QPF 72 Hour Day 1-3','QPF 120 Hour Day 1-5','QPF 168 Hour Day 1-7'])
for period,title in [('6_10','6-10'),('8_14','8-14')]:
    register(f'outlooks/cpc_{period}_day_outlk/MapServer', [f'CPC {title} Day {v} Outlook' for v in ['Temperature','Precipitation']])
register('outlooks/cpc_drought_outlk/MapServer', [f'{p} Drought Outlook For US and Puerto Rico' for p in ['Monthly','Seasonal']])

for v, title in [('temp','Temperature'),('precip','Precipitation')]:
    register(f'outlooks/cpc_mthly_{v}_outlk/MapServer', [f'Monthly {title} Outlook'])
    register(f'outlooks/cpc_sea_{v}_outlk/MapServer', [f'Lead {i}' for i in range(1,14)])
register('precip/wpc_prob_winter_precip/MapServer', [f'Day {d} probability of at least {t} inches of snow' for d in range(1,4) for t in [4,8,12]] + [f'Day {d} probability of icing >0.25 inches' for d in range(1,4)])
register('outlooks/wpc_wssi/MapServer', [f'{c}_{p}' for c in ['Overall_Impact','Snow_Amount','Snow_Load','Ice_Accumulation','Blowing_Snow'] for p in ['Day_1','Day_2','Day_3','Days_1-3']])

RECTS = {1: [(-80,36,-76,40)], 2: [(-79,37,-77,39)], 3: [(178,9,180,11),(-180,9,-178,11)]}
def polygon(rect):
    w,s,e,n = rect
    return [[w,s],[e,s],[e,n],[w,n],[w,s]]
def geometry(i):
    rings = [[polygon(r)] for r in RECTS[i]]
    return {'type': 'MultiPolygon', 'coordinates': rings}
def properties(service, name, i):
    p = dict(objectid=i, idp_filedate=STAMP, idp_ingestdate=STAMP+1000, idp_source='fixture')
    if 'SPC_wx' in service:
        p.update(dn=([2,3,4] if 'Categorical' in name else [5,10,15])[i-1], label=['TSTM','MRGL','SLGT'][i-1], label2=['General Thunderstorms Risk','Marginal Risk','Slight Risk'][i-1], issue='202601021130', valid='202601021200', expire='202601031200')
    elif 'SPC_fire' in service:
        p.update(dn=[5,8,0][i-1], valid='202601021200', expire='202601031200')
        if 'Outlook' not in name: p.update(dn=[0.4,0.7,0][i-1],issue='202601011930',label=['40%','70%','Probability Too Low'][i-1],label2=' ')
    elif 'wpc_prob_winter' in service:
        p.update(dn=i,product=name.replace('at least','greater than'),outlook=['Slight (10-39%)','Moderate (40-69%)','High (70-100%)'][i-1],issue_time='2026-01-02 11:00:00',start_time='2026-01-02 12:00:00',end_time='2026-01-03 12:00:00')
    elif 'wpc_wssi' in service:
        p.update(product='WINTER STORM SEVERITY INDEX',component='WSSI_OVERALL',impact=['WINTER WEATHER AREA','MINOR','MAJOR'][i-1],issue_time='2025-12-31 2316Z',start_time='00Z 01/01/26',end_time='00Z 01/04/26')
    elif 'wpc_precip' in service:
        p.update(dn=[5,10,15][i-1], outlook=['Marginal','Slight','Moderate'][i-1], snippet='Original risk explanation', issue_time='2026-01-02 11:00:00', start_time='2026-01-02 12:00:00', end_time='2026-01-03 12:00:00')
    elif 'wpc_qpf' in service:
        p.update(product='24-hour QPF', qpf=[0.1,1,2][i-1], units='Inches', issue_time='2026-01-02 11:00:00', start_time='2026-01-02 12:00:00', end_time='2026-01-03 12:00:00')
    elif 'drought' in service:
        p.update(outlook=['Improvement','Persistence','Development'][i-1], fcst_date='01/02/2026', target='Jan 2026' if 'Monthly' in name else 'March 31')
    elif 'mthly' in service or 'cpc_sea_' in service:
        p.update(cat=['Above','Below','EC'][i-1],prob=[40,50,33][i-1],fcst_date=STAMP-43200000,valid_seas='Feb 2026' if 'mthly' in service else f'NDJ 2026-2027 ({name})')
    else:
        p.update(cat=['Above','Below','Normal'][i-1], prob=[40,50,36][i-1], fcst_date=STAMP-43200000, start_date=STAMP+7*86400000, end_date=STAMP+13*86400000)
    return p

def gis(path, q):
    key = path.lstrip('/')
    one = lambda name, default='': q.get(name,[default])[0]
    if key in SERVICES:
        if one('f') != 'json': return 400, {'detail':'metadata format must be json'}
        return 200, {'maxRecordCount':2, 'layers': [{'id':i,'name':n,'type':'Feature Layer'} for i,n in SERVICES[key].items()]}
    match = re.fullmatch(r'(.+/MapServer)/(\d+)/query',key)
    if not match or match[1] not in SERVICES: return None
    service, layer_id = match[1], int(match[2])
    name = SERVICES[service].get(layer_id)
    if not name: return 200, {'error':{'code':400,'message':'Layer ID does not exist'}}
    required = {'f':'geojson','outFields':'*','orderByFields':'objectid ASC','outSR':'4326','inSR':'4326','spatialRel':'esriSpatialRelIntersects'}
    if any(one(k)!=v for k,v in required.items()): return 400, {'detail':'Missing GIS query contract'}
    if one('returnGeometry') not in ['true','false']: return 400, {'detail':'returnGeometry must be explicit'}
    where = one('where')
    if where != '1=1' and not re.fullmatch(r'objectid > \d+',where): return 400, {'detail':'Invalid generated predicate'}
    after = 0 if where=='1=1' else int(where.split('>')[1])
    size = int(one('resultRecordCount','0'))
    if not 1 <= size <= 2: return 400, {'detail':'Service maxRecordCount exceeded'}
    g = json.loads(one('geometry','null'))
    marker = None
    if g is not None:
        if g.get('spatialReference',{}).get('wkid') != 4326: return 400, {'detail':'Input geometry must be WGS84'}
        marker = g.get('xmin')
        if marker == 10: return 200, {'error':{'code':498,'message':'Fixture GIS application error'}}
        if marker == 30: return 200, {'type':'FeatureCollection','features':[], 'exceededTransferLimit':True}
    def intersects(i):
        if g is None or marker in [20,40]: return True
        if one('geometryType') == 'esriGeometryPoint': return any(w<=g['x']<=e and s<=g['y']<=n for w,s,e,n in RECTS[i])
        if one('geometryType') == 'esriGeometryEnvelope': return any(w<=g['xmax'] and e>=g['xmin'] and s<=g['ymax'] and n>=g['ymin'] for w,s,e,n in RECTS[i])
        raise ValueError('Invalid geometry type')
    ids = [i for i in RECTS if (i>after or marker==20) and intersects(i)]
    chosen = ids[:size]
    features=[]
    for i in chosen:
        p=properties(service,name,i)
        if marker==40 and after: p['idp_filedate']+=1000
        features.append({'type':'Feature','id':i,'properties':p,'geometry':geometry(i) if one('returnGeometry')=='true' else None})
    return 200, {'type':'FeatureCollection','features':features,'properties':{'exceededTransferLimit':len(ids)>size}}

GAUGES = [
    ('RMDV2','Richmond-Westham',37.563,-77.547,'VA'),
    ('NEARV2','Nearby gauge',37.8,-77.4,'VA'),
    ('CORNV2','Outside radius inside bbox',37.96,-76.94,'VA'),
    ('EDGEV2','Internal tile boundary',37.5,-80,'VA'),
    ('TESTN2','Different state',37.54,-77.43,'NC'),
    ('DATE','East dateline',10,179.9,'MP'),
    ('DATW','West dateline',10,-179.9,'MP'),
    ('POLAR','Polar gauge',89.9,45,'AK'),
]
def water(path,q):
    if path == '/gauges':
        try:
            assert q['srid']==['EPSG_4326']
            w,s,e,n=[float(q[k][0]) for k in ['bbox.xmin','bbox.ymin','bbox.xmax','bbox.ymax']]
            assert w<e and s<n and e-w<=20.000001 and n-s<=20.000001
        except (KeyError,ValueError,AssertionError): return 400, {'detail':'Gauges must be requested in bounded WGS84 tiles'}
        gauges=[]
        for lid,name,lat,lon,state in GAUGES:
            if w<=lon<=e and s<=lat<=n:
                gauges.append(dict(lid=lid,name=name,latitude=lat,longitude=lon,state={'abbreviation':state},rfc={'abbreviation':'MARFC'},wfo={'abbreviation':'AKQ'},status={'observed':{'floodCategory':'no_flooding','validTime':'2026-01-02T12:00:00Z'},'forecast':{'floodCategory':'fcst_not_current','primary':-999,'validTime':'0001-01-01T00:00:00Z'}}))
        return 200, {'gauges':gauges}
    if path == '/gauges/RMDV2/riverflow':
        return 200, {'startingPoint':{'LID':'RMDV2','Name':'Richmond-Westham'},'upstream':[{'LID':'SVEV2','Name':'Scottsville'},{'LID':'CARV2','Name':'Cartersville'}],'downstream':[{'LID':'RICV2','Name':'Richmond Locks'}]}
    return None
