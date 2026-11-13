"""Native MRMS listings and ecCodes-generated GRIB files."""
import gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'fixtures/grib'
NAME = 'MRMS_PrecipRate_00.00_20260102-120030.grib2.gz'

def extension(path, q, server):
    if server != 'mrms': return None
    if path == '/2D/': return 200, '<a href="PrecipRate/">PrecipRate</a><a href="../">Parent</a>'
    if path == '/2D/PrecipRate/':
        return 200, ''.join(f'<a href="{f}">{f}</a>' for f in [NAME,
            NAME.replace('00.00', '01.00'), NAME.replace('120030', '110030')])
    if path.startswith('/2D/PrecipRate/MRMS_PrecipRate_') and path.endswith('.grib2.gz'):
        return 200, gzip.compress((ROOT / ('bitmap.grib2' if '_01.00_' in path else 'png.grib2')).read_bytes(), mtime=0), {'Content-Type':'application/octet-stream'}
    return 404, {'detail':'Unknown fixture MRMS path'}
