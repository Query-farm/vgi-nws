#!/usr/bin/env python3
"""Regenerate tiny synthetic fixtures: uv run --with eccodes --with numpy python scripts/generate_grib_fixtures.py.

ecCodes writes every GRIB section and packing codec. No live data is embedded.
The 32x32 grids avoid ecCodes' PNG encoder buffer limit on very small images.
"""
from pathlib import Path
import eccodes as e

ROOT = Path(__file__).resolve().parents[1] / 'test/fixtures/grib'
ROOT.mkdir(parents=True, exist_ok=True)

def write(name, packing='grid_simple', bitmap=False, extra=None, values=None):
    h = e.codes_grib_new_from_samples('regular_ll_sfc_grib2')
    try:
        settings = dict(Ni=32, Nj=32, latitudeOfFirstGridPointInDegrees=39,
            latitudeOfLastGridPointInDegrees=35.9, longitudeOfFirstGridPointInDegrees=281,
            longitudeOfLastGridPointInDegrees=284.1, iDirectionIncrementInDegrees=0.1,
            jDirectionIncrementInDegrees=0.1, bitsPerValue=24, dataDate=20260102,
            dataTime=1200, second=30, discipline=209, parameterCategory=6, parameterNumber=1,
            bitmapPresent=int(bitmap), missingValue=1e20)
        settings.update(extra or {})
        for k, v in settings.items(): e.codes_set(h, k, v)
        if values is None:
            values = [2.5] * 1024
            # Row 10: latitude 38; columns 0..5 have these exact physical values.
            values[320:326] = [0, -1, -3, -99, 9999, 1e20 if bitmap else 1.25]
        e.codes_set_values(h, values)
        e.codes_set(h, 'packingType', packing)
        with (ROOT / (name + '.grib2')).open('wb') as f: e.codes_write(h, f)
    finally: e.codes_release(h)

write('png', 'grid_png')
write('bitmap', bitmap=True)
write('forecast', extra={'indicatorOfUnitOfTimeRange':13, 'forecastTime':90})
write('interval', extra={'productDefinitionTemplateNumber':8, 'yearOfEndOfOverallTimeInterval':2026,
    'monthOfEndOfOverallTimeInterval':1, 'dayOfEndOfOverallTimeInterval':2,
    'hourOfEndOfOverallTimeInterval':15, 'minuteOfEndOfOverallTimeInterval':0,
    'secondOfEndOfOverallTimeInterval':45})
write('precision', values=[1.23456789, 0, 2] + [1.23456789]*1021)
write('dateline', extra={'longitudeOfFirstGridPointInDegrees':179,
    'longitudeOfLastGridPointInDegrees':182.1})
