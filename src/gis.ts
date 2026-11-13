/** Curated NWS ArcGIS reader. No caller-provided endpoints or SQL predicates. */
import { getJson, gisFailure, type MapService } from "./http.ts";
import {
  type Args,
  arr,
  type Col,
  coords,
  json,
  num,
  type ObjectData,
  obj,
  type Page,
  provenance,
  query,
  type Row,
} from "./reader.ts";
import { parseBounds } from "./spatial.ts";
export interface Layer {
  service: string;
  name: string;
  root?: MapService;
  id?: number;
  idField?: string;
  snapshot?: boolean;
}
interface Cursor {
  layerId: number;
  limit: number;
  region: number;
  lastId: number;
  edition: string | null;
  seenIds: number[];
}
export const GIS_COLUMNS: Col[] = [
  ["object_id", "number", "Upstream feature ID, unique only within the layer and current publication."],
  ["layer_name", "text", "Exact upstream layer name resolved from service metadata."],
  ["source_file_at", "time", "UTC source file timestamp, distinct from product issuance."],
  ["ingested_at", "time", "UTC time the GIS service ingested the feature."],
  ["geometry_json", "text", "Unclipped WGS84 GeoJSON geometry when include_geometry is true; otherwise NULL."],
  ["attributes_json", "text", "Original feature attributes, preserving upstream category codes and date strings."],
];
export const GIS_OPTIONS = {
  page_size: {
    default: 100,
    doc: "Features requested per upstream page, from 1 to 500; the service limit may be lower.",
  },
  include_geometry: {
    default: false,
    doc: "Return full WGS84 GeoJSON polygons. Large geometries may exceed the HTTP response size bound.",
  },
};
export const BBOX_OPTION = {
  default: "",
  doc: "Optional WGS84 bounding box west,south,east,north; west greater than east crosses the antimeridian. Empty scans the selected layer.",
};

