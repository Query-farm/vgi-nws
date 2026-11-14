# vgi-nws

A TypeScript VGI worker exposing **92 main SQL functions** for the US National Weather
Service and National Water Prediction Service. It covers alerts, observations,
forecasts, gridded forecast variables, text bulletins, zone boundaries, office
briefings, spatial outlooks, river conditions, geographic gauge discovery,
observed rainfall, winter impacts, model streamflow, soil moisture, rainfall
anomalies, snowpack, storm reports, tropical features, marine and space-weather feeds,
and native MRMS radar grids. Thirty-seven additional `nws.compat` variants support customized correlated calls on stock
DuckDB 2.0.0. No API key is required.

Built from [Query-farm/vgi-starter-typescript](https://github.com/Query-farm/vgi-starter-typescript)
v1.3.0, commit `145aedcb87ed8fadde6dfb8a26197d0d68112369`. The original CLI,
transport harness, reusable recipes, Docker scaffolding, and dependency lock are
retained. This is a local integration, not an official NOAA application.

## Quickstart

Requires Bun 1.3 or newer and stock DuckDB **2.0.0**. Native MRMS decoding also
requires ecCodes with PNG support; see below. Install dependencies from this directory:

```sh
bun install --frozen-lockfile
export NWS_USER_AGENT='my-weather-analysis (contact: you@example.org)'
```

Run the following in DuckDB. Replace the worker path if you move the directory.

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm
  WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;

ATTACH 'nws' (TYPE vgi,
  LOCATION '/Users/rusty/Development/vgi-nws/bin/vgi-nws-worker');

SELECT event, headline, expires
FROM nws.main.alerts(area := 'VA')
ORDER BY sent DESC;

SELECT issued_at, product_text
FROM nws.main.latest_product('AFD', 'LWX');
```

The launcher works from any current directory. Environment configuration must be
set before DuckDB launches the worker (or before starting its HTTP server).

## Functions

The primary functions live in `nws.main`. Positional arguments accept literals or columns,
including correlated `LATERAL` joins. NULL positional input produces no rows;
`LEFT JOIN LATERAL ... ON true` preserves the outer site when it has no result.
Filters and options use named arguments, for example `area := 'VA'`. On stock
DuckDB 2.0.0, customized correlated calls use the `nws.compat` forms described
below; correlated calls using defaults work directly in `nws.main`.

| Functions | Purpose |
| --- | --- |
| `point(latitude, longitude)` | Resolve office, grid, zones, timezone, radar ID, and forecast URLs |
| `alerts(area := '', zone := '', event := '', active := true, start_time := '', end_time := '')` | Active or recent alerts; area and zone are mutually exclusive |
| `alerts_at(latitude, longitude, event := '', active := true, start_time := '', end_time := '')` | NWS point filtering, including zone-based alerts |
| `alert(alert_id)`, `alert_types()` | Full alert message and supported event names |
| `stations_at(latitude, longitude)`, `station(station_id)` | Discover observation stations and inspect their metadata |
| `observations(station_id, start_time := '', end_time := '', page_size := 500)` | Recent observations with pagination and SI quantities |
| `latest_observation(station_id)` | Latest available observation with original quality flags |
| `forecast(latitude, longitude)`, `forecast_hourly(latitude, longitude)` | Day/night and hourly periods with narratives and Celsius temperature |
| `grid_series(latitude, longitude, variable := '')` | Raw grid variables, native units, and original validity intervals |
| `products(product_type, office_id)` | Recent bulletin index; use returned IDs to retrieve text |
| `latest_product(product_type, office_id)`, `product(product_id)` | Complete original bulletin text, such as AFD or HWO |
| `product_types()`, `product_locations(product_type)` | Discover bulletin codes and their issuing locations |
| `zones(zone_type, state := '')`, `zone(zone_type, zone_id)` | Zone indexes and GeoJSON boundaries |
| `office(office_id)` | Office contacts and responsibility links |
| `briefing(office_id)`, `weather_stories(office_id)` | Current document/image metadata and download URLs |
| `glossary()` | NWS meteorological terminology |
| `gauge(gauge_id)` | NWPS gauge metadata, current status, datums, and attribution |
| `stageflow(gauge_id, product := 'both')` | Observed and/or forecast values, quantity names, and native units |
| `flood_thresholds(gauge_id)`, `flood_impacts(gauge_id)` | Flood categories and local consequences by gauge stage |
| `historic_crests(gauge_id)` | Published historic crests, including old-datum flags |
| `parse_valid_time(valid_time)` | Offline ISO8601 interval decoder with start, end, and duration |
| `severe_outlook()`, `severe_outlook_at(latitude, longitude)` | SPC categorical and probabilistic severe-weather outlooks |
| `fire_outlook()`, `fire_outlook_at(latitude, longitude)` | SPC wind/low-humidity and dry-thunderstorm outlooks |
| `rainfall_outlook()`, `rainfall_outlook_at(latitude, longitude)` | WPC excessive-rainfall risk areas |
| `precipitation_forecast()`, `precipitation_forecast_at(latitude, longitude)` | WPC liquid-equivalent precipitation contour values with units |
| `climate_outlook()`, `climate_outlook_at(latitude, longitude)` | CPC temperature/precipitation category probabilities |
| `drought_outlook()`, `drought_outlook_at(latitude, longitude)` | CPC monthly/seasonal drought change outlooks |
| `gauges(state := '', bbox := '')` | Discover gauges by state or bounding box; at least one is required |
| `gauges_near(latitude, longitude, radius_km := 50, state := '')` | Find gauges within a spherical radius, with distance in kilometres |
| `river_network(gauge_id, direction := 'both')` | Discover reported upstream/downstream gauge connections |


Network readers also accept `max_pages := 100` (whole numbers from 1 to 1000).
Reaching this bound raises an error; the worker never quietly reports a truncated
query as complete. A SQL `LIMIT` intentionally allows consumers to stop early.
Product and gauge identifiers are validated before constructing URLs.

## Examples for gardens and field sites

Join forecasts to a site table. The call accepts a batch of locations, and shared
HTTP requests are cached according to the upstream response headers.

```sql
WITH sites(name, latitude, longitude) AS (
  VALUES ('Charlottesville garden', 38.0293, -78.4767),
         ('Richmond field', 37.5407, -77.4360)
)
SELECT s.name, f.start_time, f.temperature_c, f.short_forecast
FROM sites s,
LATERAL nws.main.forecast_hourly(s.latitude, s.longitude) f
WHERE f.temperature_c <= 0
ORDER BY s.name, f.start_time;
```

Find warnings that actually apply to a location. A missing alert polygon does
**not** imply an unaffected location: many warnings describe NWS zones.

```sql
SELECT event, headline, instruction, affected_zones_json
FROM nws.main.alerts_at(38.0293, -78.4767);

SELECT name, geometry_json
FROM nws.main.zone('forecast', 'VAZ037');
```

Inspect the forecast grid's minimum temperatures and precipitation without
inventing hourly values for multi-hour or daily intervals.

```sql
SELECT variable, valid_from, valid_to, value, unit
FROM nws.main.grid_series(38.0293, -78.4767)
WHERE variable IN ('minTemperature', 'quantitativePrecipitation')
ORDER BY variable, valid_from;
```

Inspect river conditions. These examples retain units rather than assuming flow
is always expressed in cubic feet per second.

```sql
SELECT product, valid_at, primary_value, primary_unit,
       secondary_value, secondary_unit
FROM nws.main.stageflow('RMDV2')
ORDER BY product, valid_at;

SELECT category, stage, stage_unit, flow, flow_unit
FROM nws.main.flood_thresholds('RMDV2')
ORDER BY stage;
```

## Spatial outlooks and river discovery

The eight polygon GIS readers each offer a layer scan and an `_at(latitude, longitude)`
point query. All accept `page_size := 100` (1–500), `include_geometry := false`,
and `max_pages := 100`. Layer scans also accept `bbox := 'west,south,east,north'`.
Coordinates use WGS84. A west value greater than east crosses the antimeridian;
intersecting polygons returned by both halves are emitted once.

| Reader | Named product options |
| --- | --- |
| `severe_outlook[_at]` | `day := 1`, `hazard := 'categorical'`; categorical on days 1–3, tornado/hail/wind on days 1–2, severe probabilities on days 3–8 |
| `fire_outlook[_at]` | `day := 1` (1–8), `hazard := 'wind_rh'` or `'dry_thunderstorm'` |
| `rainfall_outlook[_at]` | `day := 1` (1–5) |
| `precipitation_forecast[_at]` | `period := 'day1'`; also day2, day3, day4_5, day6_7, day1_2, day1_3, day1_5, day1_7 |
| `climate_outlook[_at]` | `period := '8_14_day'`, `'6_10_day'`, `'monthly'`, or `'seasonal'`; `variable := 'temperature'` or `'precipitation'`; seasonal `lead := 1` (1–13) |
| `drought_outlook[_at]` | `period := 'monthly'` or `'seasonal'` |
| `winter_precipitation[_at]` | `day := 1` (1–3), `hazard := 'snow'`, `threshold_inches := 4`; snow supports 4/8/12 inches, ice requires 0.25 |
| `winter_storm_severity[_at]` | `period := 'day1_3'` (also day1/day2/day3); `component := 'overall'` (also snow_amount/snow_load/ice/blowing_snow) |

```sql
SELECT category, valid_from, valid_to
FROM nws.main.fire_outlook_at(38.0293, -78.4767, day := 2);

SELECT category, probability_pct, valid_from, valid_to
FROM nws.main.climate_outlook_at(
  38.0293, -78.4767, period := '8_14_day', variable := 'precipitation');

SELECT contour_value, unit, valid_from, valid_to
FROM nws.main.precipitation_forecast_at(
  38.0293, -78.4767, period := 'day1_7');

SELECT category, geometry_json
FROM nws.main.severe_outlook(
  bbox := '-80,36,-76,40', include_geometry := true);

SELECT gauge_id, name, distance_km
FROM nws.main.gauges_near(37.5407, -77.4360, radius_km := 50)
ORDER BY distance_km, gauge_id;

SELECT direction, gauge_id, name
FROM nws.main.river_network('RMDV2')
ORDER BY direction, sequence_number;
```

GIS layer IDs are resolved by exact names from service metadata. Queries use
server-side spatial intersections and ordered object-ID pagination, including
ArcGIS transfer-limit flags. A detected publication change during pagination
raises an error so the caller can retry. The API does not provide a transactional
snapshot. HTTP-200 JSON errors and non-advancing/truncated pages also raise errors.

`geometry_json` contains the complete GeoJSON feature when requested, without
clipping or simplification. Geometry is omitted by default because some polygons
are very large; the 8 MiB response limit still applies. `attributes_json` retains
original attributes. Source file and GIS ingest timestamps are separate from
product issue/validity timestamps. An empty intersection means no matching
published feature, not a guarantee that a site is free of hazards.

WPC QPF values are **contour levels**, not interpolated point rainfall amounts.
Do not add overlapping contours or accumulation periods. SPC categorical codes
are not probabilities. CPC probabilities apply to the published category relative
to climatological normal, not to the occurrence of any rain; CPC validity end dates
are inclusive dates. Drought readers preserve target-period text and exclude the
separate island-territory point layers. Fire outlooks do not represent fire
perimeters, and no issue time is substituted when only file timestamps are given.

Gauge searches use bounded NWPS geographic requests. State searches use the
[official NWS state envelopes](https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/3)
stored in `src/state_bounds.ts`, then filter the upstream state code exactly.
The bounds can be refreshed with `python3 scripts/update_state_bounds.py` followed
by `make fmt`. Nearby searches filter bounding-box candidates using great-circle
distance on a mean-radius Earth (6371.0088 km), including polar and dateline cases.
The radius is greater than zero and at most 500 km. Shared tile edges have one
owner. Use `ORDER BY distance_km` for nearest-first results. Geographic distance
is distinct from river connectivity; `river_network` returns the service's ordered
connections and does not claim immediate adjacency or a complete watershed graph.
The NWPS year-one status-time sentinel becomes NULL; original status values and
sentinels remain available in `status_json`.

### Customized multi-site queries on stock DuckDB

Stock DuckDB 2.0.0 has a
[named-options limitation in correlated table functions](https://github.com/duckdb/duckdb/pull/27833).
Literal calls with named options work. For correlated calls that need custom
options, use `nws.compat` with a final positional JSON object:

```sql
WITH sites(name, latitude, longitude) AS (
  VALUES ('Charlottesville', 38.0293, -78.4767),
         ('Richmond', 37.5407, -77.4360)
)
SELECT s.name, o.category, o.probability_pct, o.valid_from, o.valid_to
FROM sites s
LEFT JOIN LATERAL nws.compat.climate_outlook_at(
  s.latitude, s.longitude,
  '{"period":"8_14_day","variable":"precipitation"}'
) o ON true
ORDER BY s.name, o.valid_from;
```

Compatibility forms exist for all eight polygon `_at` functions, `gauges_near`,
`river_network`, `precipitation_observed_at`, `rating_curve`, `reach_streamflow`,
`soil_moisture_at`, `precipitation_anomaly_at`, `snow_analysis_at`, and `storm_reports_near`. JSON keys and defaults match the main function's named options,
including page limits. Unknown keys and invalid types are rejected; the object is
limited to 4096 characters. NULL positional inputs produce no rows. These forms
also work in Haybarn. The transport suite retains direct named-option LATERAL
cases for Haybarn 2.0.0rc11; stock verification exercises equivalent customized
calls through `nws.compat`. The SDK and engine pins have not been changed.

Both tested engines also lose rows for some computed text expressions supplied
directly as correlated arguments. Derive a computed gauge/reach ID as a named
column in a subquery, then pass that column. The working form is covered by
fixtures; the failing direct-expression case is retained in
`test/known-limitations/correlated-text-expression.sql` for upstream investigation.

## Extended outlooks, observed precipitation, and river products

Fire outlooks now include days 3–8 for both hazards. Their `category_code` is the
native probability fraction, while `probability_pct` converts positive fractions
to percent. A zero code means no delineated probability area and produces NULL
probability, not a claim of zero risk. Days 1–2 retain categorical codes and NULL
probability. Monthly and seasonal climate outlooks retain `target_period` text;
`valid_from`/`valid_to` are NULL where the source publishes no exact dates.
Seasonal `lead` selects one of 13 successive three-month windows and must be 1
for other periods.

Winter precipitation returns the published probability **band** as
`probability_min_pct`/`probability_max_pct`, plus original wording and category ID.
Snow and ice thresholds are accumulation depths in inches. WSSI returns impact
categories, with separate component and overall products. Its overall value is
the maximum component impact; components must not be added together.

```sql
SELECT category, probability_pct, target_period
FROM nws.main.climate_outlook_at(
  38.0293, -78.4767, period := 'seasonal', lead := 2,
  variable := 'precipitation');

SELECT category, probability_min_pct, probability_max_pct, valid_from
FROM nws.main.winter_precipitation_at(
  38.0293, -78.4767, hazard := 'ice', threshold_inches := 0.25);

SELECT impact, valid_from, valid_to
FROM nws.main.winter_storm_severity_at(38.0293, -78.4767);

SELECT precipitation, unit, issued_at
FROM nws.main.precipitation_observed_at(38.0293, -78.4767, period := 'day7');
```

`precipitation_observed_at` samples the latest RFC QPE raster's raw pixel, not its
rendered class or color. Values are estimated observed precipitation in **inches**,
not forecasts or point rain-gauge measurements. NoData is NULL, zero is retained,
and no raster coverage returns no rows. Separate overlapping rasters remain
separate rows. The source issuance time is reported without inventing observation
interval boundaries. `attributes_json`, `footprint_json`, and `metadata_url`
preserve the pixel and raster provenance. Raster publication is not a transactional
snapshot; missing or mismatched footprint metadata raises an error.

Its `period` choices are `since_12z`, `hour1`, `hour2`, `hour3`, `hour6`, `hour12`,
`hour24` (default), `today`, `day2`, `day3`, `day4`, `day5`, `day6`, `day7`, `day10`,
`day14`, `day30`, `day60`, `day90`, `day120`, `day180`, `day365`, `month_to_date`,
`year_to_date`, and `water_year_to_date`. `today` is the published daily analysis,
not necessarily a local-midnight total. Do not sum overlapping periods.

| River reader | Meaning and options |
| --- | --- |
| `rating_curve(gauge_id)` | Stage-discharge points; `row_limit := 10000` (1–10000), `sort := 'ASC'` or `'DESC'`, `only_tenths := false` |
| `reach(reach_id)` | Model segment metadata, available products, and neighboring reach IDs/stream order |
| `reach_streamflow(reach_id)` | Model series; `series := 'short_range'`, also analysis_assimilation, medium_range, long_range, medium_range_blend |
| `low_water_threshold(gauge_id)` | Published threshold and native unit; absent thresholds produce no rows |
| `low_water_impacts(gauge_id)` | Original associated value text and low-water impact statement |
| `historic_low_water(gauge_id)` | Curated historical low events with occurrence, stage, flow, units, and statement |

Rating curves have no documented pagination offset. `possibly_truncated` is true
when the returned count reaches `row_limit`; such a result is not guaranteed to
be the complete curve. Ratings are not interpolated. Negative gauge stages can
be valid and are retained. Low-water impact value text has no inferred units.

Model streamflow retains `series`, `member`, `reference_at`, `valid_at`, and native
`flow_unit`. Means and members are separate series; never sum them. Assimilated
analysis is still model output, not a direct observation. A series advertised by
reach metadata may currently contain no data. These APIs expose the available
window, not a complete model-run archive.

```sql
SELECT stage, stage_unit, flow, flow_unit, possibly_truncated
FROM nws.main.rating_curve('RMDV2', only_tenths := true)
ORDER BY stage;

SELECT g.gauge_id, m.member, m.valid_at, m.flow, m.flow_unit
FROM nws.main.gauge('RMDV2') g,
LATERAL nws.compat.reach_streamflow(g.reach_id, '{"series":"long_range"}') m
ORDER BY m.member, m.valid_at;

SELECT occurred_at, stage, stage_unit, statement
FROM nws.main.historic_low_water('RMDV2')
ORDER BY occurred_at;
```

Product contracts are verified against the official
[SPC fire layers](https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer),
[CPC monthly temperature](https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_mthly_temp_outlk/MapServer),
[CPC seasonal temperature](https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_sea_temp_outlk/MapServer),
[WPC winter precipitation](https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_prob_winter_precip/MapServer),
[WSSI](https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer),
[RFC QPE](https://mapservices.weather.noaa.gov/raster/rest/services/obs/rfc_qpe/MapServer),
and [NWPS OpenAPI](https://api.water.noaa.gov/nwps/v1/docs/swagger.json).

## Data semantics and boundaries

- Times are Arrow UTC timestamps exposed as `TIMESTAMP WITH TIME ZONE`. DuckDB
  displays them in the connection timezone; use `SET TimeZone = 'UTC'` when
  desired. Missing measurements remain SQL NULL. Zero remains zero.
- Observation temperature/dewpoint use Celsius, wind speed uses metres/second,
  pressure uses pascals, visibility metres, and precipitation millimetres.
  `measurements_json` retains original units and quality-control flags. Unsupported
  conversions raise an error. Forecast wind speed remains original text because
  it may be a range.
- Every network row has `source_url` and `fetched_at`. Retrieval time is distinct
  from observation, issue, update, and validity times. Cache hits retain their
  original retrieval time; successful HTTP revalidation updates it.
- `grid_series` retains native WMO units and validity intervals. Its `value` is
  NULL for structured values; `value_json` preserves weather and hazard objects.
  Empty `variable` returns every available layer. It does not resample grids.
- `stageflow` keeps observed and forecast products separate. Stage is relative to
  the gauge datum, not absolute elevation. Threshold flow units can differ from
  time-series flow units (`cfs` versus `kcfs`). Historic crests can use an older
  datum; inspect `old_datum` before comparisons.
- NWS coverage is limited to its service areas. A grid or forecast can be
  unavailable for an otherwise valid coordinate. Grid mappings can change.
- Recent alerts and station observations typically cover roughly seven days;
  product and NWPS time-series windows are whatever the upstream service supplies.
  These readers are not a general historical archive. Observations may arrive
  after quality-control delays. Historic crests are a curated list.
- An inactive office briefing returns zero rows. HTTP failures, invalid input,
  malformed payloads, pagination cycles, and page limits raise errors. NWS
  collection pagination stops at an empty page because the station endpoint can
  supply another cursor even after its final result.
- Briefings and weather stories expose download links without fetching PDFs or
  images. Native MRMS grids use ecCodes; generic GIS image readers preserve raw
  bands (rendered radar RGBA colors are not dBZ). Aviation API responses and NHC
  GIS features are available. These services are not long-term archives.

Authoritative references: [NWS web API documentation](https://www.weather.gov/documentation/services-web-api),
[NWS OpenAPI](https://api.weather.gov/openapi.json),
[NWPS API documentation](https://api.water.noaa.gov/nwps/v1/docs/), and
[NWPS OpenAPI](https://api.water.noaa.gov/nwps/v1/docs/swagger.json),
[NWS GIS catalog](https://www.weather.gov/gis/IDP-GISRestMetadata), and
[NWS vector services](https://mapservices.weather.noaa.gov/vector/rest/services).

## Configuration and transport

| Variable | Default and purpose |
| --- | --- |
| `NWS_USER_AGENT` | `vgi-nws/0.4.0 (https://query.farm)`; set an identifying application/contact string |
| `NWS_API_BASE_URL` | `https://api.weather.gov`; trusted server-level override for tests or a proxy |
| `NWPS_API_BASE_URL` | `https://api.water.noaa.gov/nwps/v1`; trusted server-level override for tests or a proxy |
| `NWS_RASTER_BASE_URL` | `https://mapservices.weather.noaa.gov/raster/rest/services`; trusted RFC raster root override for tests or a proxy |
| `NWS_GIS_BASE_URL` | `https://mapservices.weather.noaa.gov/vector/rest/services`; trusted GIS root override for tests or a proxy |

API roots cannot be supplied by SQL callers. Pagination/point links are checked
against the canonical or configured root; cross-origin links and HTTP redirects
are rejected. HTTP requests have a 15-second timeout, at most three attempts,
and four concurrent in-flight operations per worker process. Retry-After accepts
seconds or an HTTP date; a delay over 30 seconds is reported as an error rather
than retried prematurely. Repeated requests are coalesced. The process cache
honors max-age, Age, Date, no-cache, no-store, ETag, and Last-Modified. It is bounded
to 128 entries and 16 MiB of source text/binary data; individual responses are
limited to 8 MiB (32 MiB for MRMS binary downloads). No stale-on-error result or persistent cache is used.
ArcGIS server errors embedded in HTTP 200 responses use the same bounded retry
policy. Failed application responses are never cached, and persistent failures
retain the source error message.

Each upstream page emits an Arrow batch. Continuation state contains only a
bounded input batch, page counters, and cursors; it contains no output pages or
credentials. `grid_series` and NWPS endpoints return one bounded JSON document.
Poll responsibly and use the timestamps to assess freshness; do not assume SQL
invocations each fetch a new upstream representation.

```sh
bin/vgi-nws-worker                         # stdio
bin/vgi-nws-worker --http --port 8000       # HTTP, /health
bin/vgi-nws-worker --help                  # Unix socket and other options
```

For an HTTP worker, load DuckDB's `httpfs` extension and attach with
`LOCATION 'http://127.0.0.1:8000'`. For pooled local Unix connections, use
`LOCATION 'launch:/absolute/path/bin/vgi-nws-worker'`.

The included Dockerfile supports HTTP by default and `docker run -i IMAGE stdio`.
Docker build/run is covered by the CI scaffold, separately from local SQL checks.

## Soil moisture, rainfall anomalies, snowpack, and storm reports

| Function | Options and meaning |
|---|---|
| `soil_moisture_at(latitude, longitude)` | `region := 'auto'` checks CONUS, Alaska, Hawaii, and Puerto Rico; an explicit region is also supported. Returns modeled saturation for the top 40 cm, with native fractions and percent saturation. |
| `precipitation_anomaly_at(latitude, longitude)` | `period := 'day30'`, `metric := 'all'`; separate rows for normal rainfall, departure, and percent of normal. |
| `snow_analysis_at(latitude, longitude)` | `variable := 'both'`, `'depth'`, or `'water_equivalent'`; analyzed current snowpack with native values and millimetre conversions. |
| `storm_reports()` | `lookback_hours := 24` (24/48/72), optional `state`, `event`, and `bbox`; recent preliminary NWS Local Storm Reports. |
| `storm_reports_near(latitude, longitude)` | Same report filters, with `radius_km := 50` (greater than zero, at most 500) instead of bbox. Exact great-circle distance filtering follows geographic retrieval. |

```sql
SELECT region, saturation_pct, soil_depth_cm, valid_at
FROM nws.main.soil_moisture_at(38.0293, -78.4767);

SELECT metric, value, unit, issued_at
FROM nws.main.precipitation_anomaly_at(38.0293, -78.4767,
  period := 'day30')
ORDER BY metric;

SELECT variable, raw_value, raw_unit, value_mm, valid_at
FROM nws.main.snow_analysis_at(46.85, -121.76)
ORDER BY variable;

SELECT event, magnitude_text, unit, distance_km, reported_at
FROM nws.main.storm_reports_near(38.0293, -78.4767,
  lookback_hours := 72, radius_km := 100)
ORDER BY distance_km, object_id;
```

Soil saturation is modeled, not a garden sensor measurement, volumetric water
content, or an irrigation prescription. Rainfall anomalies use the RFC service's
published comparisons with PRISM normals. Negative departures are deficits;
percent of normal can exceed 100 and is not a probability. Supported anomaly
periods are `today`, `day7`, `day10`, `day14`, `day30`, `day60`, `day90`, `day120`,
`day180`, `day365`, `month_to_date`, `year_to_date`, and `water_year_to_date`.
These follow the source's 12Z daily accounting. The worker reads the published
comparison pixels without inferring baseline years or dividing by a zero normal.

Snow depth and water equivalent are different quantities: native GRIB depth is
metres, while water equivalent is kg/m². `value_mm` converts these to millimetres
of snow depth and millimetres of liquid-water equivalent, respectively. The
inches displayed in the map legend are not the units of its raw service pixels.
Each variable retains its own valid time; never sum the two variables. These
NOHRSC analyses cover the conterminous US and describe existing snowpack, not
new snowfall or a forecast.

All three raster readers preserve zero, return NULL for NoData within a known
footprint, and return no rows when no raster covers the point. Overlapping
rasters remain separate rows with their IDs, names, native attributes, and
footprint metadata. Valid, issued, source-file, ingestion, and retrieval times
remain separate; absent source times stay NULL. These services are not archives.

Storm reports retain qualified magnitude text such as `E60` or `Trace`; numeric
`magnitude` is populated only when the entire text is numeric. Units depend on
the event. Reports may be preliminary, corrected, or duplicate observations of
the same event. Distinct report IDs remain distinct. An empty result does not
establish that no event occurred. State and case-insensitive exact event filters
apply across all fetched pages. Geographic searches support dateline and polar
locations; `include_geometry := true` adds WGS84 GeoJSON. Standard `page_size`
and `max_pages` options bound paging, with an error instead of silent truncation.

Sources: [NWM land analysis](https://mapservices.weather.noaa.gov/raster/rest/services/obs/NWM_Land_Analysis/MapServer),
[RFC precipitation](https://mapservices.weather.noaa.gov/raster/rest/services/obs/rfc_qpe/MapServer),
[NOHRSC snow analysis](https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer),
[NCEP GRIB2 moisture units](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_table4-2-0-1.shtml),
and [Local Storm Reports](https://mapservices.weather.noaa.gov/vector/rest/services/obs/nws_local_storm_reports/MapServer).

## Additional guidance and map products

| Functions | Products |
| --- | --- |
| `map_products()`, `map_layers(product_id)`, `map_fields(product_id)` | Discover services, current layer IDs, fields and coded domains on the four public NWS GIS servers |
| `map_features(product_id, layer_id)`, `map_features_at(product_id, layer_id, latitude, longitude)` | Native feature attributes and optional WGS84 geometry, with paging and spatial filtering |
| `map_raster_at(product_id, layer_id, latitude, longitude)` | Native mosaic pixels with source footprints |
| `map_image_at(product_id, latitude, longitude)` | Every matching ImageServer raster and band, with optional validity-window and subset filters |
| `flash_flood_guidance_at(latitude, longitude, hours := 3)` | 1/3/6-hour and regional 12-hour rainfall thresholds in millimetres and inches |
| `mesoscale_discussions()`, `mesoscale_discussions_at(latitude, longitude)` | Current SPC discussion areas, identifiers and source popup text |
| `weather_hazards()`, `weather_hazards_at(latitude, longitude)` | CPC/WPC days 3–7 and 8–14 hazards by source layer group |
| `winter_storm_probability()`, `winter_storm_probability_at(latitude, longitude)` | WSSI-P contours by component, impact threshold and rolling 24-hour forecast window |
| `river_flood_outlook()`, `river_flood_outlook_at(latitude, longitude)` | Significant river flooding outlooks |
| `long_range_flood_outlook()` | Three-month gauge probabilities, preserving censored ranges and native season labels |
| `beach_forecast()`, `beach_forecast_at(latitude, longitude)` | Day 1/2 surf, rip-current risk, water temperature and other office forecast text |
| `air_quality_at(latitude, longitude)` | PM2.5, ozone, smoke and dust forecast series from all 18 published services |

Generic GIS readers retain native attributes so less common products such as sea
ice, river breakup, spot forecasts and surface analyses remain queryable. Discover
IDs instead of assuming they remain fixed across service updates. Image sampling
pages the raster catalog and locks each page's raster IDs, avoiding the service's
silent mosaic limit. Color bands remain color bands; generic readers do not infer
physical units from display pixels or coordinate units.

```sql
SELECT product_id, service_type
FROM nws.main.map_products(server := 'raster', folder := 'air_quality')
ORDER BY product_id;

SELECT valid_from, valid_to, value, unit, issued_at
FROM nws.main.air_quality_at(38.0293, -78.4767, product := 'pm25_1h')
ORDER BY valid_from, raster_id;

SELECT hours, threshold_mm, threshold_inches
FROM nws.main.flash_flood_guidance_at(38.0293, -78.4767, hours := 6);
```

Air-quality selectors are `pm25_1h`, `pm25_24h`, `pm25_daily_max`, `ozone_1h`,
`ozone_8h`, `ozone_daily_max_1h`, `ozone_daily_max_8h`, `smoke_surface`,
`smoke_column`, `dust_surface`, and `dust_column`. The first seven also support
`bias_corrected := true`. Source descriptions conflict on smoke/column units;
those units stay NULL, with the original description and an interpretation note.
No AQI or health category is inferred. Missing pixels stay NULL and zero stays zero.

WSSI-P supports `forecast_hour := 24,30,...,168`, or zero for all available leads;
overlapping contours and rolling windows must not be added together. Flash flood
guidance describes a rainfall threshold, not forecast rainfall or a warning. The
retired 24-hour guidance is rejected. Beach wording retains native units/ranges;
`has_forecast` distinguishes locations with placeholder product dates.

The broader product expansion is tracked in `product-coverage.json`. Its pending
families and verification fields are not a declaration that every NWS product is
implemented. Official references: [NWS GIS services](https://mapservices.weather.noaa.gov/),
[FFLDG units](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_table4-2-1-0.shtml),
and [ImageServer sampling](https://developers.arcgis.com/rest/services-reference/enterprise/get-samples/).

## Development and verification

```sh
make check       # static checks, unit tests, all SQL transports, metadata, stock DuckDB
make test-stock  # stock DuckDB 2.0.0 with deterministic local API fixtures
make test-live   # explicit opt-in: real NWS and NWPS, stock DuckDB 2.0.0
make lint-ai     # optional L3 agent tasks (requires the claude CLI)
```

The SQLLogicTest transport harness uses **Haybarn 2.0.0rc11**. It is distinct from
the stock **DuckDB 2.0.0** verifier, which installs the signed VGI extension from
the `query_farm` extension repository. Fixture queries cover every function,
multiple pages, NULLs, duplicate sites, lateral fan-out, continuation over HTTP,
units, timestamps, errors, retries, and empty terminal pages. Metadata validation
also runs against fixtures; live service availability is not a normal CI gate.
The schema-size guidance (`VGI117`) has a documented domain exemption: the stable
`nws.main` namespace now contains 92 fully documented functions. Other metadata
warnings and errors remain blocking.

`vgi-worker.json` contains explicit stock-engine result assertions.
`verification.json` and `verification-live.json` record the most recent fixture
and opt-in live runs. `scripts/verify_worker.py` is copied from the vgi-worker
skill's verifier; `ci/verify.py` supplies fixture isolation and the opt-in live
manifest. Dependencies remain locked: `@query-farm/vgi` 0.50.0,
`@query-farm/vgi-rpc` 0.29.7, and `@query-farm/apache-arrow` 21.1.1.

Implementation lives in `src/weather.ts`, `src/water.ts`, `src/outlooks.ts`,
`src/gis.ts`, `src/water_discovery.ts`, `src/water_extended.ts`, `src/winter.ts`,
`src/precipitation.ts`, `src/raster.ts`, `src/land.ts`, `src/storm_reports.ts`,
`src/spatial.ts`, `src/reader.ts`,
`src/http.ts`, and `src/valid_time.ts`. Add a reader specification, a fixture, SQL
assertions, metadata examples, and an agent task when extending the catalog.
The `examples/` directory retains the starter's standalone SDK recipes.

## Native MRMS grids with ecCodes

The worker stays in TypeScript. `mrms_at` runs ECMWF's native `grib_ls` and
`grib_get` tools in isolated subprocesses. No Python runtime is required.
The Docker image includes ecCodes and tests PNG decoding during its build.
For a local or compiled worker, install the native tools separately:

```sh
# macOS
brew install eccodes
# Debian / Ubuntu
sudo apt-get install libeccodes-tools
# Alternatively, in an activated conda environment (including Windows)
conda install -c conda-forge eccodes
```

Both tools must be on the worker's `PATH`. Set `NWS_ECCODES_BIN` to their directory
when using another installation. An ecCodes source build must explicitly enable
`-DENABLE_PNG=ON`; upstream defaults PNG off. See the
[ecCodes installation instructions](https://confluence.ecmwf.int/display/ECC/ecCodes+installation).
After installing, verify the codec using the repository's synthetic fixture:

```sh
grib_get -F %.17g -p bitmapPresent -i 330 test/fixtures/grib/png.grib2
# Expected: 0 2.5
```

Only `mrms_at` needs this dependency; other readers can run without it. The full
test suite requires it. Standalone Bun executables do not bundle native ecCodes.

```sql
SELECT product_id, unit, description
FROM nws.main.mrms_products()
WHERE kind = 'directory'
ORDER BY product_id;

SELECT filename, level, file_time
FROM nws.main.mrms_products(folder := '2D/PrecipRate')
ORDER BY file_time DESC, level;

SELECT valid_at, value, unit, value_status, grid_latitude, grid_longitude
FROM nws.main.mrms_at('2D/PrecipRate', 38.0293, -78.4767)
ORDER BY valid_at;
```

Discovery also starts at `3DRefl`, `3DRhoHV`, or `3DZdr`. Follow returned directory
paths for regional products. The default sample selects the newest retained file
and its lowest native filename level. Pass `file_time` and `level` to select a
specific listed file. These directories have short retention, so record the exact
`filename` and `source_url` if reproducibility matters.

Samples retain the native grid cell, parameter codes, reference/validity times,
packing template, surface level, and original value. Units and special codes come
from NOAA NSSL's published parameter table: ecCodes does not identify every MRMS
local parameter. Recognized nonzero missing/no-coverage/folded codes become NULL
in `value` while remaining visible in `raw_value`; bitmap missing is NULL in both.
Real zero and real `9999` values survive. Ambiguous zero codes are labeled;
unknown parameters retain raw values with NULL units. Sample values use 17-digit
output because ecCodes' nearest-point JSON rounds numbers.

This reader accepts one regular latitude/longitude GRIB2 field per file. Points
outside its grid produce no rows. Corrupt, multi-field or unsupported grids raise
errors. Each sample downloads a complete grid: HTTP downloads are bounded to
32 MiB, decompressed GRIB to 64 MiB, and grids to 64 million points. Native decodes
run one at a time per worker, with a 30-second limit for each ecCodes command.
Temporary files are removed after completion or errors. For many locations,
prefer the GIS raster readers where the product is available; caching avoids
some repeated downloads but each `mrms_at` call still decodes its selected grid.
`NWS_MRMS_BASE_URL` overrides the trusted MRMS root for fixture testing.

Synthetic GRIB fixtures are checked in under `test/fixtures/grib`; they are generated
by ecCodes itself using `scripts/generate_grib_fixtures.py`. Python and its ecCodes
bindings are needed only to regenerate those fixtures.

## Additional API and file readers

| Functions | Data |
|---|---|
| `api_endpoints`, `api_rows` | Schema-discovered NWS weather, NWPS and Aviation Weather Center operations, preserving original records/text |
| `river_at_a_glance` | NWPS summaries for a bounded list of gauge IDs |
| `buoy_stations`, `buoy_products`, `buoy_measurements` | NDBC station metadata, available files, observations and spectra with native units |
| `space_weather_products`, `space_weather_rows` | SWPC file discovery, JSON records and original text bulletins |
| `tropical_features`, `tropical_features_at` | NHC tracks, cones, watches, wind and surge features with original attributes |

Use the function metadata for selectors, paging and examples. Current storm
layers can legitimately be empty. A tropical forecast cone represents track
uncertainty; its boundary is not an impact boundary.

The ecCodes integration was verified with `make check`: 62 Bun tests, Haybarn
2.0.0rc11 SQLLogicTest assertions over stdio (1,107), launch (1,107), and HTTP
(1,076), metadata assurance L2 at 100/100, and 407 stock DuckDB 2.0.0 assertions.
The SDK remains `@query-farm/vgi` 0.50.0 with RPC 0.29.7. Docker was built and
its ecCodes 2.41.0 decoded PNG, bitmap, forecast and interval fixtures; local
macOS used ecCodes 2.50.1. Windows CI is configured but was not run locally.
`verification-mrms-live.json` records the additional live stock-DuckDB MRMS
queries and their actual values and source file. The opt-in `make test-live`
manifest includes MRMS discovery, QPE, precipitation rate and outside-grid checks.

## Executed notebook

[Count forecast hours, not compressed rows](notebooks/README.md) demonstrates native temperature intervals, duration weighting and a separate threshold experiment with a portable pinned worker launch.
