/**
 * The worker entry point.
 *
 *   bin/vgi-nws-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-nws-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *   bin/vgi-nws-worker --help
 *
 * Attach it from DuckDB:
 *
 *   ATTACH 'nws' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-nws-worker');
 */

import { CATALOG } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, VERSION } from "./meta.ts";

if (import.meta.main) {
  serve(CATALOG, { version: VERSION, doc: CATALOG_DOC_LLM });
}
