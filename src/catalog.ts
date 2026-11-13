/**
 * Assemble the functions into the catalog DuckDB attaches.
 *
 * The shared reader adapter supplies streaming, provenance, and lateral joins.
 */

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { AIR_QUALITY_FUNCTIONS } from "./air_quality.ts";
import { API_FUNCTIONS } from "./api_catalog.ts";
import { HAZARD_EXTENSION_FUNCTIONS } from "./hazards_extended.ts";
import { IMAGE_FUNCTIONS } from "./image_service.ts";
import { LAND_FUNCTIONS } from "./land.ts";
import { MAP_CATALOG_FUNCTIONS } from "./map_catalog.ts";
import {
  CATALOG_DOC_MD,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_CATEGORIES,
  SCHEMA_DOC_MD,
  SCHEMA_TAGS,
  SOURCE_URL,
} from "./meta.ts";
import { MRMS_FUNCTIONS } from "./mrms.ts";
import { NDBC_FUNCTIONS } from "./ndbc.ts";
import { OUTLOOK_FUNCTIONS } from "./outlooks.ts";
import { PRECIPITATION_FUNCTIONS } from "./precipitation.ts";
import { SPACE_WEATHER_FUNCTIONS } from "./space_weather.ts";
import { STORM_REPORT_FUNCTIONS } from "./storm_reports.ts";
import { TROPICAL_FUNCTIONS } from "./tropical.ts";
import { parseValidTime } from "./valid_time.ts";
import { WATER_FUNCTIONS } from "./water.ts";
import { WATER_DISCOVERY_FUNCTIONS } from "./water_discovery.ts";
import { WATER_EXTENDED_FUNCTIONS } from "./water_extended.ts";
import { WATER_GLANCE_FUNCTIONS } from "./water_glance.ts";
import { WEATHER_FUNCTIONS } from "./weather.ts";
import { WINTER_FUNCTIONS } from "./winter.ts";

export const FUNCTIONS: VgiFunction[] = [
  ...WEATHER_FUNCTIONS,
  ...WATER_FUNCTIONS,
  ...OUTLOOK_FUNCTIONS,
  ...WATER_DISCOVERY_FUNCTIONS,
  ...PRECIPITATION_FUNCTIONS,
  ...WATER_EXTENDED_FUNCTIONS,
  ...WATER_GLANCE_FUNCTIONS,
  ...WINTER_FUNCTIONS,
  ...LAND_FUNCTIONS,
  ...STORM_REPORT_FUNCTIONS,
  ...MAP_CATALOG_FUNCTIONS,
  ...IMAGE_FUNCTIONS,
  ...HAZARD_EXTENSION_FUNCTIONS,
  ...AIR_QUALITY_FUNCTIONS,
  ...API_FUNCTIONS,
  ...NDBC_FUNCTIONS,
  ...SPACE_WEATHER_FUNCTIONS,
  ...TROPICAL_FUNCTIONS,
  ...MRMS_FUNCTIONS,
  parseValidTime,
];

interface Example {
  description: string;
  sql: string;
}

/**
 * Publish each function's examples as `vgi.example_queries` (with descriptions).
 *
 * Overloads share one SQL name, so their examples are merged per name.
 * Returns every example, for the schema-level list.
 */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const byName = new Map<string, Example[]>();
  for (const fn of functions) {
    const bucket = byName.get(fn.meta.name) ?? [];
    byName.set(fn.meta.name, bucket);
    for (const ex of fn.meta.examples ?? []) {
      if (!bucket.some((e) => e.sql === ex.sql)) bucket.push({ description: ex.description, sql: ex.sql });
    }
  }
  for (const fn of functions) {
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(byName.get(fn.meta.name)) };
  }
  return [...byName.values()].flat();
}

const MAIN_FUNCTIONS = FUNCTIONS.filter((fn) => fn.meta.tags?.["nws.compat"] !== "true");
const COMPAT_FUNCTIONS = FUNCTIONS.filter((fn) => fn.meta.tags?.["nws.compat"] === "true");
const ALL_EXAMPLES = stampExampleQueries(MAIN_FUNCTIONS);
const COMPAT_EXAMPLES = stampExampleQueries(COMPAT_FUNCTIONS);
const COMPAT_DOC =
  "Positional JSON options for correlated SQL calls on stock DuckDB 2.0.0, whose binder cannot accept named options in a LATERAL call. These readers mirror the corresponding main-schema functions, with a final options_json positional argument. JSON keys and defaults match the main-schema named options. NULL inputs emit no rows; invalid JSON, unknown keys, and wrong value types raise errors.";

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_DOC_MD,
  sourceUrl: SOURCE_URL,
  tags: {
    ...CATALOG_TAGS,
    "vgi.agent_test_tasks": JSON.stringify(
      FUNCTIONS.map((fn) => ({
        name: `${fn.meta.tags?.["nws.compat"] === "true" ? "compat_" : ""}${fn.meta.name}`,
        prompt: `Using the nws worker, ${fn.meta.examples?.[0]?.description || fn.meta.description}.`,
      })),
    ),
  },
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: MAIN_FUNCTIONS,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
    {
      path: ["compat"],
      comment: COMPAT_DOC,
      functions: COMPAT_FUNCTIONS,
      tags: {
        ...SCHEMA_TAGS,
        "vgi.title": "SQL compatibility",
        "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
        "vgi.doc_llm": COMPAT_DOC,
        "vgi.doc_md": `## Correlated calls with options\n\n${COMPAT_DOC}\n\nUse the main schema for ordinary literal calls and for correlated calls with defaults. This schema offers positional configuration for customized correlated reads on stock DuckDB 2.0.0.`,
        "vgi.example_queries": JSON.stringify(COMPAT_EXAMPLES.slice(0, 12)),
      },
    },
  ],
};
