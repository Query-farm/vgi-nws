/** Shared raw-pixel sampling for curated NWS mosaic services. */
import { checkedBody, gisTime } from "./gis.ts";
import { getJson, type MapService } from "./http.ts";
import { type Args, arr, type Col, coords, json, num, obj, provenance, query, type Row, str } from "./reader.ts";

export const RASTER_COLUMNS: Col[] = [
  ["latitude", "number", "Requested WGS84 latitude."],
  ["longitude", "number", "Requested WGS84 longitude."],
  ["layer_name", "text", "Exact upstream mosaic layer name, including any source whitespace."],
  ["raster_id", "number", "Source raster object ID, not stable across publications."],
  ["raster_name", "text", "Native raster dataset name."],
  ["valid_at", "time", "UTC raster valid time when the source provides it; NULL otherwise."],
  ["issued_at", "time", "UTC source issuance time, not an invented observation interval boundary."],
  ["source_file_at", "time", "UTC source file timestamp."],
  ["ingested_at", "time", "UTC GIS ingestion timestamp."],
  ["attributes_json", "text", "Original identify attributes, preserving raw pixels and display class codes."],
  ["footprint_json", "text", "Original raster footprint metadata and publication fields."],
  ["metadata_url", "text", "Canonical footprint metadata query URL."],
];

export function rasterValue(value: unknown): number | null {
  if (value == null || value === "NoData") return null;
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))
  )
    throw new Error("Malformed raw raster pixel value");
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Malformed raw raster pixel value");
  return n;
}
function layerId(value: unknown): number {
  const n = num(value);
  if (n === null || !Number.isSafeInteger(n) || n < 0) throw new Error("Malformed raster layer ID");
  return n;
}
export async function sampleRasters(
  service: string,
  names: (string | number)[],
  a: Args,
  root: MapService = "raster",
): Promise<Row[]> {
  coords(a);
  if (names.length < 1 || names.length > 4 || new Set(names).size !== names.length)
    throw new Error("Select one to four distinct raster layers");
  const metadata = checkedBody((await getJson(root, `${service}?f=json`)).body);
  const layers = arr(metadata.layers).map(obj);
  const selections = names.map((name) => {
    // Source names sometimes have trailing spaces. Keep the original name in output.
    const groups = layers.filter(
      (l) => (typeof name === "number" ? l.id === name : str(l.name)?.trim() === name) && l.type === "Mosaic Layer",
    );
    if (groups.length !== 1) throw new Error(`Raster layer unavailable or ambiguous: ${name}`);
    const parent = layerId(groups[0]?.id),
      children = layers.filter((l) => l.parentLayerId === parent);
    const images = children.filter((l) => l.type === "Raster Layer");
    const footprints = children.filter((l) => l.type === "Feature Layer" && /^Footprint(?:_|$)/.test(String(l.name)));
    if (images.length !== 1 || footprints.length !== 1) throw new Error("Raster image or footprint layer unavailable");
    return {
      name: str(groups[0]?.name) ?? String(name),
      parent,
      image: layerId(images[0]?.id),
      footprint: layerId(footprints[0]?.id),
    };
  });
  const lat = Number(a.latitude),
    lon = Number(a.longitude);
  const doc = await getJson(
    root,
    query(`${service}/identify`, {
      f: "json",
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      sr: 4326,
      layers: `all:${selections.map((s) => s.image).join(",")}`,
      tolerance: 0,
      returnGeometry: false,
      imageDisplay: "100,100,96",
      mapExtent: [
        Math.max(-180, lon - 0.01),
        Math.max(-90, lat - 0.01),
        Math.min(180, lon + 0.01),
        Math.min(90, lat + 0.01),
      ].join(","),
    }),
  );
  const body = checkedBody(doc.body),
    results = arr(body.results).map(obj);
  if (body.exceededTransferLimit === true || results.length > 128)
    throw new Error("Truncated or excessive raster identify results");
  const samples = results.flatMap((r) => {
    const selection = selections.find((s) => s.image === r.layerId);
    if (!selection) throw new Error("Unexpected raster identify layer");
    const p = obj(r.attributes);
    if (!("Service Pixel Value" in p)) throw new Error("Raster response has no raw service pixel value");
    const value = rasterValue(p["Service Pixel Value"]);
    // ArcGIS returns an unlocated NoData placeholder for layers outside their footprint.
    if (p.objectid == null && p.name == null && p["Service Pixel Value"] === "NoData") return [];
    const id =
      typeof p.objectid === "number"
        ? p.objectid
        : typeof p.objectid === "string" && /^\d+$/.test(p.objectid)
          ? Number(p.objectid)
          : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 0 || !str(p.name)) throw new Error("Missing raster identifier or name");
    return [{ selection, p, id, value }];
  });
  const pages = await Promise.all(
    selections.map(async (selection): Promise<Row[]> => {
      const matches = samples.filter((s) => s.selection === selection);
      if (!matches.length) return [];
      if (matches.length > 32 || new Set(matches.map((s) => s.id)).size !== matches.length)
        throw new Error("Excessive or duplicate overlapping raster results");
      const footprintDoc = await getJson(
        root,
        query(`${service}/${selection.footprint}/query`, {
          f: "json",
          objectIds: matches.map((s) => s.id).join(","),
          outFields: "*",
          returnGeometry: false,
        }),
      );
      const body = checkedBody(footprintDoc.body);
      if (body.exceededTransferLimit === true) throw new Error("Truncated raster footprint metadata");
      const features = arr(body.features).map((f) => obj(obj(f).attributes));
      return matches.map((sample) => {
        const found = features.filter((f) => f.objectid === sample.id);
        if (found.length !== 1 || found[0]?.name !== sample.p.name)
          throw new Error("Raster metadata changed or is missing; rerun the query");
        const f = found[0];
        return {
          latitude: lat,
          longitude: lon,
          raw_value: sample.value,
          layer_name: selection.name,
          layer_id: selection.parent,
          raster_id: sample.id,
          raster_name: str(sample.p.name),
          valid_at: gisTime(f?.idp_validtime),
          issued_at: gisTime(f?.idp_issueddate),
          source_file_at: gisTime(f?.idp_filedate),
          ingested_at: gisTime(f?.idp_ingestdate),
          attributes_json: json(sample.p),
          footprint_json: json(f),
          metadata_url: footprintDoc.source_url,
          ...provenance(doc),
        };
      });
    }),
  );
  return pages.flat();
}
