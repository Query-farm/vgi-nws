import { getJson } from "./http.ts";
import {
  type Args,
  arr,
  type Col,
  id,
  json,
  num,
  type ObjectData,
  obj,
  type Page,
  provenance,
  query,
  type Row,
  reader,
  readerWithOptions,
  str,
  time,
} from "./reader.ts";
import { type Bounds, distanceKm, owns, parseBounds, radiusBounds, tiles } from "./spatial.ts";

import { STATE_BOUNDS } from "./state_bounds.ts";

const nested = (p: ObjectData, key: string) => (p[key] == null ? {} : obj(p[key]));
function stateCode(value: unknown): string {
  if (value === "") return "";
  if (typeof value !== "string" || !Object.hasOwn(STATE_BOUNDS, value))
    throw new Error("state must be a supported uppercase US state or territory code");
  return value;
}
function scopes(a: Args): Bounds[] {
  const state = stateCode(a.state);
  if (a.bbox) return parseBounds(a.bbox);
  if (!state) throw new Error("gauges requires state or bbox; use gauges_near for a radius search");
  // NWPS has no documented state parameter. Bound requests regionally, then filter exact state.
  return STATE_BOUNDS[state] || [];
}
const columns: Col[] = [
  ["gauge_id", "text", "NWS location identifier, accepted by gauge and stageflow."],
  ["name", "text", "Gauge and river name."],
  ["latitude", "number", "WGS84 gauge latitude in decimal degrees."],
  ["longitude", "number", "WGS84 gauge longitude in decimal degrees."],
  ["state", "text", "Upstream state or territory abbreviation."],
  ["office_id", "text", "Responsible weather forecast office."],
  ["rfc", "text", "River Forecast Center abbreviation."],
  ["observed_category", "text", "Native observed flood/status category; not_current is not a no-flood classification."],
  ["forecast_category", "text", "Native forecast flood/status category."],
  ["observed_at", "time", "UTC observed-status time; the upstream year-one sentinel becomes NULL."],
  ["forecast_at", "time", "UTC forecast-status valid time; the upstream year-one sentinel becomes NULL."],
  [
    "status_json",
    "text",
    "Original observed/forecast status, retaining values, units, and upstream missing-data sentinels.",
  ],
  [
    "distance_km",
    "number",
    "Great-circle distance for gauges_near, otherwise NULL. This is not distance along a river.",
  ],
];
export function statusTime(value: unknown): number | null {
  return typeof value === "string" && value.startsWith("0001-") ? null : time(value);
}
function gaugeRow(p: ObjectData): Row {
  const status = nested(p, "status"),
    observed = nested(status, "observed"),
    forecast = nested(status, "forecast");
  return {
    gauge_id: str(p.lid),
    name: str(p.name),
    latitude: num(p.latitude),
    longitude: num(p.longitude),
    state: str(nested(p, "state").abbreviation),
    office_id: str(nested(p, "wfo").abbreviation),
    rfc: str(nested(p, "rfc").abbreviation),
    observed_category: str(observed.floodCategory),
    forecast_category: str(forecast.floodCategory),
    observed_at: statusTime(observed.validTime),
    forecast_at: statusTime(forecast.validTime),
    status_json: json(p.status),
    distance_km: null,
  };
}
async function gaugePage(a: Args, cursor: string | undefined, nearby: boolean): Promise<Page> {
  const state = stateCode(a.state),
    regions = tiles(nearby ? radiusBounds(a) : scopes(a));
  const index = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(index) || index < 0 || index >= regions.length)
    throw new Error("Invalid gauge continuation cursor");
  const tile = regions[index];
  if (!tile) throw new Error("Missing gauge tile");
  const [west, south, east, north] = tile.bounds;
  const doc = await getJson(
    "water",
    query("/gauges", {
      "bbox.xmin": west,
      "bbox.ymin": south,
      "bbox.xmax": east,
      "bbox.ymax": north,
      srid: "EPSG_4326",
    }),
  );
  const body = obj(doc.body);
  if (body.code != null && !Array.isArray(body.gauges))
    throw new Error(`NWPS API error ${String(body.code)}: ${String(body.message)}`);
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const value of arr(body.gauges)) {
    const row = gaugeRow(obj(value));
    if (
      row.latitude === null ||
      row.longitude === null ||
      !owns(tile, Number(row.latitude), Number(row.longitude)) ||
      (state && row.state !== state)
    )
      continue;
    if (typeof row.gauge_id !== "string" || !row.gauge_id) throw new Error("NWPS gauge missing its identifier");
    if (seen.has(row.gauge_id)) continue;
    seen.add(row.gauge_id);
    if (nearby) {
      row.distance_km = distanceKm(
        Number(a.latitude),
        Number(a.longitude),
        Number(row.latitude),
        Number(row.longitude),
      );
      if (row.distance_km > Number(a.radius_km)) continue;
    }
    rows.push({ ...row, ...provenance(doc) });
  }
  return { rows, next: index + 1 < regions.length ? String(index + 1) : undefined };
}
const stateOption = {
  default: "",
  doc: "Optional uppercase US state or territory abbreviation, such as VA. Filtering occurs after the bounded geographic request.",
};
const gauges = reader({
  name: "gauges",
  category: "water",
  description:
    "Discover geolocated NWPS gauges by state or WGS84 bounding box. At least one scope is required. Requests stream across bounded geographic tiles, then filter state exactly and deduplicate shared tile edges. Results include observed/forecast status and identifiers for gauge and stageflow.",
  options: {
    state: stateOption,
    bbox: {
      default: "",
      doc: "WGS84 bounds west,south,east,north; west greater than east crosses the antimeridian. Required when state is empty.",
    },
  },
  columns,
  read: (a, c) => gaugePage(a, c, false),
  example: "SELECT gauge_id, name, state, observed_category FROM nws.main.gauges(state := 'VA') ORDER BY gauge_id",
  exampleDescription: "Discover Virginia river gauges and their reported observed status",
});
const gaugesNear = readerWithOptions({
  name: "gauges_near",
  exampleInputs: ["37.5407", "-77.4360"],
  category: "water",
  description:
    "Find NWPS gauges within a great-circle radius of a location. Uses geographic bounding boxes, then an exact spherical distance filter; supports poles and the antimeridian. Order by distance_km to obtain nearest gauges; input/output order does not imply distance or hydrologic connectivity.",
  inputs: { latitude: "number", longitude: "number" },
  inputDocs: {
    latitude: "WGS84 latitude in decimal degrees, from -90 to 90.",
    longitude: "WGS84 longitude in decimal degrees, from -180 to 180; west is negative.",
  },
  options: {
    radius_km: { default: 50, doc: "Search radius in kilometres, greater than zero and at most 500." },
    state: stateOption,
  },
  constraints: { radius_km: { gt: 0, le: 500 } },
  columns,
  read: (a, c) => gaugePage(a, c, true),
  example:
    "SELECT gauge_id, name, distance_km FROM nws.main.gauges_near(37.5407, -77.4360, radius_km := 50) ORDER BY distance_km, gauge_id",
  exampleDescription: "Find nearby Richmond gauges ordered by distance in kilometres",
});
const network = readerWithOptions({
  name: "river_network",
  category: "water",
  description:
    "List upstream and downstream gauge connections reported by NWPS for a starting gauge. This is the service's river-at-a-glance network, not a complete watershed graph. Array position preserves upstream ordering; it does not assert distance or immediate adjacency.",
  inputs: { gauge_id: "text" },
  inputDocs: { gauge_id: "Starting NWPS gauge identifier, for example RMDV2." },
  options: { direction: { default: "both", doc: "Network direction filter: both, upstream, or downstream." } },
  constraints: { direction: { choices: ["both", "upstream", "downstream"] } },
  columns: [
    ["origin_gauge_id", "text", "Resolved starting gauge ID from NWPS."],
    ["gauge_id", "text", "Connected gauge ID, accepted by gauge and stageflow."],
    ["name", "text", "Connected gauge name."],
    ["direction", "text", "upstream or downstream relative to the origin."],
    ["sequence_number", "number", "One-based array position within this direction; not river distance."],
  ],
  read: async (a) => {
    if (!["both", "upstream", "downstream"].includes(String(a.direction)))
      throw new Error("Invalid river_network direction");
    const doc = await getJson("water", `/gauges/${id(a.gauge_id)}/riverflow`),
      body = obj(doc.body),
      origin = str(obj(body.startingPoint).LID);
    if (!origin) throw new Error("NWPS river network missing its starting point");
    return {
      rows: ["upstream", "downstream"]
        .filter((d) => a.direction === "both" || d === a.direction)
        .flatMap((direction) =>
          arr(body[direction]).map((v, i) => {
            const p = obj(v);
            return {
              origin_gauge_id: origin,
              gauge_id: str(p.LID),
              name: str(p.Name),
              direction,
              sequence_number: i + 1,
              ...provenance(doc),
            };
          }),
        ),
    };
  },
  example: "SELECT direction, gauge_id, name FROM nws.main.river_network('RMDV2') ORDER BY direction, sequence_number",
  exampleDescription: "Discover gauges connected to Richmond-Westham along its river network",
});
export const WATER_DISCOVERY_FUNCTIONS = [gauges, ...gaugesNear, ...network];
