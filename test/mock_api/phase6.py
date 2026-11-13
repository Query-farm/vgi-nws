"""Schema, aviation, radio and river read fixtures; every query is checked."""
import json

def parameter(name,kind='query',type='string',required=False,**schema):
 return {'name':name,'in':kind,'required':required,'schema':{'type':type,**schema}}
def operation(identifier,parameters=(),media='application/json',**extra):
 return {'get':{'operationId':identifier,'summary':identifier,'parameters':list(parameters),'responses':{'200':{'content':{media:{'schema':{'type':'object'}}}}},**extra}}

WEATHER={'openapi':'3.0.0','paths':{
 '/zones/{type}/{zoneId}/forecast':operation('zone_forecast',[parameter('type','path',required=True,enum=['forecast','marine']),parameter('zoneId','path',required=True,pattern='^[A-Z]{3}[0-9]{3}$')]),
 '/radio/{callSign}/broadcast':operation('area_radio',[parameter('callSign','path',required=True)],'application/ssml+xml'),
 '/alerts':operation('alerts_query',[parameter('area',type='array',items={'type':'string'}),parameter('cursor')]),
 '/icons/{icon}':operation('image',[parameter('icon','path',required=True)],'image/png'),
}}
WATER={'swagger':'2.0','paths':{'/nwps/v1/products/stageflow/{identifier}/{pedts}':operation('Products_GetStageFlow',[parameter('identifier','path',required=True),parameter('pedts','path',required=True)])}}
AVPARAMS=[parameter('ids',required=True),parameter('format',enum=['raw','json']),parameter('hours',type='number',minimum=0,maximum=720)]
AVIATION={'openapi':'3.1.0','paths':{
 '/api/data/metar':operation('metar',AVPARAMS),
 '/api/data/taf':operation('taf',AVPARAMS),
 '/api/data/fcstdisc':operation('fcstdisc',[parameter('ids',required=True)],'text/plain'),
 '/api/data/airsigmet':operation('airsigmet',deprecated=True),
}}

def extension(path,q,server=None):
 one=lambda k,d='':q.get(k,[d])[0]
 if path=='/openapi.json':return 200,WEATHER
 if path=='/docs/swagger.json':return 200,WATER
 if server=='aviation':
  if path=='/data/schema/openapi.yaml':return 200,json.dumps(AVIATION)
  if path in ['/api/data/metar','/api/data/taf']:
   if one('format')!='json' or not one('ids'):return 400,{'error':'Require ids and JSON'}
   if one('ids')=='NONE':return 204,''
   if one('ids')=='FAIL':return 503,{'error':'Unavailable'}
   if one('ids')=='CAP':return 200,[{'icaoId':str(i)} for i in range(400)]
   return 200,[{'icaoId':one('ids'),'obsTime':1767355200,'temp':0,'wspd':None,'visib':'10+','rawOb':'METAR fixture','clouds':[]}]
  if path=='/api/data/fcstdisc':return 200,'FXUS61 KLWX\nAFDLWX\nCold high pressure.\n'
  if path=='/api/data/airsigmet':return 200,[]
 if path=='/zones/forecast/VAZ037/forecast':return 200,{'type':'Feature','properties':{'updated':'2026-01-02T12:00:00Z','periods':[{'number':1,'name':'Today','detailedForecast':'Sunny'}]},'geometry':None}
 if path=='/radio/KHB36/broadcast':return 200,'<speak><p>Cold weather forecast.</p></speak>'
 if path=='/products/stageflow/RMDV2/HGIRG':return 200,{'pedts':'HGIRG','primaryUnits':'ft','data':[{'validTime':'2026-01-02T12:00:00Z','primary':6,'secondary':None}]}
 return None

def post(path,body):
 if path!='/gauges/raag':return 404,{'detail':'Unknown POST fixture'}
 if set(body)!= {'rivers'} or not isinstance(body['rivers'],list) or len(body['rivers'])!=len(set(body['rivers'])):return 400,{'detail':'Expected distinct rivers array'}
 return 200,{'statusCode':200,'rivers':[{'lid':lid,'wfo':'AKQ','rfc':'MARFC','name':'James River','floodStatements':[{'stage':12,'units':'ft','statement':'Flooding possible'}]} for lid in body['rivers'] if lid!='NONE']}
