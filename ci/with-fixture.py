#!/usr/bin/env python3
"""Run a command with deterministic NWS and NWPS API roots."""
import os
from pathlib import Path
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
mock = subprocess.Popen([sys.executable, str(ROOT / 'test/mock_api/server.py')], stdout=subprocess.PIPE, text=True)
try:
    line = mock.stdout.readline().strip()
    if not line.startswith('PORT:'): raise RuntimeError('Fixture startup failed')
    env = dict(os.environ, NWS_API_BASE_URL='http://127.0.0.1:' + line.split(':')[1])
    env['NWPS_API_BASE_URL'] = env['NWS_API_BASE_URL']
    env['NWS_GIS_BASE_URL'] = env['NWS_API_BASE_URL'] + '/gis'
    env['NWS_RASTER_BASE_URL'] = env['NWS_API_BASE_URL'] + '/raster'
    env['NWS_TROPICAL_BASE_URL'] = env['NWS_API_BASE_URL'] + '/tropical'
    env['NWS_EVENT_BASE_URL'] = env['NWS_API_BASE_URL'] + '/event'
    env['NWS_AVIATION_BASE_URL'] = env['NWS_API_BASE_URL'] + '/aviation'
    env['NWS_NDBC_BASE_URL'] = env['NWS_API_BASE_URL'] + '/ndbc'
    env['NWS_SWPC_BASE_URL'] = env['NWS_API_BASE_URL'] + '/swpc'
    env['NWS_MRMS_BASE_URL'] = env['NWS_API_BASE_URL'] + '/mrms'
    sys.exit(subprocess.call(sys.argv[1:], env=env, cwd=ROOT))
finally:
    mock.terminate()
    try: mock.wait(timeout=5)
    except subprocess.TimeoutExpired:
        mock.kill()
        mock.wait()
