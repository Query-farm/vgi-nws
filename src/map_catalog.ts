/** Discover and query public NWS GIS products without accepting arbitrary hosts or SQL. */
import { BBOX_OPTION, checkedBody, GIS_COLUMNS, GIS_OPTIONS, gisPage, type Layer } from "./gis.ts";
import { getJson, type MapService } from "./http.ts";
import { choose } from "./outlooks.ts";
import { RASTER_COLUMNS, sampleRasters } from "./raster.ts";
import { type Args, arr, type Col, json, num, obj, type Page, provenance, readerWithOptions, str } from "./reader.ts";

export const MAP_ROOTS: Record<string, MapService> = {
  vector: "gis",
  raster: "raster",
  tropical: "tropical",
  eventdriven: "event",
};
const identifier = /^[A-Za-z0-9_-]+$/;
export function mapProduct(value: unknown): { root: MapService; server: string; service: string; kind: string } {
  if (typeof value !== "string") throw new Error("product_id must be a value returned by map_products");
  const match = value.match(
    /^(vector|raster|tropical|eventdriven):([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/(MapServer|FeatureServer|ImageServer))$/,
  );
  if (!match || match[2]?.startsWith("Utilities/")) throw new Error("Invalid NWS map product ID; use map_products");
  return {
    root: MAP_ROOTS[match[1] ?? ""] as MapService,
    server: match[1] ?? "",
    service: match[2] ?? "",
    kind: match[3] ?? "",
  };
}
export function numericLayer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("layer_id must be a nonnegative integer from map_layers");
  return value;
}
export async function mapProducts(a: Args, cursor?: string): Promise<Page> {
  const server = choose(a.server, ["all", ...Object.keys(MAP_ROOTS)], "server");
  if (typeof a.folder !== "string" || (a.folder && !identifier.test(a.folder)))
    throw new Error("folder must be a simple folder name");
  const servers = server === "all" ? Object.keys(MAP_ROOTS) : [server];
  let queue: { server: string; folder: string }[] = cursor
    ? JSON.parse(cursor)
    : servers.map((server) => ({ server, folder: a.folder as string }));
  const next = queue.shift();
  if (!next || !MAP_ROOTS[next.server] || (next.folder && !identifier.test(next.folder)))
    throw new Error("Invalid map discovery cursor");
  const doc = await getJson(MAP_ROOTS[next.server] as MapService, `${next.folder}?f=json`);
  const body = checkedBody(doc.body);
  if (!next.folder) {
    const folders = arr(body.folders)
      .map((f) => {
        if (typeof f !== "string" || !identifier.test(f)) throw new Error("Invalid NWS service folder");
        return f;
      })
      .filter((f) => f !== "Utilities");
    queue = [...folders.map((folder) => ({ server: next.server, folder })), ...queue];
  }
  const services = arr(body.services).map(obj);
  const rows = services
    .filter((s) => ["MapServer", "ImageServer", "FeatureServer"].includes(String(s.type)))
    .filter(
      (s) =>
        a.include_alternates ||
        s.type !== "FeatureServer" ||
        !services.some((v) => v.name === s.name && v.type === "MapServer"),
    )
    .map((s) => {
      const productId = `${next.server}:${String(s.name)}/${String(s.type)}`;
      mapProduct(productId);
      return {
        product_id: productId,
        server: next.server,
        folder: next.folder,
        service_name: str(s.name),
        service_type: str(s.type),
        ...provenance(doc),
      };
    });
  return { rows, next: queue.length ? JSON.stringify(queue) : undefined };
}
export async function mapLayers(a: Args): Promise<Page> {
  const p = mapProduct(a.product_id),
    doc = await getJson(p.root, `${p.service}?f=json`),
    body = checkedBody(doc.body);
  const layers =
    p.kind === "ImageServer"
      ? [{ id: null, name: body.name, type: "ImageServer", fields: body.fields }]
      : arr(body.layers).map(obj);
  return {
    rows: layers.map((l) => ({
      product_id: String(a.product_id),
      layer_id: num(l.id),
      layer_name: str(l.name),
      layer_type: str(l.type),
      parent_layer_id: num(l.parentLayerId),
      geometry_type: str(l.geometryType),
      reader:
        l.type === "Feature Layer"
          ? "map_features"
          : l.type === "Mosaic Layer"
            ? "map_raster_at"
            : l.type === "ImageServer"
              ? "map_image_at"
              : null,
      description: str(body.serviceDescription) || str(body.description),
      time_info_json: json(body.timeInfo),
      layer_json: json(l),
      ...provenance(doc),
    })),
  };
}
export async function mapFields(a: Args): Promise<Page> {
  const p = mapProduct(a.product_id);
  const suffix = p.kind === "ImageServer" ? "" : `/${numericLayer(a.layer_id)}`;
  const doc = await getJson(p.root, `${p.service}${suffix}?f=json`),
    body = checkedBody(doc.body);
  return {
    rows: arr(body.fields).map((f) => {
      const field = obj(f);
      return {
        product_id: String(a.product_id),
        layer_id: p.kind === "ImageServer" ? null : Number(a.layer_id),
        field_name: str(field.name),
        alias: str(field.alias),
        field_type: str(field.type),
        nullable: typeof field.nullable === "boolean" ? field.nullable : null,
        domain_json: json(field.domain),
        ...provenance(doc),
      };
    }),
  };
}
export async function mapFeatures(a: Args, cursor: string | undefined, atPoint: boolean): Promise<Page> {
  const p = mapProduct(a.product_id),
    layerId = numericLayer(a.layer_id);
  if (p.kind === "ImageServer") throw new Error("Use map_image_at for ImageServer pixels");
  const metadata = checkedBody((await getJson(p.root, `${p.service}/${layerId}?f=json`)).body);
  if (metadata.type !== "Feature Layer") throw new Error("Choose a Feature Layer from map_layers");
  const oid = arr(metadata.fields)
    .map(obj)
    .filter((f) => f.type === "esriFieldTypeOID");
  if (oid.length !== 1 || typeof oid[0]?.name !== "string") throw new Error("GIS layer has no unique object ID field");
  const layer: Layer = {
    root: p.root,
    service: p.service,
    id: layerId,
    name: String(metadata.name),
    idField: oid[0].name,
    snapshot: false,
  };
  return gisPage(layer, a, cursor, () => ({ product_id: String(a.product_id), layer_id: layerId }), atPoint);
}
const productInput = { product_id: "text" } as const;
const productDoc = {
  product_id:
    "NWS product ID returned by map_products, for example vector:outlooks/spc_mesoscale_discussion/MapServer. NULL emits no rows.",
};
const layersInput = { ...productInput, layer_id: "number" } as const;
const layersDoc = {
  ...productDoc,
  layer_id:
    "Current numeric layer ID returned by map_layers. IDs may change after service updates; NULL emits no rows.",
};
const pointInput = { latitude: "number", longitude: "number" } as const;
const pointDoc = {
  latitude: "WGS84 latitude from -90 to 90; NULL emits no rows.",
  longitude: "WGS84 longitude from -180 to 180; NULL emits no rows.",
};
const discovery = readerWithOptions({
  name: "map_products",
  category: "reference",
  description:
    "Discover public NWS GIS products across vector, raster, tropical and eventdriven service directories. Results are live service identifiers, including aviation, sea ice, river breakup, spot forecasts, surface analyses, NDFD, climate, radar and tropical products. Use map_layers then map_fields to inspect a product before reading features or pixels. Utilities are omitted; duplicate FeatureServer views are optional. This lists service availability, not whether current hazards exist.",
  options: {
    server: { default: "all", doc: "NWS GIS server: all, vector, raster, tropical, or eventdriven." },
    folder: {
      default: "",
      doc: "Optional folder name such as outlooks or air_quality. Empty discovers all public folders.",
    },
    include_alternates: {
      default: false,
      doc: "Include FeatureServer views also exposed by a MapServer with the same name.",
    },
  },
  constraints: { server: { choices: ["all", ...Object.keys(MAP_ROOTS)] } },
  columns: [
    ["product_id", "text", "Stable input identifier for map_layers and the map data readers."],
    ["server", "text", "NWS GIS server name."],
    ["folder", "text", "Source product family folder."],
    ["service_name", "text", "Native service path."],
    ["service_type", "text", "MapServer, ImageServer or FeatureServer."],
  ],
  read: mapProducts,
  example:
    "SELECT product_id, service_type FROM nws.main.map_products(server := 'vector', folder := 'outlooks') ORDER BY product_id",
  exampleDescription: "Discover available NWS outlook services",
});
const layers = readerWithOptions({
  name: "map_layers",
  exampleInputs: ["'vector:outlooks/spc_mesoscale_discussion/MapServer'"],
  category: "reference",
  inputs: productInput,
  inputDocs: productDoc,
  description:
    "List current layers and the appropriate data reader for a discovered NWS GIS product. Groups organize layers and do not contain independently readable data. ImageServer pixels use map_image_at without a layer ID. Service description and native time metadata are retained; map units such as metres refer to coordinates and must not be mistaken for pixel units.",
  columns: [
    ["product_id", "text", "Selected NWS product."],
    ["layer_id", "number", "Current layer ID; NULL for ImageServer."],
    ["layer_name", "text", "Native layer name."],
    ["layer_type", "text", "Native ArcGIS layer kind."],
    ["parent_layer_id", "number", "Parent group ID; -1 denotes the service root."],
    ["geometry_type", "text", "Native geometry kind where published."],
    ["reader", "text", "Suggested worker reader; NULL for organizational/display-only layers."],
    ["description", "text", "Original service description, which may contain HTML."],
    ["time_info_json", "text", "Native service temporal metadata."],
    ["layer_json", "text", "Original layer descriptor."],
  ],
  read: mapLayers,
  example:
    "SELECT layer_id, layer_name, reader FROM nws.main.map_layers('vector:outlooks/spc_mesoscale_discussion/MapServer') ORDER BY layer_id",
  exampleDescription: "Find queryable mesoscale discussion layers",
});
const fields = readerWithOptions({
  name: "map_fields",
  exampleInputs: ["'vector:outlooks/spc_mesoscale_discussion/MapServer'"],
  category: "reference",
  inputs: productInput,
  inputDocs: productDoc,
  options: {
    layer_id: {
      default: 0,
      doc: "Numeric Feature Layer ID from map_layers; ignored for ImageServer, whose catalog fields are returned.",
    },
  },
  constraints: { layer_id: { ge: 0 } },
  description:
    "Inspect the native field schema and coded-value domains of a NWS map layer or image catalog. Use aliases and domains to interpret attributes_json. This describes fields, not observations; units are never inferred from a coordinate system.",
  columns: [
    ["product_id", "text", "Selected NWS product."],
    ["layer_id", "number", "Selected layer ID; NULL for ImageServer."],
    ["field_name", "text", "Native attribute name."],
    ["alias", "text", "Source field label."],
    ["field_type", "text", "ArcGIS field type."],
    ["nullable", "bool", "Whether the source explicitly allows NULL; NULL if unspecified."],
    ["domain_json", "text", "Native coded values or ranges, if provided."],
  ],
  read: mapFields,
  example:
    "SELECT field_name, alias, field_type FROM nws.main.map_fields('vector:outlooks/spc_mesoscale_discussion/MapServer') ORDER BY field_name",
  exampleDescription: "Inspect discussion attributes and their meaning",
});
const featureFunctions = [false, true].flatMap((atPoint) =>
  readerWithOptions({
    name: `map_features${atPoint ? "_at" : ""}`,
    exampleInputs: [
      "'vector:outlooks/spc_mesoscale_discussion/MapServer'",
      "0",
      ...(atPoint ? ["38.0293", "-78.4767"] : []),
    ],
    inputs: { ...layersInput, ...(atPoint ? pointInput : {}) },
    inputDocs: { ...layersDoc, ...(atPoint ? pointDoc : {}) },
    description:
      "Read a discovered NWS Feature Layer as rows with native attributes and optional WGS84 GeoJSON. Supports all public NWS GIS product families, including sea ice, river breakup, fire spot forecasts, tropical and coastal layers. Resolve current layer IDs and field meanings with map_layers/map_fields. Pagination orders by the layer's declared object ID and supports dateline bounds. A live layer is not a transactional snapshot or a historical archive; independently issued features retain their own timestamps. Missing intersection does not establish absence of risk.",
    options: {
      ...GIS_OPTIONS,
      include_geometry: { default: false, doc: "Include native features transformed to WGS84 GeoJSON." },
      ...(atPoint ? {} : { bbox: BBOX_OPTION }),
    },
    constraints: { layer_id: { ge: 0 }, page_size: { ge: 1, le: 500 } },
    columns: [
      ["product_id", "text", "Selected NWS product."],
      ["layer_id", "number", "Current source layer ID."],
      ...GIS_COLUMNS,
    ] as Col[],
    read: (a, c) => mapFeatures(a, c, atPoint),
    example: `SELECT object_id, attributes_json FROM nws.main.map_features${atPoint ? "_at" : ""}('vector:outlooks/spc_mesoscale_discussion/MapServer',0${atPoint ? ",38.0293,-78.4767" : ""}) ORDER BY object_id`,
    exampleDescription: "Read native NWS discussion features and their attributes",
  }),
);
const raster = readerWithOptions({
  name: "map_raster_at",
  exampleInputs: [
    "'raster:precip/rfc_gridded_ffg/MapServer'",
    "(SELECT min(layer_id) FROM nws.main.map_layers('raster:precip/rfc_gridded_ffg/MapServer') WHERE layer_type = 'Mosaic Layer')",
    "38.0293",
    "-78.4767",
  ],
  inputs: { ...layersInput, ...pointInput },
  inputDocs: { ...layersDoc, ...pointDoc },
  description:
    "Sample raw pixels from a discovered NWS Mosaic Layer in any of the four map servers. Use map_layers to select the mosaic group ID, not its rendered Image child. Native values, source attributes and footprint timestamps are preserved; unit is NULL because generic service coordinate units are not pixel units. Use a specialized reader for verified conversions. No coverage emits no rows; NoData within a known raster emits NULL. Different overlapping rasters remain separate rows.",
  columns: [
    ["product_id", "text", "Selected NWS product."],
    ["layer_id", "number", "Selected mosaic group ID."],
    ["raw_value", "number", "Native unrendered pixel value; NULL for NoData."],
    ["unit", "text", "NULL: generic raster sampling does not infer measurement units."],
    ...RASTER_COLUMNS,
  ],
  read: async (a) => {
    const p = mapProduct(a.product_id);
    if (p.kind !== "MapServer")
      throw new Error("map_raster_at requires a MapServer mosaic; use map_image_at for ImageServer");
    return {
      rows: (await sampleRasters(p.service, [numericLayer(a.layer_id)], a, p.root)).map((r) => ({
        ...r,
        product_id: String(a.product_id),
        unit: null,
      })),
    };
  },
  example:
    "SELECT r.raw_value, r.raster_name, r.valid_at FROM (SELECT min(layer_id) AS layer_id FROM nws.main.map_layers('raster:precip/rfc_gridded_ffg/MapServer') WHERE layer_type = 'Mosaic Layer') l, LATERAL nws.main.map_raster_at('raster:precip/rfc_gridded_ffg/MapServer',l.layer_id,38.0293,-78.4767) r ORDER BY r.raster_id",
  exampleDescription: "Discover a flash flood guidance mosaic and inspect its native pixels",
});
export const MAP_CATALOG_FUNCTIONS = [...discovery, ...layers, ...fields, ...featureFunctions, ...raster];