/** ArcGIS uses epoch milliseconds and several documented product-specific UTC string formats. */
export function gisTime(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") throw new Error("Malformed GIS timestamp");
  let iso = value.trim();
  if (/^\d{12}$/.test(iso))
    iso = `${iso.slice(0, 4)}-${iso.slice(4, 6)}-${iso.slice(6, 8)}T${iso.slice(8, 10)}:${iso.slice(10, 12)}:00Z`;
  else if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(iso)) iso = `${iso.replace(" ", "T")}Z`;
  else if (/^\d{4}-\d\d-\d\d \d{4}Z$/.test(iso))
    iso = `${iso.slice(0, 10)}T${iso.slice(11, 13)}:${iso.slice(13, 15)}:00Z`;
  else if (/^\d\d\/\d\d\/\d{4}$/.test(iso)) iso = `${iso.slice(6)}-${iso.slice(0, 2)}-${iso.slice(3, 5)}T00:00:00Z`;
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(iso)) throw new Error(`Unsupported GIS timestamp: ${value}`);
  const year = Number(iso.slice(0, 4)),
    month = Number(iso.slice(5, 7)),
    day = Number(iso.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0) || Number(iso.slice(11, 13)) > 23)
    throw new Error(`Invalid GIS timestamp: ${value}`);
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid GIS timestamp: ${value}`);
  return timestamp;
}
export function checkedBody(body: unknown): ObjectData {
  const data = obj(body);
  const failure = gisFailure(data);
  if (failure) throw new Error(failure.message);
  return data;
}
async function initialCursor(layer: Layer, pageSize: number): Promise<Cursor> {
  const data = checkedBody((await getJson(layer.root ?? "gis", `${layer.service}?f=json`)).body);
  const found = arr(data.layers)
    .map(obj)
    .filter((l) => (layer.id === undefined ? l.name === layer.name : l.id === layer.id) && l.type === "Feature Layer");
  if (found.length !== 1) throw new Error(`NWS GIS layer unavailable or ambiguous: ${layer.name}`);
  const layerId = num(found[0]?.id),
    max = num(data.maxRecordCount);
  if (
    layerId === null ||
    !Number.isSafeInteger(layerId) ||
    layerId < 0 ||
    max === null ||
    !Number.isSafeInteger(max) ||
    max < 1
  )
    throw new Error("Malformed NWS GIS layer metadata");
  return { layerId, limit: Math.min(max, pageSize), region: 0, lastId: -1, edition: null, seenIds: [] };
}
export async function gisPage(
  layer: Layer,
  args: Args,
  cursor: string | undefined,
  map: (p: ObjectData) => Row,
  atPoint: boolean,
): Promise<Page> {
  const size = Number(args.page_size);
  const idField = layer.idField ?? "objectid";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(idField)) throw new Error("Invalid GIS object ID field");
  if (!Number.isInteger(size) || size < 1 || size > 500)
    throw new Error("page_size must be a whole number from 1 to 500");
  const regions: Record<string, string>[] = [];
  if (atPoint) {
    coords(args);
    regions.push({
      geometry: JSON.stringify({ x: args.longitude, y: args.latitude, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint",
    });
  } else if (args.bbox) {
    for (const [xmin, ymin, xmax, ymax] of parseBounds(args.bbox))
      regions.push({
        geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryEnvelope",
      });
  } else regions.push({});
  const state: Cursor = cursor ? JSON.parse(cursor) : await initialCursor(layer, size);
  if (
    !Number.isSafeInteger(state.lastId) ||
    !Number.isSafeInteger(state.layerId) ||
    state.layerId < 0 ||
    !regions[state.region]
  )
    throw new Error("Invalid GIS continuation cursor");
  const path = query(`${layer.service}/${state.layerId}/query`, {
    f: "geojson",
    where: state.lastId < 0 ? "1=1" : `${idField} > ${state.lastId}`,
    outFields: "*",
    orderByFields: `${idField} ASC`,
    returnGeometry: args.include_geometry,
    outSR: 4326,
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: state.limit,
    ...regions[state.region],
  });
  const doc = await getJson(layer.root ?? "gis", path),
    data = checkedBody(doc.body);
  if (data.type !== "FeatureCollection") throw new Error("Malformed GIS FeatureCollection");
  const features = arr(data.features),
    rows: Row[] = [];
  const seen = new Set(state.seenIds);
  for (const feature of features) {
    const f = obj(feature),
      p = obj(f.properties),
      objectId = num(p[idField]);
    if (objectId === null || !Number.isSafeInteger(objectId) || objectId <= state.lastId)
      throw new Error("NWS GIS pagination did not advance in object ID order");
    state.lastId = objectId;
    const edition = json(p.idp_filedate);
    if (layer.snapshot !== false && state.edition !== null && edition !== null && edition !== state.edition)
      throw new Error("NWS GIS publication changed during pagination; rerun the query");
    state.edition ??= edition;
    // A polygon can intersect both halves of a dateline-crossing box. Emit it once.
    if (seen.has(objectId)) continue;
    if (regions.length > 1) {
      state.seenIds.push(objectId);
      seen.add(objectId);
      if (seen.size > 20000) throw new Error("GIS dateline deduplication limit reached; narrow the bbox");
    }
    rows.push({
      ...map(p),
      object_id: objectId,
      layer_name: layer.name,
      source_file_at: gisTime(p.idp_filedate),
      ingested_at: gisTime(p.idp_ingestdate),
      geometry_json: args.include_geometry ? json(f.geometry) : null,
      attributes_json: json(p),
      ...provenance(doc),
    });
  }
  const exceeded =
    data.exceededTransferLimit === true ||
    (data.properties != null && obj(data.properties).exceededTransferLimit === true);
  if (!features.length && exceeded) throw new Error("NWS GIS returned an empty truncated page");
  let more = exceeded || features.length === state.limit;
  if (!more && state.region + 1 < regions.length) {
    state.region++;
    state.lastId = -1;
    more = true;
  }
  return { rows, next: more ? JSON.stringify(state) : undefined };
}
