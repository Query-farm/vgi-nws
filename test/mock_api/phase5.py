"""Strict fixtures for discovered GIS products, hazard outlooks and image catalogs."""
import json
import re
from phase2 import STAMP

MCD='/outlooks/spc_mesoscale_discussion/MapServer'
HAZARDS='/hazards/cpc_weather_hazards/MapServer'
WINTER='/outlooks/wpc_wssi_p/MapServer'
FLOOD='/outlooks/sig_riv_fld_outlk/MapServer'
LONG='/outlooks/long_range_flood_outlook/MapServer'
BEACH='/outlooks/marine_beachforecast_summary/MapServer'
FFG='/precip/rfc_gridded_ffg/MapServer'
TROPICAL='/tropical/NHC_tropical_weather_summary/MapServer'
SERVICES={MCD:{0:'SPC Mesoscale Discussion'},HAZARDS:{101:'3-7 Day Temperature Outlook',103:'8-14 Day Temperature Outlook',104:'3-7 Day Precipitation Outlook',106:'8-14 Day Precipitation Outlook',107:'3-7 Day WildFire/Drought',108:'8-14 Day Wildfire/Drought'},FLOOD:{50:'Flood Outlook'},LONG:{300+i:f'Long_Range_Flood_Outlook_3_Months_{t}_Percent' for i,t in enumerate([5,10,25,50,75,90,95])},BEACH:{401:'Beach Forecast Day 1',402:'Beach Forecast Day 2'},TROPICAL:{99:'Forecast Points',100:'Forecast Cone'}}
SERVICES[WINTER]={500+i*5+j:f'{c}_{impact}_Impacts' for i,c in enumerate(['Overall_Winter_Storms','Snow_Amount','Snow_Load','Ice','Blowing_Snow']) for j,impact in enumerate(['WWA','Minor','Moderate','Major','Extreme'])}
AIR_NAMES=['ndgd_apm25_hr01','ndgd_apm25_hr24','ndgd_mpm25_hr01','ndgd_ozone_1hr_avg_time','ndgd_ozone_8hr_avg_time','ndgd_ozone_1hr_max_time','ndgd_ozone_8hr_max_time']
AIR_NAMES += [x+'_bc' for x in AIR_NAMES]
AIR_NAMES += ['ndgd_smoke_sfc_1hr_avg_time','ndgd_smoke_vert_1hr_avg_time','ndgd_dust_sfc_time','ndgd_dust_vert_time']
IMAGE_PATHS={f'/air_quality/{x}/ImageServer' for x in AIR_NAMES}|{'/radar/radar_base_reflectivity_time/ImageServer','/obs/mrms_qpe/ImageServer'}
DIRECTORIES={
 'gis':[p[1:] for p in SERVICES if p!=TROPICAL]+['outlooks/spc_mesoscale_discussion/FeatureServer'],
 'raster':[p[1:] for p in IMAGE_PATHS if p.startswith('/air_quality')]+[FFG[1:],'obs/mrms_qpe/ImageServer','obs/NWM_Land_Analysis/MapServer'],
 'tropical':[TROPICAL[1:]],'event':['radar/radar_base_reflectivity_time/ImageServer'],
}

def attrs(service,i,layer):
 p={'objectid':i,'idp_filedate':STAMP,'idp_ingestdate':STAMP+1000}
 if service==MCD:p.update(name=['NoArea','1234','1235'][i-1],folderpath='Concerning severe thunderstorms',popupinfo='<a href="https://www.spc.noaa.gov/products/md/md1234.html">Discussion</a>',idp_filedate=STAMP+i*1000)
 elif service==HAZARDS:p.update(label=['High Winds','Hazardous Cold','NoArea'][i-1],start_date=STAMP,end_date=STAMP+86400000,issue_time_dt=None)
 elif service==WINTER:p.update(prob=[5,30,80,None][i-1],component='Overall',impact='moderate',inittime='12Z 2026/01/02',fcsthr=['024','030','024','168'][i-1],validstartdatetime=STAMP,validenddatetime=STAMP+86400000)
 elif service==FLOOD:p.update(outlook=['Possible','Likely','NoArea'][i-1],product='River Flood Outlook',issue_time='2026-01-02 12:00:00',start_time='2026-01-02 12:00:00',end_time='2026-01-07 12:00:00')
 elif service==BEACH:p.update(id='AKQ',beachname=f'Beach {i}',productdat='N/A' if i==1 else 'Jan 2 2026',producttim='1200 UTC',period='Today',rip='Low' if i!=1 else None,uv='3',surf='2 to 3 ft',wtemp='50 F',maxtemp='60 F',weather='Clear',winds='N 10 kt',tstorm='None',wspout='None',srfprod='https://forecast.weather.gov/product.php?product=SRF',idp_filedate=STAMP+i*1000)
 elif service==LONG:p.update(gaugelid=['RMDV2','OTHER','THIRD'][i-1],name=f'Gauge {i}',state='VA' if i!=2 else 'NC',wfo='akq',rfc='marfc',latitude=38,longitude=-78,interval='JFM',stage='minor',minor='< 0.05',moderate='0.25',major='> 0.95',idp_filedate=STAMP+i*1000)
 elif service==TROPICAL:p={'OBJECTID':i,'stormname':'Fixture','maxwind':50,'idp_source':'AT1_fixture','advisnum':'12A','advdate':'1200 UTC','validtime':'02/1200 UTC','idp_filedate':STAMP+i*1000,'idp_ingestdate':STAMP}
 return p

