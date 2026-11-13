"""Strict RFC raster, rating-table and National Water Model fixtures."""
from phase2 import STAMP

PERIODS = ['Since 12Z','Last 1 Hours','Last 2 Hours','Last 3 Hours','Last 6 Hours','Last 12 Hours','Last 24 Hours',"Today's Analysis"] + [f'Last {d} Days' for d in [2,3,4,5,6,7,10,14,30,60,90,120,180,365]] + ['Month to Date','Year to Date','Water Year to Date']
LAYERS=[]
for i, name in enumerate(PERIODS):
    parent=300+i*4
    LAYERS += [dict(id=parent,name=name+' Observed (inches)',type='Mosaic Layer'),dict(id=parent+1,name='Image',type='Raster Layer',parentLayerId=parent),dict(id=parent+2,name='Footprint',type='Feature Layer',parentLayerId=parent)]
SERIES = {'analysis_assimilation':'analysisAssimilation','short_range':'shortRange','medium_range':'mediumRange','long_range':'longRange','medium_range_blend':'mediumRangeBlend'}

def low_water_fields():
    return {'lowThreshold':{'value':-1.0,'units':'ft'},'impactsLowWaters':[{'value':'Below -1 ft','impact':'Intake exposure'},{'value':'Unknown','impact':'Original text retained'}]}

def extension(path,q):
    one=lambda key,default='':q.get(key,[default])[0]
    root='/obs/rfc_qpe/MapServer'
    if path==root:
        if one('f')!='json':return 400,{'detail':'Expected json metadata'}
        return 200,{'layers':LAYERS}
    if path==root+'/identify':
        required={'f':'json','geometryType':'esriGeometryPoint','sr':'4326','tolerance':'0','returnGeometry':'false','imageDisplay':'100,100,96'}
        if any(one(k)!=v for k,v in required.items()):return 400,{'detail':'Bad raster identify contract'}
        try:
            layer=int(one('layers').split(':')[1]);lon,lat=map(float,one('geometry').split(','))
            assert any(l['id']==layer and l['type']=='Raster Layer' for l in LAYERS)
            w,s,e,n=map(float,one('mapExtent').split(','));assert w<=lon<=e and s<=lat<=n
        except (ValueError,IndexError,AssertionError):return 400,{'detail':'Invalid raster layer or point'}
        if lat==0:return 200,{'results':[]}
        if lat==10:return 200,{'error':{'code':500,'message':'Raster failure'}}
        attrs={'Service Pixel Value':'NoData' if lat==40 else '0' if lat==41 else '1.25','Classify.Class value':'14','objectid':'700','name':'qpe_fixture'}
        if lat==42:attrs.pop('Service Pixel Value')
        if lat==43:attrs['objectid']='701'
        return 200,{'results':[{'layerId':layer,'layerName':'Image','attributes':attrs}]}
    if path.startswith(root+'/') and path.endswith('/query'):
        layer=int(path.split('/')[-2])
        if not any(l['id']==layer and l['name']=='Footprint' for l in LAYERS) or one('returnGeometry')!='false' or one('outFields')!='*':return 400,{'detail':'Invalid footprint query'}
        if one('objectIds')=='701':return 200,{'features':[]}
        if one('objectIds')!='700':return 400,{'detail':'Use identify object IDs for metadata'}
        return 200,{'features':[{'attributes':{'objectid':700,'name':'qpe_fixture','idp_issueddate':STAMP,'idp_filedate':STAMP+1000,'idp_ingestdate':STAMP+2000}}]}
    if path=='/gauges/EMPTY':return 200,{'lid':'EMPTY','lowThreshold':None,'impactsLowWaters':[],'flood':{'lowWaters':{'historic':[]}}}
    if path.endswith('/ratings'):
        if path not in ['/gauges/RMDV2/ratings','/gauges/EMPTY/ratings']:return 404,{'detail':'Unknown gauge'}
        try:
            limit=int(one('limit'));assert 1<=limit<=10000
            assert one('sort') in ['ASC','DESC'] and one('onlyTenths') in ['true','false']
        except (ValueError,AssertionError):return 400,{'detail':'Invalid rating parameters'}
        rows=[{'stage':-0.5,'flow':0},{'stage':0.01,'flow':2},{'stage':0.1,'flow':5}]
        if one('onlyTenths')=='true':rows=[rows[0],rows[2]]
        if one('sort')=='DESC':rows=rows[::-1]
        return 200,{'stageUnits':'ft','flowUnits':'cfs','data':rows[:limit] if 'EMPTY' not in path else []}
    if path.startswith('/reaches/'):
        rid=path.split('/')[2]
        if rid not in ['23021904','8574021','999']:return 404,{'detail':'Unknown reach'}
        reach={'reachId':rid,'name':'Deep Creek','latitude':47.6982,'longitude':-117.497,'streamflow':list(SERIES),'route':{'upstream':[{'reachId':'23021906','streamOrder':'7'}],'downstream':[{'reachId':'23022058','streamOrder':'7'}]}}
        if not path.endswith('/streamflow'):return 200,reach
        selected=one('series')
        if selected not in SERIES:return 400,{'detail':'Invalid model series'}
        result={key:{} for key in SERIES.values()};result['reach']=reach
        if rid=='999':return 200,result
        for i, member in enumerate(['mean','member1','member2'] if selected=='long_range' else ['series']):
            result[SERIES[selected]][member]={'referenceTime':'2026-01-02T12:00:00Z','units':'ft³/s','data':[{'validTime':'2026-01-02T13:00:00Z','flow':100+i*10},{'validTime':'2026-01-02T14:00:00Z','flow':None}]}
        return 200,result
    return None
