/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "nws";
export const VERSION = "0.6.0";

export const SOURCE_URL = "https://www.weather.gov/documentation/services-web-api";
export const SCHEMA_CATEGORIES = [
  { name: "weather", title: "Weather", description: "Alerts, observations, forecasts, offices, and text products." },
  {
    name: "water",
    title: "Rivers and floods",
    description: "NWPS gauges, ratings, flood and low-water information, and National Water Model reach streamflow.",
  },
  { name: "reference", title: "Reference", description: "NWS glossary and product discovery." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

/** The catalog's one-line description: plain text, no Markdown. The long guide lives in the doc tags. */
export const CATALOG_COMMENT =
  "US National Weather Service forecasts, alerts, observations and bulletins, river gauges and flood forecasts, plus NOAA outlook maps, buoys, space weather and MRMS radar grids, as SQL tables. No API key needed.";
export const CATALOG_DOC_LLM =
  "Read US National Weather Service (NWS) and National Water Prediction Service (NWPS) data, plus related NOAA products, as SQL tables. The worker covers four kinds of data: weather (alerts, observations, gridded forecasts, original text bulletins, zones and forecast-office assets); rivers and floods (NWPS gauges, stage/flow forecasts, flood thresholds and impacts, rating curves, low-water information and National Water Model reaches); spatial products from the NOAA/NWS GIS map services (SPC, WPC and CPC outlook polygons, winter and hazard outlooks, observed and analyzed rainfall, soil moisture, snow and air-quality rasters, storm reports); and other NOAA feeds (NDBC buoys, SWPC space weather, NHC tropical products, AviationWeather.gov and native MRMS radar grids). How the parts fit: start from a latitude/longitude with the point lookup to find the forecast office, grid cell and nearby stations, or pass a known station, office, zone or NWPS gauge ID directly. Readers with an _at suffix intersect a product with one point; their unsuffixed counterparts return the whole product. Discovery functions list GIS layers, API operations, buoy files and MRMS products so generic readers can fetch them. Positional arguments accept columns and correlated LATERAL calls; named options inside a LATERAL call need DuckDB 2.0.1 or later. No API key is required. Times are UTC `TIMESTAMPTZ`, missing data is NULL, and grid, river and gauge-datum units are kept as published. Network readers include source_url and fetched_at, honor upstream HTTP caching and raise HTTP errors rather than silently returning no rows. Outlook probabilities and categories are forecast products, not active warnings. The upstream APIs serve current and recent data, not comprehensive historical archives.";
export const CATALOG_DOC_MD =
  "# NWS and NWPS for DuckDB\n\n" +
  CATALOG_DOC_LLM +
  "\n\nSet NWS_USER_AGENT to an identifying application/contact string. See [NWS documentation](https://www.weather.gov/documentation/services-web-api) and [NWPS documentation](https://api.water.noaa.gov/nwps/v1/docs/).\n\n## Sources and references\n\n" +
  "- [NWS API Web Service](https://www.weather.gov/documentation/services-web-api): forecasts, alerts, observations, zones and bulletins (api.weather.gov).\n" +
  "- [National Water Prediction Service API](https://api.water.noaa.gov/nwps/v1/docs/): river gauges, stage/flow forecasts, flood thresholds and National Water Model reaches.\n" +
  "- [NOAA/NWS GIS map services](https://mapservices.weather.noaa.gov/vector/rest/services): the ArcGIS REST services behind the outlook, map and raster readers.\n" +
  "- [Space Weather Prediction Center](https://www.swpc.noaa.gov/), [National Data Buoy Center](https://www.ndbc.noaa.gov/), [AviationWeather.gov Data API](https://aviationweather.gov/data/api/) and the [MRMS product server](https://mrms.ncep.noaa.gov/): the remaining upstreams read by the space weather, buoy, aviation and MRMS functions.";
/** Short plain-text schema COMMENT; SCHEMA_DOC_MD carries the longer narrative. */
export const SCHEMA_COMMENT =
  "National Weather Service and National Water Prediction Service readers: forecasts, alerts, observations, bulletins, GIS outlooks, river gauges and related NOAA products.";
export const SCHEMA_DOC_LLM =
  "The main schema exposes weather, spatial outlook, and river readers plus the offline parse_valid_time interval helper. Start with point to discover a forecast office and grid, or use a station ID, office ID, or NWPS gauge ID directly. Positional inputs accept correlated LATERAL joins. Use land _at readers for modeled soil saturation, rainfall anomalies and analyzed snowpack, and storm_reports_near for radius searches of recent local reports. Use GIS outlook _at readers for point intersections, gauges_near for geographic river discovery, and alerts_at for zone-aware point alerts; use latest_product for complete bulletin text. Each network reader includes source_url and fetched_at; grid and river units remain explicit.";
export const SCHEMA_DOC_MD = `## Weather, water, and reference functions\n\n${SCHEMA_DOC_LLM}\n\nWeather readers preserve upstream missing values, timestamps, alert zones, and forecast intervals. River readers expose native units and gauge datums. Use parse_valid_time for an offline interval example.`;
export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "National Weather Service",
  "vgi.subtitle": "Explore US weather alerts, observations, forecast grids, bulletins, and river conditions.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray("NWS, NOAA, NWPS, weather, alerts, forecast, rivers, flood, DuckDB"),
  "vgi.support_contact": "https://query.farm",
  "vgi.support_policy_url": "https://query.farm",
};
export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Weather and Water",
  domain: "meteorology",
  "vgi.keywords": keywordsArray("weather, water, NWS, NWPS, observations, forecasts"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
