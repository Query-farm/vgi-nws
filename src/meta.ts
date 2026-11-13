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
export const VERSION = "0.4.0";

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

export const CATALOG_DOC_LLM =
  "Read US National Weather Service and National Water Prediction Service data as SQL tables. Use point and stations_at to resolve locations; alerts and alerts_at for hazards; forecast, forecast_hourly, and grid_series for predictions; observations and latest_observation for measurements; products, product, and latest_product for original bulletins; zone and zones for boundaries; briefing and weather_stories for office assets; gauge, stageflow, flood_thresholds, flood_impacts, and historic_crests for rivers. Use severe_outlook, fire_outlook, rainfall_outlook, precipitation_forecast, climate_outlook, and drought_outlook for GIS polygons, or their _at variants for a point. Use gauges, gauges_near, and river_network to discover river locations and connections. Fire outlooks extend through day 8; climate_outlook also supports monthly and seasonal leads 1–13. Use winter_precipitation for snow/ice probability bands, winter_storm_severity for impact categories, and precipitation_observed_at for RFC raster rainfall estimates. Use rating_curve for stage-discharge relationships, reach and reach_streamflow for National Water Model products, and low_water_threshold, low_water_impacts, and historic_low_water for low-water information. Use soil_moisture_at for modeled near-surface saturation, precipitation_anomaly_at for rainfall normals/departures/percent of normal, snow_analysis_at for analyzed depth and water equivalent, and storm_reports or storm_reports_near for recent preliminary local reports. Use map_products, map_layers and map_fields to discover other public GIS layers, map_features/map_features_at for native attributes and geometry, and map_raster_at/map_image_at for native pixels. Use flash_flood_guidance_at for rainfall thresholds, air_quality_at for particulate/ozone/smoke/dust series, mesoscale_discussions for SPC discussions, weather_hazards for days 3–14 outlooks, winter_storm_probability for rolling WSSI-P windows, river_flood_outlook and long_range_flood_outlook for flood outlooks, and beach_forecast for coastal forecast wording. Use api_endpoints and api_rows for schema-discovered weather, water and aviation API operations; river_at_a_glance for river summaries; buoy_stations, buoy_products and buoy_measurements for NDBC files; space_weather_products and space_weather_rows for SWPC JSON and bulletins; tropical_features and tropical_features_at for NHC vector products; and mrms_products/mrms_at for native MRMS grids decoded with ecCodes (PNG support required). Positional arguments accept column and LATERAL calls. No API key is required. Times are UTC `TIMESTAMPTZ`, missing data is NULL, grid and river units are retained. Upstream HTTP caching is honored. HTTP errors are raised rather than silently returning no rows. Current APIs are not comprehensive historical archives.";
export const CATALOG_DOC_MD =
  "# NWS and NWPS for DuckDB\n\n" +
  CATALOG_DOC_LLM +
  "\n\nSet NWS_USER_AGENT to an identifying application/contact string. See [NWS documentation](https://www.weather.gov/documentation/services-web-api) and [NWPS documentation](https://api.water.noaa.gov/nwps/v1/docs/).";
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
