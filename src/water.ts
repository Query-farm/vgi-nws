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
  provenance,
  reader,
  str,
  time,
} from "./reader.ts";

const inputs = { gauge_id: "text" } as const;
const inputDocs = {
  gauge_id: "NWPS gauge identifier (NWS LID), for example RMDV2. See https://water.noaa.gov for location discovery.",
};
async function gaugeDoc(a: Args) {
  return getJson("water", `/gauges/${id(a.gauge_id)}`);
}
const nested = (p: ObjectData, key: string) => (p[key] == null ? {} : obj(p[key]));
const gauge = reader({
  name: "gauge",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Retrieve National Water Prediction Service gauge metadata, current observed and forecast status, datum information, and data attribution. Gauge IDs are NWS LIDs, not USGS numeric IDs.",
  columns: [
    ["gauge_id", "text", "NWS location identifier."],
    ["name", "text", "Gauge and river name."],
    ["usgs_id", "text", "USGS site identifier when available."],
    ["reach_id", "text", "National Water Model reach ID when available."],
    ["latitude", "number", "Gauge latitude in decimal degrees."],
    ["longitude", "number", "Gauge longitude in decimal degrees."],
    ["state", "text", "State abbreviation."],
    ["county", "text", "County name."],
    ["office_id", "text", "Responsible forecast office."],
    ["rfc", "text", "River Forecast Center abbreviation."],
    ["time_zone", "text", "Upstream timezone label."],
    ["status_json", "text", "Observed and forecast status, retaining units and timestamps."],
    ["datums_json", "text", "Gauge datum definitions; stage is not absolute elevation."],
    ["attribution_json", "text", "Source agency attribution and links."],
  ],
  read: async (a) => {
    const d = await gaugeDoc(a);
    const p = obj(d.body);
    return {
      rows: [
        {
          gauge_id: str(p.lid),
          name: str(p.name),
          usgs_id: str(p.usgsId),
          reach_id: p.reachId == null ? null : String(p.reachId),
          latitude: num(p.latitude),
          longitude: num(p.longitude),
          state: str(nested(p, "state").abbreviation),
          county: str(p.county),
          office_id: str(nested(p, "wfo").abbreviation),
          rfc: str(nested(p, "rfc").abbreviation),
          time_zone: str(p.timeZone),
          status_json: json(p.status),
          datums_json: json(p.datums),
          attribution_json: json(p.dataAttribution),
          ...provenance(d),
        },
      ],
    };
  },
  example: "SELECT name, state, status_json FROM nws.main.gauge('RMDV2')",
  exampleDescription: "Inspect the James River gauge at Richmond-Westham",
});
const stageflow = reader({
  name: "stageflow",
  constraints: { product: { choices: ["both", "observed", "forecast"] } },
  category: "water",
  inputs,
  inputDocs,
  options: {
    product: {
      default: "both",
      doc: "both, observed, or forecast. Forecast values are predictions, not measurements.",
    },
  },
  description:
    "Stream observed and forecast river stage/flow from NWPS. Keep primary and secondary names and units with each value: flow may be cfs or kcfs, and stage is relative to the gauge datum. Only the upstream available window is returned.",
  columns: [
    ["gauge_id", "text", "Requested NWS gauge identifier."],
    ["product", "text", "observed or forecast; never combine them as measurements."],
    ["valid_at", "time", "UTC time the value applies to."],
    ["generated_at", "time", "UTC sample generation time when available."],
    ["issued_at", "time", "UTC product issuance time."],
    ["primary_value", "number", "Primary measurement or prediction; NULL remains unavailable."],
    ["primary_name", "text", "Primary quantity name, often Stage."],
    ["primary_unit", "text", "Native primary units, often ft."],
    ["secondary_value", "number", "Secondary measurement or prediction."],
    ["secondary_name", "text", "Secondary quantity name, often Flow."],
    ["secondary_unit", "text", "Native secondary units, such as kcfs; not automatically converted."],
    ["office_id", "text", "Office reported by the stageflow product."],
    ["pedts", "text", "SHEF physical element, duration, type, source, extremum code."],
  ],
  read: async (a) => {
    if (!["both", "observed", "forecast"].includes(String(a.product)))
      throw new Error("product must be both, observed, or forecast");
    const d = await getJson("water", `/gauges/${id(a.gauge_id)}/stageflow`);
    const b = obj(d.body);
    return {
      rows: ["observed", "forecast"]
        .filter((kind) => a.product === "both" || a.product === kind)
        .flatMap((kind) => {
          if (b[kind] == null) return [];
          const p = obj(b[kind]);
          return arr(p.data).map((v) => {
            const r = obj(v);
            return {
              gauge_id: str(a.gauge_id),
              product: kind,
              valid_at: time(r.validTime),
              generated_at: time(r.generatedTime),
              issued_at: time(p.issuedTime),
              primary_value: num(r.primary),
              primary_name: str(p.primaryName),
              primary_unit: str(p.primaryUnits),
              secondary_value: num(r.secondary),
              secondary_name: str(p.secondaryName),
              secondary_unit: str(p.secondaryUnits),
              office_id: str(p.wfo),
              pedts: str(p.pedts),
              ...provenance(d),
            };
          });
        }),
    };
  },
  example:
    "SELECT product, max(primary_value) AS peak, primary_unit FROM nws.main.stageflow('RMDV2') GROUP BY product, primary_unit ORDER BY product",
  exampleDescription: "Compare available observed and forecast peaks without mixing units",
});
const floodThresholds = reader({
  name: "flood_thresholds",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read NWPS action, minor, moderate, and major flood thresholds with separate stage and flow units. Threshold flow units may differ from stageflow units.",
  columns: [
    ["gauge_id", "text", "Requested gauge identifier."],
    ["category", "text", "Flood category name."],
    ["stage", "number", "Stage threshold relative to the gauge datum."],
    ["stage_unit", "text", "Stage threshold units."],
    ["flow", "number", "Flow threshold."],
    ["flow_unit", "text", "Flow threshold units; compare only after unit conversion if necessary."],
  ],
  read: async (a) => {
    const d = await gaugeDoc(a);
    const f = nested(obj(d.body), "flood");
    return {
      rows: Object.entries(nested(f, "categories")).map(([name, v]) => {
        const p = obj(v);
        return {
          gauge_id: str(a.gauge_id),
          category: name,
          stage: num(p.stage),
          stage_unit: str(f.stageUnits),
          flow: num(p.flow),
          flow_unit: str(f.flowUnits),
          ...provenance(d),
        };
      }),
    };
  },
  example: "SELECT category, stage, stage_unit FROM nws.main.flood_thresholds('RMDV2') ORDER BY stage",
  exampleDescription: "Inspect gauge-specific flood stage thresholds",
});
const floodImpacts = reader({
  name: "flood_impacts",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read published local flood impact statements at specific gauge stages. These describe consequences at the gauge's datum, not a flood inundation map.",
  columns: [
    ["gauge_id", "text", "Requested gauge identifier."],
    ["stage", "number", "Gauge stage associated with the impact."],
    ["stage_unit", "text", "Gauge stage units."],
    ["statement", "text", "Original flood impact statement."],
  ],
  read: async (a) => {
    const d = await gaugeDoc(a);
    const f = nested(obj(d.body), "flood");
    return {
      rows: arr(f.impacts ?? []).map((v) => {
        const p = obj(v);
        return {
          gauge_id: str(a.gauge_id),
          stage: num(p.stage),
          stage_unit: str(f.stageUnits),
          statement: str(p.statement),
          ...provenance(d),
        };
      }),
    };
  },
  example: "SELECT stage, stage_unit, statement FROM nws.main.flood_impacts('RMDV2') ORDER BY stage",
  exampleDescription: "Read local flood consequences by river stage",
});
const crestColumns: Col[] = [
  ["gauge_id", "text", "Requested gauge identifier."],
  ["occurred_at", "time", "UTC crest time supplied by NWPS."],
  ["stage", "number", "Crest stage in the declared stage units."],
  ["stage_unit", "text", "Crest stage units."],
  ["flow", "number", "Crest flow in the declared flow units."],
  ["flow_unit", "text", "Crest flow units."],
  ["preliminary", "text", "Original upstream status code; not interpreted as a boolean."],
  ["old_datum", "bool", "Whether NWPS flags a historical datum; such stages may not be directly comparable."],
];
const crests = reader({
  name: "historic_crests",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read published historic river crests with units and old-datum flags. This curated list is not a continuous historical observation archive.",
  columns: crestColumns,
  read: async (a) => {
    const d = await gaugeDoc(a);
    const f = nested(obj(d.body), "flood");
    return {
      rows: arr(nested(f, "crests").historic ?? []).map((v) => {
        const p = obj(v);
        return {
          gauge_id: str(a.gauge_id),
          occurred_at: time(p.occurredTime),
          stage: num(p.stage),
          stage_unit: str(f.stageUnits),
          flow: num(p.flow),
          flow_unit: str(f.flowUnits),
          preliminary: str(p.preliminary),
          old_datum: typeof p.olddatum === "boolean" ? p.olddatum : null,
          ...provenance(d),
        };
      }),
    };
  },
  example:
    "SELECT occurred_at, stage, stage_unit, old_datum FROM nws.main.historic_crests('RMDV2') ORDER BY stage DESC LIMIT 5",
  exampleDescription: "Review the largest published historical crests and datum caveats",
});
export const WATER_FUNCTIONS = [gauge, stageflow, floodThresholds, floodImpacts, crests];