def extension(path,q,server=None):
 one=lambda k,default='':q.get(k,[default])[0]
 if server in DIRECTORIES and path in ['/',*['/'+p.split('/')[0] for p in DIRECTORIES[server]]]:
  folder=path.strip('/');entries=DIRECTORIES[server]
  if not folder:return 200,{'folders':sorted({p.split('/')[0] for p in entries})+['Utilities'],'services':[]}
  return 200,{'services':[{'name':p.rsplit('/',1)[0],'type':p.rsplit('/',1)[1]} for p in entries if p.startswith(folder+'/')]}
 if path==FFG:
  layers=[]
  for i,hours in enumerate([1,3,6,12]):
   n=600+i*4;layers += [{'id':n,'name':f'Flash Flood Guidance {hours:02} Hour','type':'Mosaic Layer'},{'id':n+1,'name':'Image','type':'Raster Layer','parentLayerId':n},{'id':n+2,'name':'Footprint','type':'Feature Layer','parentLayerId':n}]
  return 200,{'layers':layers,'maxRecordCount':2}
 if path==FFG+'/identify':
  image_id=int(one('layers').split(':')[1]);i=(image_id-601)//4
  if image_id not in [601,605,609,613]:return 400,{'detail':'Wrong FFG layer'}
  lat=float(one('geometry').split(',')[1]);value='NoData' if lat==40 else '0' if lat==41 else '50.8'
  return 200,{'results':[{'layerId':image_id,'attributes':{'objectid':str(800+i),'name':f'ffg_{i}','Service Pixel Value':value,'Classify.Class value':'99'}}]}
 m=re.fullmatch(re.escape(FFG)+r'/(\d+)/query',path)
 if m:
  i=(int(m[1])-602)//4
  if one('objectIds')!=str(800+i):return 400,{'detail':'Wrong FFG raster ID'}
  return 200,{'features':[{'attributes':{'objectid':800+i,'name':f'ffg_{i}','idp_validtime':STAMP,'idp_issueddate':STAMP-3600000,'idp_filedate':STAMP+1000,'idp_ingestdate':STAMP+2000}}]}
 if path in SERVICES:return 200,{'layers':[{'id':i,'name':n,'type':'Feature Layer'} for i,n in SERVICES[path].items()],'maxRecordCount':2}
 m=re.fullmatch(r'(.+/(?:MapServer|FeatureServer))/(\d+)(/query)?',path)
 if m and m[1] in SERVICES:
  service,layer=m[1],int(m[2]);oid='OBJECTID' if service==TROPICAL else 'objectid'
  if layer not in SERVICES[service]:return 400,{'error':{'code':400,'message':'Invalid layer'}}
  if not m[3]:
   p=attrs(service,1,layer);return 200,{'id':layer,'name':SERVICES[service][layer],'type':'Feature Layer','fields':[{'name':key,'alias':key,'type':'esriFieldTypeOID' if key==oid else 'esriFieldTypeDate' if key.startswith('idp_') else 'esriFieldTypeString','nullable':True,'domain':None} for key in p]}
  if one('f')!='geojson' or one('orderByFields')!=oid+' ASC' or one('outSR')!='4326':return 400,{'detail':'Invalid feature query'}
  where=one('where');match=re.fullmatch(oid+r' > (\d+)',where)
  if where!='1=1' and not match:return 400,{'detail':'Invalid keyset predicate'}
  after=int(match[1]) if match else 0;size=int(one('resultRecordCount'))
  if not 1<=size<=2:return 400,{'detail':'Respect service cap'}
  geom=json.loads(one('geometry','null'));outside=False
  if geom:
   if one('geometryType')=='esriGeometryPoint':
    outside=abs(geom['x']+78)>1 or abs(geom['y']-38)>1
    if service==TROPICAL and layer==100 and abs(geom['x']+80.19)<0.1 and abs(geom['y']-25.76)<0.1:outside=False
   else:outside=not(geom['xmin']<=-78<=geom['xmax'] and geom['ymin']<=38<=geom['ymax'])
  n=4 if service==WINTER else 3;ids=[] if outside else [i for i in range(1,n+1) if i>after]
  features=[{'type':'Feature','properties':attrs(service,i,layer),'geometry':{'type':'Point','coordinates':[-78,38]} if service in [TROPICAL,LONG] else {'type':'Polygon','coordinates':[[[-79,37],[-77,37],[-77,39],[-79,39],[-79,37]]]}} for i in ids[:size]]
  if one('returnGeometry')=='false':
   for f in features:f['geometry']=None
  return 200,{'type':'FeatureCollection','features':features,'exceededTransferLimit':len(ids)>size}
 return image(path,q)

