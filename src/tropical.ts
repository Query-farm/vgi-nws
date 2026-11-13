import { BBOX_OPTION, GIS_COLUMNS, GIS_OPTIONS } from "./gis.ts";
import { mapFeatures, mapLayers } from "./map_catalog.ts";
import { choose } from "./outlooks.ts";
import { type Args, type Col, obj, type Page, readerWithOptions, str } from "./reader.ts";

const SUMMARY = "tropical:tropical/NHC_tropical_weather_summary/MapServer";
export const TROPICAL_PRODUCTS: Record<string, [string, string]> = Object.fromEntries(
  Object.entries({
    outlook_2day: "Two-Day: Current Location",
    outlook_7day: "Seven-Day: Current Location",
    development_motion: "Seven-Day: Development Motion",
    development_region: "Seven-Day: Potential Development Region",
    forecast_points: "Forecast Points",
    forecast_track: "Forecast Track",
    forecast_cone: "Forecast Cone",
    watches_warnings: "Watch-Warning",
    past_points: "Past Points",
    past_track: "Past Track",
    past_wind_swath: "Past Cumulative Wind Swath",
    past_wind_radii: "Past Wind Radii",
    forecast_wind_radii: "Forecast Wind Radii",
    advisory_wind_field: "Advisory Wind Field",
    wind_arrival_earliest: "Earliest Reasonable Arrival Time",
    wind_arrival_likely: "Most Likely Arrival Time",
    wind_probability_34kt: "Probabilistic Winds 34 kts",
    wind_probability_50kt: "Probabilistic Winds 50 kts",
    wind_probability_64kt: "Probabilistic Winds 64 kts",
  }).map(([selector, layer]) => [selector, [SUMMARY, layer]]),
);
for (const [selector, layer] of [
  ["peak_surge_points", "Points"],
  ["peak_surge_lines", "Lines"],
  ["peak_surge_areas", "Polygons"],
])
  TROPICAL_PRODUCTS[selector as string] = ["tropical:tropical/NHC_PeakStormSurge/MapServer", layer as string];
TROPICAL_PRODUCTS.breakpoints = ["tropical:tropical/NHC_Breakpoints/MapServer", "Watch_Warning_Breakpoints"];
TROPICAL_PRODUCTS.surge_communication_points = [
  "tropical:tropical/NHC_Breakpoints/MapServer",
  "StormSurge_Communication_Points",
];

export async function tropicalFeatures(a: Args, cursor: string | undefined, atPoint: boolean): Promise<Page> {
  const product = choose(a.product, Object.keys(TROPICAL_PRODUCTS), "product"),
    selection = TROPICAL_PRODUCTS[product];
  if (!selection) throw new Error("Unknown tropical product");
  const [product_id, name] = selection,
    layers = (await mapLayers({ product_id })).rows.filter(
      (l) => l.layer_type === "Feature Layer" && l.layer_name === name,
    );
  if (layers.length !== 1) throw new Error(`NHC layer unavailable or ambiguous: ${name}`);
  const page = await mapFeatures({ ...a, product_id, layer_id: layers[0]?.layer_id ?? null }, cursor, atPoint);
  return {
    next: page.next,
    rows: page.rows.map((r) => {
      const p = obj(JSON.parse(String(r.attributes_json))),
        source = str(p.idp_source),
        advisory = p.advisnum;
      return {
        ...r,
        product,
        storm_name: str(p.stormname),
        source_wallet: source?.match(/^(AT[1-5]|EP[1-5]|CP[1-5])/i)?.[1]?.toUpperCase() ?? null,
        advisory_number: typeof advisory === "number" ? String(advisory) : str(advisory),
        advisory_time_text: str(p.advdate),
        valid_time_text: str(p.validtime),
      };
    }),
  };
}
export const TROPICAL_FUNCTIONS = [false, true].flatMap((at) =>
  readerWithOptions({
    name: `tropical_features${at ? "_at" : ""}`,
    inputs: at ? { latitude: "number", longitude: "number" } : undefined,
    description:
      "Read NHC/CPHC tropical development areas, forecast tracks/points/cones, watches and warnings, past tracks, wind radii/swaths, wind arrival contours, wind probability contours, peak storm surge features and coastal breakpoints. Resolve current layer IDs by exact source names. Native attributes retain product-specific units, probability ranges, wind thresholds, advisory identifiers and time wording; shared storm/advisory fields are exposed where present. A wallet is a reusable source slot, not a permanent cyclone ID. The cone describes track uncertainty, not the entire impact area; wind/probability contours overlap and must not be summed. Empty active-storm layers are legitimate. For surge inundation/tidal-mask pixels and static surge-risk scenarios, discover Mosaic Layers using map_layers and read with map_raster_at; static scenario maps are not live storm forecasts.",
    options: {
      product: {
        default: at ? "forecast_cone" : "forecast_points",
        doc: `NHC product selector: ${Object.keys(TROPICAL_PRODUCTS).join(", ")}.`,
      },
      ...GIS_OPTIONS,
      include_geometry: { default: false, doc: "Include source geometry transformed to WGS84 GeoJSON." },
      ...(at ? {} : { bbox: BBOX_OPTION }),
    },
    constraints: { product: { choices: Object.keys(TROPICAL_PRODUCTS) }, page_size: { ge: 1, le: 500 } },
    columns: [
      ["product", "text", "Selected NHC product family."],
      ["product_id", "text", "Source map service, usable with map_layers/map_fields."],
      ["layer_id", "number", "Current source layer ID."],
      ["storm_name", "text", "Native storm name, if present."],
      ["source_wallet", "text", "Reusable NHC/CPHC source slot derived from idp_source, if supplied."],
      ["advisory_number", "text", "Native advisory identifier; may contain intermediate-advisory suffixes."],
      ["advisory_time_text", "text", "Unchanged advisory time wording, if supplied."],
      ["valid_time_text", "text", "Unchanged native validity text; no timezone or forecast lead is inferred."],
      ...GIS_COLUMNS,
    ] as Col[],
    read: (a, c) => tropicalFeatures(a, c, at),
    example: at
      ? "SELECT product, storm_name, attributes_json FROM nws.main.tropical_features_at(25.76,-80.19) ORDER BY object_id"
      : "SELECT storm_name, advisory_number, valid_time_text, attributes_json FROM nws.main.tropical_features() ORDER BY object_id",
    exampleDescription: at
      ? "Find tropical forecast-cone features intersecting Miami"
      : "Read current tropical forecast points and their original wind and position fields",
  }),
);
