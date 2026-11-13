#!/usr/bin/env python3
"""Regenerate public MRMS parameter metadata from NOAA NSSL's published user table."""
import csv
import io
import json
from pathlib import Path
import urllib.request

URL='https://raw.githubusercontent.com/NOAA-National-Severe-Storms-Laboratory/mrms-support/main/GRIB2_TABLES/UserTable_MRMS_v12.2.csv'
rows=list(csv.DictReader(io.StringIO(urllib.request.urlopen(URL,timeout=30).read().decode())))
fields={}
def number(s):
 try:return float(s)
 except ValueError:return None
for r in rows:
 if not r['Discipline'].isdigit():continue
 fields[r['Name']]={'discipline':int(r['Discipline']),'category':int(r['Category']),'parameter':int(r['Parameter']),'unit':r['Unit'],'missing':number(r['Missing']),'folded':number(r['Range Folded']),'no_coverage':number(r['No Coverage']),'description':r['Description'],'notes':r['Notes']}
target=Path(__file__).resolve().parents[1]/'src/mrms_fields.ts'
target.write_text('/** Generated from NOAA NSSL MRMS v12.2; run scripts/update_mrms_fields.py. */\nexport const MRMS_FIELDS_SOURCE = '+json.dumps(URL)+';\nexport interface MrmsField {discipline:number;category:number;parameter:number;unit:string;missing:number|null;folded:number|null;no_coverage:number|null;description:string;notes:string}\nexport const MRMS_FIELDS: Record<string,MrmsField> = '+json.dumps(fields,indent=2)+';\n')
print(len(fields),'MRMS parameter records')
