"""Land rasters and point storm reports: native units, NoData and strict pagination."""
import json
import re
from phase2 import STAMP
from phase3 import LAYERS as QPE_LAYERS

SOIL='/obs/NWM_Land_Analysis/MapServer'
SNOW='/snow/NOHRSC_Snow_Analysis/MapServer'
QPE='/obs/rfc_qpe/MapServer'
STORM='/obs/nws_local_storm_reports/MapServer'
SPECS={}
HITS={}
def register(service,group,name,value,**extra):
    SPECS[(service,group+1)]={'parent':group,'image':group+1,'footprint':group+2,'name':name,'value':value,**extra}
for i,(key,title,value) in enumerate([('conus','CONUS',.625),('alaska','Alaska',.8),('hawaii','Hawaii',.75),('puerto_rico','Puerto Rico',.9)]):
    register(SOIL,700+i*4,title+' Near-Surface Soil Moisture (% saturation) ',value,region=key)
register(SNOW,800,'Snow Depth',.25,variable='depth')
register(SNOW,804,'Snow Water Equivalent',45,variable='water_equivalent')
periods=["Today's"]+[f'Last {d} Days' for d in [7,10,14,30,60,90,120,180,365]]+['Month to Date','Year to Date','Water Year to Date']
for i,period in enumerate(periods):
    for j,(name,value) in enumerate([('Normal (inches)',2),('Departure from Normal (inches)',-1.25),('Percent of Normal (%)',37.5)]):
        register(QPE,900+(i*3+j)*4,f'{period} {name} ',value,metric=j)

def layer_list(service):
    result=[]
    for (s,_),r in SPECS.items():
        if s!=service:continue
        result += [dict(id=r['parent'],name=r['name'],type='Mosaic Layer'),dict(id=r['image'],name='Image',type='Raster Layer',parentLayerId=r['parent']),dict(id=r['footprint'],name='Footprint',type='Feature Layer',parentLayerId=r['parent'])]
    return result

def land(path,q):
    one=lambda k,default='':q.get(k,[default])[0]
    if path in [SOIL,SNOW,QPE]:
        if one('f')!='json':return 400,{'detail':'Expected json metadata'}
        return 200,{'layers':(QPE_LAYERS if path==QPE else [])+layer_list(path)}
    if path.endswith('/identify') and path[:-9] in [SOIL,SNOW,QPE]:
        service=path[:-9]
        if not one('layers').startswith('all:'):return 400,{'detail':'Specify raster layers'}
        images=[int(x) for x in one('layers')[4:].split(',')]
        if service==QPE and all(i<900 for i in images):return None
        required={'f':'json','geometryType':'esriGeometryPoint','sr':'4326','tolerance':'0','returnGeometry':'false','imageDisplay':'100,100,96'}
        if any(one(k)!=v for k,v in required.items()):return 400,{'detail':'Invalid identify contract'}
        lon,lat=map(float,one('geometry').split(','))
        key=(service,one('geometry'));HITS[key]=HITS.get(key,0)+1
        w,s,e,n=map(float,one('mapExtent').split(','))
        if not w<=lon<=e or not s<=lat<=n:return 400,{'detail':'Bad map extent'}
        if lat==44:return 200,{'error':{'code':500,'message':'Raster source failure'}}
        if lat==45:return 200,{'status':'error','messages':['Could not access server']}
        if lat==46 and HITS[key]==1:return 200,{'status':'error','messages':['Could not access server']}
        results=[]
        for image in images:
            r=SPECS.get((service,image))
            if r is None:return 400,{'detail':'Resolve image layer by name'}
            covered=lon<0
            if service==SOIL:
                covered={'conus':24<=lat<=50 and -125<=lon<=-65,'alaska':lat>50 and lon<-120,'hawaii':18<=lat<=23 and -161<=lon<=-154,'puerto_rico':17<=lat<=19 and -68<=lon<=-65}[r['region']]
            if not covered:
                results.append({'layerId':image,'attributes':{'Service Pixel Value':'NoData'}});continue
            value='NoData' if lat==40 else '0' if lat==41 else 'broken' if lat==42 else str(r['value'])
            attrs={'Service Pixel Value':value,'Classify.Class value':'99','objectid':str(image*10+(1 if lat==43 else 0)),'name':f'raster_{image}'}
            results.append({'layerId':image,'attributes':attrs})
        return 200,{'results':results}
    match=re.fullmatch(r'(.+/MapServer)/(\d+)/query',path)
    if match and match[1] in [SOIL,SNOW,QPE]:
        service,layer=match[1],int(match[2]);spec=next((r for (s,_),r in SPECS.items() if s==service and r['footprint']==layer),None)
        if spec is None:return None
        if one('f')!='json' or one('returnGeometry')!='false' or one('outFields')!='*':return 400,{'detail':'Bad footprint query'}
        oid=spec['image']*10
        ids=[int(x) for x in one('objectIds').split(',')]
        if oid not in ids:return 200,{'features':[]}
        valid=STAMP+(3600000 if spec.get('variable')=='water_equivalent' else 0)
        return 200,{'features':[{'attributes':{'objectid':oid,'name':f'raster_{spec["image"]}','idp_validtime':valid if service!=QPE else None,'idp_issueddate':STAMP-3600000,'idp_filedate':STAMP+1000,'idp_ingestdate':STAMP+2000}}]}
    return storm(path,q)