def image(path,q):
 one=lambda k,default='':q.get(k,[default])[0]
 service=path.rsplit('/',1)[0] if path.endswith(('/query','/getSamples')) else path
 if service not in IMAGE_PATHS:return None
 fields=[{'name':n,'alias':n,'type':'esriFieldTypeOID' if n=='objectid' else 'esriFieldTypeDate' if n.startswith('idp_') and n not in ['idp_subset','idp_fcst_hour'] else 'esriFieldTypeString'} for n in ['objectid','name','category','idp_subset','idp_validtime','idp_validendtime','idp_issueddate','idp_filedate','idp_ingestdate','idp_fcst_hour']]
 if path==service:return 200,{'name':service[1:],'bandCount':4 if service.startswith('/radar') else 1,'objectIdField':'objectid','maxRecordCount':10,'maxMosaicImageCount':5,'fields':fields,'timeInfo':{'startTimeField':'idp_validtime','endTimeField':'idp_validendtime'},'serviceDescription':'Fixture native data; no measurement units inferred from coordinate metres.'}
 geom=json.loads(one('geometry'));lat=geom['y'];lon=geom['x']
 if geom['spatialReference']['wkid']!=4326:return 400,{'detail':'Require WGS84 point'}
 if lat==45:return 200,{'status':'error','messages':['Fixture image server unavailable']}
 def props(i):return {'objectid':i,'name':f'forecast_{i}','category':1,'idp_subset':'conus','idp_validtime':STAMP+(i-101)*3600000,'idp_validendtime':STAMP+(i-100)*3600000,'idp_issueddate':STAMP-3600000,'idp_filedate':STAMP-1000,'idp_ingestdate':STAMP,'idp_fcst_hour':i-100}
 if path.endswith('/query'):
  match=re.fullmatch(r"category = 1(?: AND objectid > (\d+))?(?: AND idp_subset = '((?:[^']|'')*)')?",one('where'))
  if not match or one('orderByFields')!='objectid ASC' or one('returnGeometry')!='false' or one('outFields')!='*':return 400,{'detail':'Invalid image catalog query'}
  size=int(one('resultRecordCount'));after=int(match[1] or '-1');subset=(match[2] or '').replace("''", "'")
  if size>5:return 400,{'detail':'Respect mosaic limit'}
  ids=[] if lat==40 or lon>0 or (subset and subset!='conus') else [i for i in range(101,124) if i>after]
  if one('time'):
   start,end=one('time').split(',');start=None if start=='null' else int(start);end=None if end=='null' else int(end)
   ids=[i for i in ids if (start is None or props(i)['idp_validendtime']>=start) and (end is None or props(i)['idp_validtime']<=end)]
  if lat==44:return 200,{'features':[],'exceededTransferLimit':True}
  return 200,{'features':[{'attributes':props(i)} for i in ids[:size]],'exceededTransferLimit':len(ids)>size}
 rule=json.loads(one('mosaicRule'));ids=rule['lockRasterIds']
 if rule['mosaicMethod']!='esriMosaicLockRaster' or not 1<=len(ids)<=5 or one('returnFirstValueOnly')!='false' or one('interpolation')!='RSP_NearestNeighbor':return 400,{'detail':'Sampling must lock bounded raster IDs and preserve every value'}
 samples=[{'rasterId':i,'attributes':props(i),'value':'7 13 29 255' if service.startswith('/radar') else 'NoData' if i==102 else '0' if i==103 else '12.5','location':geom,'locationId':0} for i in ids]
 if lat==42 and len(samples)>1:samples[1]['rasterId']=samples[0]['rasterId']
 if lat==43:samples=samples[:-1]
 if lat==46:samples[0]['attributes']['idp_issueddate']=STAMP
 return 200,{'samples':samples}
