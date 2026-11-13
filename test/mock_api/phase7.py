"""NDBC and SWPC file products with native headers, sentinel values and timestamps."""
import json
import re

STATIONS='''<?xml version="1.0"?><stations count="2"><station id="44014" lat="36.6" lon="-74.8" elev="0" name="Virginia &amp; offshore" owner="NDBC" pgm="NDBC" type="buoy" met="y" currents="n" waterquality="n" dart="n"/><station id="21415" lat="50" lon="171" name="DART" owner="NDBC" type="dart" met="n" currents="n" waterquality="n" dart="y"/></stations>'''
PRODUCTS=['txt','spec','data_spec','swdir','swdir2','swr1','swr2','ocean','supl','adcp','dart','rain','srad','cwind','drift']
def buoy(product):
 if product=='drift':return '#YY MM DD hhmm LAT LON WSPD\n#yr mo dy hrmn deg deg m/s\n2026 01 02 1205 36 -74 0\n'
 if product=='dart':return '#YY MM DD hh mm ss T HEIGHT\n#yr mo dy hr mn s - m\n2026 01 02 12 00 30 1 4718.202\n'
 if product=='cwind':return '#YY MM DD hh mm WDIR WSPD GDR GST GTIME\n#yr mo dy hr mn degT m/s degT m/s hhmm\n2026 01 02 12 00 000 0 999 99.0 9999\n'
 if product in ['data_spec','swdir','swdir2','swr1','swr2']:
  return '#YY MM DD hh mm '+('Sep_Freq ' if product=='data_spec' else '')+'values (freq) ...\n2026 01 02 12 00 '+('9.999 ' if product=='data_spec' else '')+'0 (0.033) 999.0 (0.038) 0.25 (0.043)\n'
 if product=='spec':return '#YY MM DD hh mm WVHT STEEPNESS SwD\n#yr mo dy hr mn m - -\n2026 01 02 12 00 0 VERY_STEEP SE\n'
 if product=='adcp':return '#YY MM DD hh mm DEP01 DIR01 SPD01 DEP02 DIR02 SPD02\n#yr mo dy hr mn m degT cm/s m degT cm/s\n2026 01 02 12 00 1 90 0 2 180 MM\n'
 if product=='ocean':return '#YY MM DD hh mm DEPTH OTMP SAL\n#yr mo dy hr mn m degC psu\n2026 01 02 12 00 1 0 35.8\n'
 if product=='srad':return '#YY MM DD hh mm SRAD1 SWRAD LWRAD\n#yr mo dy hr mn w/m2 w/m2 w/m2\n2026 01 02 12 00 MM 0 350\n'
 if product=='rain':return '#YY MM DD hh mm ACCUM\n#yr mo dy hr mn mm\n2026 01 02 12 00 0\n'
 if product=='supl':return '#YY MM DD hh mm PRES PTIME WSPD WDIR WTIME\n#yr mo dy hr mn hPa hhmm m/s degT hhmm\n2026 01 02 12 00 1010 1150 0 0 1150\n'
 return '#YY MM DD hh mm WVHT WTMP PRES\n#yr mo dy hr mn m degC hPa\n2026 01 02 12 00 0 20 1010\n2026 01 02 11 00 MM 19 1009\n2026 01 02 10 00 2 18 1008\n'

def extension(path,q,server):
 if server=='ndbc':
  if path=='/activestations.xml':return 200,STATIONS
  if path=='/data/realtime2/':return 200,'<html>'+''.join(f'<a href="44014.{p}">{p}</a>' for p in PRODUCTS+['unknown'])+'<a href="../private.txt">bad</a></html>'
  m=re.fullmatch(r'/data/realtime2/(44014|21415)\.([a-z0-9_]+)',path)
  if m and m[2] in PRODUCTS:return 200,buoy(m[2])
 if server=='swpc':
  dirs={'/':['json/','products/','text/'],'/json/':['goes/','ovation_aurora_latest.json'],'/json/goes/':['primary/'],'/json/goes/primary/':['xrays-6-hour.json'],'/products/':['noaa-scales.json','table.json','animations/'],'/text/':['3-day-forecast.txt'],'/lists/':[]}
  if path in dirs:return 200,'<html>'+''.join(f'<a href="{x}">{x}</a>' for x in dirs[path])+'<a href="../">parent</a><a href="https://evil.invalid/x.json">bad</a></html>'
  if path=='/products/noaa-scales.json':return 200,{'-1':{'G':{'Scale':'1'}},'0':{'G':{'Scale':'0'}},'1':{'R':{'Scale':None,'MinorProb':'20'}}}
  if path=='/products/table.json':return 200,[['time_tag','density','speed'],['2026-01-02 12:00:00.000','0','400'],['2026-01-02 12:01:00.000',None,'401'],['2026-01-02 12:02:00.000','5','402']]
  if path=='/json/ovation_aurora_latest.json':return 200,{'Observation Time':'2026-01-02T12:00:00Z','Forecast Time':'2026-01-02T12:30:00Z','Data Format':'[Longitude, Latitude, Aurora]','coordinates':[[0,60,0],[1,61,20],[2,62,50]]}
  if path=='/json/goes/primary/xrays-6-hour.json':return 200,[{'time_tag':'2026-01-02T12:00:00Z','flux':0,'energy':'0.1-0.8nm'},{'time_tag':'2026-01-02T12:01:00Z','flux':None,'energy':'0.1-0.8nm'}]
  if path=='/text/3-day-forecast.txt':return 200,':Product: 3-Day Forecast\nNo significant activity expected.\n'
 return None
