import { BBOX_OPTION, GIS_COLUMNS, GIS_OPTIONS, gisPage, gisTime } from "./gis.ts";
import { type Args, arr, type Col, num, obj, type Page, type Row, readerWithOptions, str } from "./reader.ts";
import { distanceKm, radiusBounds } from "./spatial.ts";
import { STATE_BOUNDS } from "./state_bounds.ts";

export function reportMagnitude(value: unknown): number | null {
  if (typeof value !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const columns: Col[] = [
  ["lookback_hours", "number", "Selected published rolling report window: 24, 48, or 72 hours."],
  ["reported_at", "time", "UTC time associated with the report by the LSR service; distinct from ingestion."],
  ["event", "text", "Native event description, such as Hail, Rain, or Tornado."],
  ["location", "text", "Verbatim location description."],
  ["state", "text", "Reported state or territory code."],
  ["office_id", "text", "Issuing weather forecast office ID."],
  ["office_name", "text", "Issuing office name."],
  ["magnitude", "number", "Numeric magnitude only when the entire native text is numeric; otherwise NULL."],
  ["magnitude_text", "text", "Verbatim magnitude, retaining estimates, qualifications, and missing-value text."],
  ["unit", "text", "Native magnitude units; depend on event type and are not converted."],
  ["remarks", "text", "Original forecaster remarks and reported impacts."],
  ["latitude", "number", "Report point latitude transformed by ArcGIS to WGS84."],
  ["longitude", "number", "Report point longitude transformed by ArcGIS to WGS84."],
  ["distance_km", "number", "Great-circle distance for storm_reports_near; NULL for a layer scan."],
  ...GIS_COLUMNS,
];
export async function stormReports(a: Args, cursor: string | undefined, nearby: boolean): Promise<Page> {
  const hours = Number(a.lookback_hours);
  if (![24, 48, 72].includes(hours)) throw new Error("lookback_hours must be 24, 48, or 72");
  if (a.state !== "" && (typeof a.state !== "string" || !Object.hasOwn(STATE_BOUNDS, a.state)))
    throw new Error("state must be a supported uppercase US state or territory code");
  if (typeof a.event !== "string" || a.event.length > 100)
    throw new Error("event must be text of at most 100 characters");
  let bbox = a.bbox ?? "";
  if (nearby) {
    const bounds = radiusBounds(a),
      first = bounds[0],
      last = bounds[bounds.length - 1];
    if (!first || !last) throw new Error("Invalid report radius bounds");
    bbox = [first[0], first[1], last[2], first[3]].join(",");
  }
  const result = await gisPage(
    { service: "obs/nws_local_storm_reports/MapServer", name: `Last_${hours}_Hours` },
    // Point geometry is needed for typed coordinates and exact radius filtering.
    { ...a, bbox, include_geometry: true },
    cursor,
    (p) => ({
      lookback_hours: hours,
      reported_at: gisTime(p.lsr_validtime),
      event: str(p.descript),
      location: str(p.loc_desc),
      state: str(p.state),
      office_id: str(p.wfo_id),
      office_name: str(p.wfo),
      magnitude: reportMagnitude(p.magnitude),
      magnitude_text: str(p.magnitude),
      unit: str(p.units),
      remarks: str(p.remarks),
    }),
    false,
  );
  const rows: Row[] = [];
  for (const row of result.rows) {
    if ((a.state && row.state !== a.state) || (a.event && String(row.event).toLowerCase() !== a.event.toLowerCase()))
      continue;
    const geometry = obj(JSON.parse(String(row.geometry_json))),
      coordinates = arr(geometry.coordinates);
    const lon = num(coordinates[0]),
      lat = num(coordinates[1]);
    if (geometry.type !== "Point" || lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90)
      throw new Error("Malformed storm report point geometry");
    const distance = nearby ? distanceKm(Number(a.latitude), Number(a.longitude), lat, lon) : null;
    if (distance !== null && distance > Number(a.radius_km)) continue;
    rows.push({
      ...row,
      latitude: lat,
      longitude: lon,
      distance_km: distance,
      geometry_json: a.include_geometry ? (row.geometry_json ?? null) : null,
    });
  }
  return { rows, next: result.next };
}
export const STORM_REPORT_FUNCTIONS = [false, true].flatMap((nearby) => {
  const name = nearby ? "storm_reports_near" : "storm_reports";
  return readerWithOptions({
    name,
    inputs: nearby ? { latitude: "number", longitude: "number" } : undefined,
    inputDocs: nearby
      ? {
          latitude: "WGS84 latitude, -90 to 90; NULL emits no rows.",
          longitude: "WGS84 longitude, -180 to 180; NULL emits no rows.",
        }
      : undefined,
    description:
      "Read recent NWS Local Storm Reports with locations, native magnitudes/units, and remarks. These are preliminary reports, which may include estimates, corrections, or duplicate observations of the same event; they are not a complete verified event archive. Select one rolling 24/48/72-hour layer; overlapping windows are not additive. Event/state filters apply to each fetched page. No matching reports does not establish that no event occurred. " +
      (nearby
        ? "Geographic bounds are followed by an exact great-circle radius filter, including dateline and polar locations. Order by distance_km for nearest reports."
        : "Optionally restrict by WGS84 bbox, including dateline-crossing bounds; empty bbox scans the selected layer."),
    options: {
      lookback_hours: {
        default: 24,
        doc: "Published rolling window in hours: 24, 48, or 72. This is not an arbitrary historical date range.",
      },
      state: {
        default: "",
        doc: "Optional uppercase US state or territory code. Empty includes all; applied after geographic retrieval.",
      },
      event: {
        default: "",
        doc: "Optional exact event description, matched case-insensitively, for example Hail. Empty includes all event types.",
      },
      ...GIS_OPTIONS,
      include_geometry: {
        default: false,
        doc: "Include the report's WGS84 GeoJSON point geometry; typed latitude and longitude are always returned.",
      },
      ...(nearby
        ? {
            radius_km: {
              default: 50,
              doc: "Great-circle search radius in kilometres, greater than zero and at most 500.",
            },
          }
        : { bbox: BBOX_OPTION }),
    },
    constraints: {
      lookback_hours: { choices: [24, 48, 72] },
      page_size: { ge: 1, le: 500 },
      ...(nearby ? { radius_km: { gt: 0, le: 500 } } : {}),
    },
    columns,
    read: (a, c) => stormReports(a, c, nearby),
    example: nearby
      ? "SELECT event, magnitude_text, unit, distance_km, reported_at FROM nws.main.storm_reports_near(38.0293,-78.4767) ORDER BY distance_km, object_id"
      : "SELECT event, count(*) AS reports FROM nws.main.storm_reports(lookback_hours := 72) GROUP BY event ORDER BY event",
    exampleDescription: nearby
      ? "Inspect recent storm reports near Charlottesville with their original units"
      : "Count recent local storm reports by event type",
  });
});
