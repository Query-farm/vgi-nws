#!/usr/bin/env python3
"""Run the stock DuckDB verifier with fixtures, or explicitly opt in to live services."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--live', action='store_true')
args = parser.parse_args()
env = dict(os.environ)
mock = None
try:
    if args.live:
        env.pop('NWS_API_BASE_URL', None)
        env.pop('NWPS_API_BASE_URL', None)
        env.pop('NWS_GIS_BASE_URL', None)
        env.pop('NWS_RASTER_BASE_URL', None)
        env.pop('NWS_TROPICAL_BASE_URL', None)
        env.pop('NWS_EVENT_BASE_URL', None)
        env.pop('NWS_AVIATION_BASE_URL', None)
        env.pop('NWS_NDBC_BASE_URL', None)
        env.pop('NWS_SWPC_BASE_URL', None)
        env.pop('NWS_MRMS_BASE_URL', None)
    else:
        mock = subprocess.Popen([sys.executable, str(ROOT / 'test/mock_api/server.py')], stdout=subprocess.PIPE, text=True)
        line = mock.stdout.readline().strip()
        if not line.startswith('PORT:'):
            raise RuntimeError('Fixture did not report its port')
        env['NWS_API_BASE_URL'] = 'http://127.0.0.1:' + line.split(':')[1]
        env['NWPS_API_BASE_URL'] = env['NWS_API_BASE_URL']
        env['NWS_GIS_BASE_URL'] = env['NWS_API_BASE_URL'] + '/gis'
        env['NWS_RASTER_BASE_URL'] = env['NWS_API_BASE_URL'] + '/raster'
        env['NWS_TROPICAL_BASE_URL'] = env['NWS_API_BASE_URL'] + '/tropical'
        env['NWS_EVENT_BASE_URL'] = env['NWS_API_BASE_URL'] + '/event'
        env['NWS_AVIATION_BASE_URL'] = env['NWS_API_BASE_URL'] + '/aviation'
        env['NWS_NDBC_BASE_URL'] = env['NWS_API_BASE_URL'] + '/ndbc'
        env['NWS_SWPC_BASE_URL'] = env['NWS_API_BASE_URL'] + '/swpc'
        env['NWS_MRMS_BASE_URL'] = env['NWS_API_BASE_URL'] + '/mrms'
    command = [sys.executable, str(ROOT / 'scripts/verify_worker.py'), '--project',
               str(ROOT / 'test/live' if args.live else ROOT), '--timeout', '180',
               '--output', str(ROOT / ('verification-live.json' if args.live else 'verification.json'))]
    sys.exit(subprocess.call(command, env=env))
finally:
    if mock:
        mock.terminate()
        try: mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()
            mock.wait()