# Duplicate underlying events with different IDs remain separate reports.
REPORTS=[(1,38,-78,'VA','Hail','1.25','Inch'),(2,38.1,-78,'VA','Thunderstorm Wind','E60','MPH'),(3,38.4,-77.5,'VA','Hail','0','Inch'),(4,10,179.9,'MP','Hail','0.75','Inch'),(5,10,-179.9,'MP','Rain','Trace','Inch'),(6,38,-78,'NC','Rain','0','Inch'),(7,89.9,45,'AK','Snow','2.0','Inch'),(8,38,-78,'VA','Hail','1.25','Inch')]
def storm(path,q):
    one=lambda k,default='':q.get(k,[default])[0]
    layers={205:'Last_24_Hours',310:'Last_48_Hours',415:'Last_72_Hours'}
    if path==STORM:return 200,{'maxRecordCount':2,'layers':[{'id':i,'name':n,'type':'Feature Layer'} for i,n in layers.items()]}
    match=re.fullmatch(re.escape(STORM)+r'/(\d+)/query',path)
    if not match:return None
    if int(match[1]) not in layers:return 400,{'detail':'Resolve report layer by name'}
    required={'f':'geojson','outFields':'*','orderByFields':'objectid ASC','outSR':'4326','inSR':'4326','spatialRel':'esriSpatialRelIntersects','returnGeometry':'true'}
    if any(one(k)!=v for k,v in required.items()):return 400,{'detail':'Bad report query contract'}
    where=one('where');size=int(one('resultRecordCount'))
    if where!='1=1' and not re.fullmatch(r'objectid > \d+',where):return 400,{'detail':'Bad pagination predicate'}
    if not 1<=size<=2:return 400,{'detail':'Respect page size cap'}
    after=0 if where=='1=1' else int(where.split('>')[1])
    box=json.loads(one('geometry','null'))
    if box is not None:
        if one('geometryType')!='esriGeometryEnvelope' or box['spatialReference']['wkid']!=4326:return 400,{'detail':'Expected WGS84 bbox'}
        if box['xmin']==10:return 200,{'error':{'code':498,'message':'Report source error'}}
    def fits(r):return box is None or (box['xmin']<=r[2]<=box['xmax'] and box['ymin']<=r[1]<=box['ymax'])
    selected=[r for r in REPORTS if r[0]>after and fits(r)]
    features=[]
    for oid,lat,lon,state,event,mag,unit in selected[:size]:
        features.append({'type':'Feature','id':oid,'properties':{'objectid':oid,'wfo_id':'LWX','wfo':'Baltimore/Washington','lsr_validtime':STAMP,'descript':event,'loc_desc':f'Fixture {oid}','state':state,'magnitude':mag,'units':unit,'remarks':'Original report','idp_filedate':STAMP+1000,'idp_ingestdate':STAMP+2000},'geometry':{'type':'Point','coordinates':[lon,lat]}})
    return 200,{'type':'FeatureCollection','features':features,'exceededTransferLimit':len(selected)>size}
