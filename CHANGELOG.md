# Changelog

## 0.4.0 — 2026-11-13

Initial public release of the TypeScript National Weather Service VGI worker.

- 92 functions in `nws.main`, plus 37 `nws.compat` variants for stock DuckDB correlated queries.
- NWS forecasts, observations, alerts, bulletins and geographic discovery; NWPS river observations, forecasts and flood information.
- NOAA GIS discovery and native feature/raster access, including outlooks, precipitation, winter weather, land conditions, air quality and tropical products.
- Schema-driven weather, water and aviation API readers, NDBC buoy measurements and spectra, and SWPC space-weather data.
- MRMS product discovery and point sampling through native ecCodes, preserving precision, source units, reference/validity times and missing-value distinctions.
- Stdio, Unix launch and HTTP transports, bounded upstream requests and caching, documented SQL examples and deterministic fixtures.
- Docker packaging with PNG-enabled ecCodes, and signed release archives for Linux x86-64/ARM64, macOS ARM64 and Windows x86-64.

MRMS decoding requires `grib_ls` and `grib_get` from an ecCodes build with PNG support. Native release executables embed Bun and the TypeScript worker, but ecCodes must be installed separately or made available through `NWS_ECCODES_BIN`. The Docker image includes it. MRMS point queries decode complete grids; these readers are not long-term archives.

Validation: 62 Bun tests; Haybarn SQL tests over stdio, launch and HTTP; 407 stock DuckDB 2.0.0 assertions; metadata assurance L2 at 100/100; Docker decoding checks and live MRMS SQL queries.

Targets: `@query-farm/vgi` 0.50.0, `@query-farm/vgi-rpc` 0.29.7, VGI protocol 3.3, Haybarn 2.0.0rc11, and stock DuckDB 2.0.0.
