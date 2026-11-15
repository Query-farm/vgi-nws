# Changelog

## 0.5.2 — 2026-11-14

### Changed

- Docs link to upstream sources: the catalog `vgi.doc_md` gains a Sources and references section linking the NWS API, the NWPS API, the NOAA/NWS GIS map services, SWPC, NDBC, the AviationWeather.gov Data API and the MRMS product server (VGI183).
- The `main` schema comment is now a short plain-text line instead of repeating the schema `vgi.doc_md` (VGI102).
- The catalog `vgi.doc_llm` / `vgi.doc_md` give an overview of the data families, how the parts fit together and the caveats, instead of listing 58 of the 92 functions by name (VGI173). Each function's own description already carries its per-function guidance.

## 0.5.1 — 2026-11-14

### Changed

- vgi-lint 2.7.0 compatibility: `space_weather_rows` carries a scoped VGI516 waiver, because its example's `products/noaa-scales.json` is an SWPC API product path, not a local file. No example returns a NULL-only or zero-count result (VGI913).

## 0.5.0 — 2026-11-14

### Breaking

- Removed the `nws.compat` compatibility interface (37 functions taking a final positional `options_json` argument); use named arguments in LATERAL calls, supported from DuckDB 2.0.1. For example, `LATERAL nws.main.climate_outlook_at(s.lat, s.lon, period := '8_14_day')`. On DuckDB 2.0.0, correlated calls still work with default options.

### Changed

- The catalog comment is now a one-sentence plain-text description. The full guide remains in the catalog's `vgi.doc_md` and `vgi.doc_llm` tags.

Validation: 64 Bun tests; Haybarn 2.0.0rc11 SQL tests over stdio (1,101), launch (1,101) and HTTP (1,070); 388 stock DuckDB 2.0.0 assertions; metadata 100/100 at L2.

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
