/** Bounded ImageServer catalog paging followed by sampling of explicitly locked rasters. */
import { checkedBody, gisTime } from "./gis.ts";
import { getJson } from "./http.ts";
import { mapProduct } from "./map_catalog.ts";
import { rasterValue } from "./raster.ts";
import {
  type Args,
  arr,
  type Col,
  coords,
  dateRange,
  json,
  num,
  type ObjectData,
  obj,
  type Page,
  provenance,
  query,
  type Row,
  readerWithOptions,
  str,
} from "./reader.ts";

export const IMAGE_COLUMNS: Col[] = [
  ["product_id", "text", "Selected ImageServer product ID."],
  ["latitude", "number", "Requested WGS84 latitude."],
  ["longitude", "number", "Requested WGS84 longitude."],
  ["raster_id", "number", "Source raster object ID; not stable across publications."],
  ["raster_name", "text", "Native raster name, if supplied."],
  ["subset", "text", "Native regional/product subset."],
  ["band_index", "number", "One-based band index; preserve this for multiband display imagery."],
  [
    "raw_value",
    "number",
    "Native nearest-neighbor band value; NULL for NoData. May be a display color rather than a physical measurement.",
  ],
  ["pixel_text", "text", "Original complete pixel string, including all bands."],
  ["valid_from", "time", "UTC native raster valid start; no period is invented."],
  ["valid_to", "time", "UTC native raster valid end; may equal the start for instantaneous products."],
  ["issued_at", "time", "UTC native reference/issue time, if supplied."],
  ["forecast_hour", "number", "Native forecast lead hour, if supplied."],
  ["source_file_at", "time", "UTC native source file timestamp."],
  ["ingested_at", "time", "UTC native ingestion timestamp."],
  ["attributes_json", "text", "Original raster catalog attributes."],
  ["sample_json", "text", "Original pixel sample and metadata."],
  ["metadata_url", "text", "Canonical raster catalog query URL."],
];
export const IMAGE_OPTIONS = {
  start_time: {
    default: "",
    doc: "Optional RFC3339 UTC/timezone start. Return native validity intervals intersecting the requested half-open window.",
  },
  end_time: { default: "", doc: "Optional RFC3339 UTC/timezone exclusive end; must follow start_time." },
  subset: {
    default: "",
    doc: "Optional exact idp_subset label from the source catalog. Empty includes all geographic/product subsets covering the point.",
  },
  page_size: {
    default: 20,
    doc: "Raster catalog records per page, 1–20; reduced to the service's mosaic limit. All pages are read unless max_pages is reached.",
  },
};
export function pixelBands(value: unknown, bandCount: number): (number | null)[] {
  if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > 32) throw new Error("Unsupported image band count");
  if (value === null || value === "NoData") return Array(bandCount).fill(null);
  if (typeof value === "number" && bandCount === 1) return [rasterValue(value)];
  if (typeof value !== "string" || !value.trim()) throw new Error("Malformed image pixel");
  const parts = value.trim().split(/[\s,]+/);
  if (parts.length !== bandCount) throw new Error("Image pixel band count does not match metadata");
  return parts.map(rasterValue);
}
export function intersectsTime(
  from: number | null,
  to: number | null,
  start: number | null,
  end: number | null,
): boolean {
  const first = from ?? to,
    last = to ?? from;
  if (first === null || last === null) return start === null && end === null;
  if (last < first) throw new Error("Image validity end precedes start");
  if (start === null && end === null) return true;
  return (end === null || first < end) && (start === null || (last === first ? first >= start : last > start));
}
export async function imagePage(a: Args, cursor?: string): Promise<Page> {
  coords(a);
  dateRange(a);
  const p = mapProduct(a.product_id);
  if (p.kind !== "ImageServer") throw new Error("map_image_at requires an ImageServer product from map_products");
  if (typeof a.subset !== "string" || a.subset.length > 200 || [...a.subset].some((c) => c.charCodeAt(0) < 32))
    throw new Error("subset must be a short text label");
  const requested = Number(a.page_size);
  if (!Number.isInteger(requested) || requested < 1 || requested > 20)
    throw new Error("page_size must be an integer from 1 to 20");
  const metadata = checkedBody((await getJson(p.root, `${p.service}?f=json`)).body);
  const fields = arr(metadata.fields).map(obj),
    names = new Set(fields.map((f) => String(f.name)));
  const oid = str(metadata.objectIdField) || str(fields.find((f) => f.type === "esriFieldTypeOID")?.name);
  if (!oid || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(oid)) throw new Error("Image service has no valid raster ID field");
  const maxMosaic = num(metadata.maxMosaicImageCount) ?? 1,
    maxRecords = num(metadata.maxRecordCount) ?? 1;
  if (!Number.isInteger(maxMosaic) || !Number.isInteger(maxRecords) || maxMosaic < 1 || maxRecords < 1)
    throw new Error("Invalid image service limits");
  const limit = Math.min(requested, maxMosaic, maxRecords),
    bandCount = Number(metadata.bandCount);
  const state = cursor ? obj(JSON.parse(cursor)) : { after: -1 };
  const after = num(state.after);
  if (after === null || !Number.isSafeInteger(after) || after < -1)
    throw new Error("Invalid image continuation cursor");
  const start = a.start_time ? gisTime(a.start_time) : null,
    end = a.end_time ? gisTime(a.end_time) : null;
  const timeInfo = metadata.timeInfo == null ? {} : obj(metadata.timeInfo);
  const fromField = str(timeInfo.startTimeField) || (names.has("idp_validtime") ? "idp_validtime" : "");
  const toField = str(timeInfo.endTimeField) || (names.has("idp_validendtime") ? "idp_validendtime" : "");
  if ((start !== null || end !== null) && !fromField && !toField)
    throw new Error("This image product has no native valid-time field");
  if (a.subset && !names.has("idp_subset")) throw new Error("This image product has no subset field");
  const conditions = [names.has("category") ? "category = 1" : "1=1"];
  if (after >= 0) conditions.push(`${oid} > ${after}`);
  if (a.subset) conditions.push(`idp_subset = '${a.subset.replaceAll("'", "''")}'`);
  const geometry = JSON.stringify({ x: a.longitude, y: a.latitude, spatialReference: { wkid: 4326 } });
  const catalog = await getJson(
    p.root,
    query(`${p.service}/query`, {
      f: "json",
      where: conditions.join(" AND "),
      geometry,
      geometryType: "esriGeometryPoint",
      inSR: 4326,
      spatialRel: "esriSpatialRelIntersects",
      outFields: "*",
      returnGeometry: false,
      orderByFields: `${oid} ASC`,
      resultRecordCount: limit,
      time: metadata.timeInfo && (start !== null || end !== null) ? `${start ?? "null"},${end ?? "null"}` : undefined,
    }),
  );
  const body = checkedBody(catalog.body),
    items = arr(body.features).map((f) => obj(obj(f).attributes));
  if (items.length > limit || (!items.length && body.exceededTransferLimit === true))
    throw new Error("Invalid or truncated image catalog page");
  let last = after;
  const ids = items.map((item) => {
    const id = num(item[oid]);
    if (id === null || !Number.isSafeInteger(id) || id <= last)
      throw new Error("Image catalog pagination did not advance");
    last = id;
    return id;
  });
  const next =
    body.exceededTransferLimit === true || items.length === limit ? JSON.stringify({ after: last }) : undefined;
  if (!ids.length) return { rows: [], next };
  // Lock an explicit, bounded set: getSamples otherwise silently uses maxMosaicImageCount.
  const samplesDoc = await getJson(
    p.root,
    query(`${p.service}/getSamples`, {
      f: "json",
      geometry,
      geometryType: "esriGeometryPoint",
      returnFirstValueOnly: false,
      outFields: "*",
      interpolation: "RSP_NearestNeighbor",
      mosaicRule: JSON.stringify({ mosaicMethod: "esriMosaicLockRaster", lockRasterIds: ids }),
    }),
  );
  const samplesBody = checkedBody(samplesDoc.body),
    samples = arr(samplesBody.samples).map(obj);
  if (samplesBody.exceededTransferLimit === true || samples.length !== ids.length)
    throw new Error("Missing or truncated image samples; source catalog may have changed, rerun the query");
  const byId = new Map<number, ObjectData>();
  for (const sample of samples) {
    const id = num(sample.rasterId);
    if (id === null || !ids.includes(id) || byId.has(id)) throw new Error("Unexpected or duplicate image sample ID");
    byId.set(id, sample);
  }
  const rows: Row[] = [];
  for (const item of items) {
    const id = Number(item[oid]),
      sample = byId.get(id);
    if (!sample) throw new Error("Missing image sample");
    const attributes = obj(sample.attributes);
    for (const field of ["name", "idp_filedate", "idp_issueddate", "idp_validtime", "idp_validendtime"])
      if (item[field] != null && attributes[field] !== item[field])
        throw new Error("Image catalog changed during sampling; rerun the query");
    const from = fromField ? gisTime(item[fromField]) : null,
      to = toField ? gisTime(item[toField]) : null;
    if (!intersectsTime(from, to, start, end)) continue;
    for (const [index, value] of pixelBands(sample.value, bandCount).entries())
      rows.push({
        product_id: String(a.product_id),
        latitude: Number(a.latitude),
        longitude: Number(a.longitude),
        raster_id: id,
        raster_name: str(item.name),
        subset: str(item.idp_subset),
        band_index: index + 1,
        raw_value: value,
        pixel_text: sample.value == null ? null : String(sample.value),
        valid_from: from,
        valid_to: to,
        issued_at: gisTime(item.idp_issueddate),
        forecast_hour: num(item.idp_fcst_hour),
        source_file_at: gisTime(item.idp_filedate),
        ingested_at: gisTime(item.idp_ingestdate),
        attributes_json: json(item),
        sample_json: json(sample),
        metadata_url: catalog.source_url,
        ...provenance(samplesDoc),
      });
  }
  return { rows, next };
}
export const IMAGE_FUNCTIONS = readerWithOptions({
  name: "map_image_at",
  inputs: { product_id: "text", latitude: "number", longitude: "number" },
  inputDocs: {
    product_id: "ImageServer identifier returned by map_products; NULL emits no rows.",
    latitude: "WGS84 latitude, -90 to 90; NULL emits no rows.",
    longitude: "WGS84 longitude, -180 to 180; NULL emits no rows.",
  },
  description:
    "Sample every matching native raster in a NWS ImageServer at a point, preserving temporal slices and separate bands. Enumerates the image catalog and samples explicitly locked raster IDs in bounded pages, avoiding the service's silent mosaic limit. Optional dates filter native validity intervals. Native pixel values are not guaranteed physical measurements: some radar services contain color bands. No units, probabilities, or missing timestamps are invented. This is the currently published catalog, not a historical archive. Changes between catalog enumeration and sampling fail explicitly.",
  options: IMAGE_OPTIONS,
  constraints: { page_size: { ge: 1, le: 20 } },
  columns: IMAGE_COLUMNS,
  read: imagePage,
  example:
    "SELECT valid_from, raw_value, band_index FROM nws.main.map_image_at('raster:air_quality/ndgd_apm25_hr01/ImageServer',38.0293,-78.4767) ORDER BY valid_from, raster_id, band_index",
  exampleDescription: "Read the available hourly PM2.5 raster series at Charlottesville",
  exampleInputs: ["'raster:air_quality/ndgd_apm25_hr01/ImageServer'", "38.0293", "-78.4767"],
});
