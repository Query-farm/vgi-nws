import { getJson } from "./http.ts";
import { choose } from "./outlooks.ts";
import { type Args, arr, id, json, num, obj, provenance, query, reader, readerWithOptions, str } from "./reader.ts";
import { statusTime } from "./water_discovery.ts";

const inputs = { gauge_id: "text" } as const;
const inputDocs = {
  gauge_id: "NWPS NWS LID or USGS site identifier, for example RMDV2 or 02037500. NULL emits no rows.",
};
const gaugeDoc = (a: Args) => getJson("water", `/gauges/${id(a.gauge_id)}`);
const reachInputs = { reach_id: "text" } as const;
const reachDocs = {
  reach_id: "Numeric National Water Model reach identifier as text; discover it with gauge. NULL emits no rows.",
};
const reachPath = (a: Args) => `/reaches/${id(a.reach_id, /^[1-9]\d*$/)}`;

const ratings = readerWithOptions({
  name: "rating_curve",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read the published NWPS stage-to-discharge rating table with native units. This is a relationship table, not an observed time series or a rating-history archive. Stage is relative to the gauge datum. The API has a limit and no documented offset; possibly_truncated flags a full-limit response. No interpolation, extrapolation, or automatic unit conversion is performed.",
  options: {
    row_limit: {
      default: 10000,
      doc: "Maximum rating points requested, 1–10000. A full-limit response may omit points; inspect possibly_truncated.",
    },
    sort: { default: "ASC", doc: "Sort by stage, ASC or DESC." },
    only_tenths: {
      default: false,
      doc: "Ask NWPS to retain only tenths-of-a-foot increments; this is source filtering, not local rounding.",
    },
  },
  constraints: { row_limit: { ge: 1, le: 10000 }, sort: { choices: ["ASC", "DESC"] } },
  columns: [
    ["gauge_id", "text", "Requested gauge identifier."],
    ["stage", "number", "Stage in the gauge datum."],
    ["stage_unit", "text", "Native stage units."],
    ["flow", "number", "Rated discharge at this stage."],
    ["flow_unit", "text", "Native discharge units, not necessarily the same as stageflow."],
    [
      "possibly_truncated",
      "bool",
      "True when response length reaches the requested limit; completeness cannot then be guaranteed.",
    ],
  ],
  read: async (a) => {
    if (!Number.isInteger(a.row_limit) || Number(a.row_limit) < 1 || Number(a.row_limit) > 10000)
      throw new Error("row_limit must be a whole number from 1 to 10000");
    const doc = await getJson(
      "water",
      query(`/gauges/${id(a.gauge_id)}/ratings`, {
        limit: a.row_limit,
        sort: choose(a.sort, ["ASC", "DESC"], "sort"),
        onlyTenths: a.only_tenths,
      }),
    );
    const p = obj(doc.body),
      values = arr(p.data);
    return {
      rows: values.map((v) => {
        const r = obj(v);
        return {
          gauge_id: str(a.gauge_id),
          stage: num(r.stage),
          stage_unit: str(p.stageUnits),
          flow: num(r.flow),
          flow_unit: str(p.flowUnits),
          possibly_truncated: values.length >= Number(a.row_limit),
          ...provenance(doc),
        };
      }),
    };
  },
  example:
    "SELECT stage, stage_unit, flow, flow_unit, possibly_truncated FROM nws.main.rating_curve('RMDV2') ORDER BY stage",
  exampleDescription: "Inspect the published stage-discharge rating and its completeness flag",
});

const reach = reader({
  name: "reach",
  category: "water",
  inputs: reachInputs,
  inputDocs: reachDocs,
  description:
    "Retrieve National Water Model reach metadata, available streamflow series, and immediate upstream/downstream reach IDs with stream order. Reach IDs identify model river segments, not gauge stations. Metadata lists potential series; a listed series can currently contain no data.",
  columns: [
    ["reach_id", "text", "National Water Model reach identifier."],
    ["name", "text", "Reach name."],
    ["latitude", "number", "Representative reach latitude in decimal degrees."],
    ["longitude", "number", "Representative reach longitude in decimal degrees."],
    ["available_series_json", "text", "NWPS series identifiers available for this reach."],
    ["upstream_json", "text", "Immediate upstream segments, retaining reachId and streamOrder."],
    ["downstream_json", "text", "Immediate downstream segments, retaining reachId and streamOrder."],
    ["metadata_json", "text", "Complete native reach metadata."],
  ],
  read: async (a) => {
    const doc = await getJson("water", reachPath(a)),
      p = obj(doc.body),
      route = obj(p.route ?? {});
    return {
      rows: [
        {
          reach_id: str(p.reachId),
          name: str(p.name),
          latitude: num(p.latitude),
          longitude: num(p.longitude),
          available_series_json: json(p.streamflow),
          upstream_json: json(route.upstream),
          downstream_json: json(route.downstream),
          metadata_json: json(p),
          ...provenance(doc),
        },
      ],
    };
  },
  example: "SELECT reach_id, name, available_series_json, upstream_json FROM nws.main.reach('23021904')",
  exampleDescription: "Discover model streamflow products and connected segments for Deep Creek",
});

export const STREAMFLOW_SERIES: Record<string, string> = {
  analysis_assimilation: "analysisAssimilation",
  short_range: "shortRange",
  medium_range: "mediumRange",
  long_range: "longRange",
  medium_range_blend: "mediumRangeBlend",
};
export function streamflowRows(body: unknown, reachId: string, series: string) {
  const key = STREAMFLOW_SERIES[choose(series, Object.keys(STREAMFLOW_SERIES), "series")];
  const p = obj(body),
    group = obj(p[key ?? ""] ?? {});
  return Object.entries(group).flatMap(([member, value]) => {
    const forecast = obj(value);
    return arr(forecast.data ?? []).map((v) => {
      const r = obj(v);
      return {
        reach_id: reachId,
        series,
        member,
        reference_at: statusTime(forecast.referenceTime),
        valid_at: statusTime(r.validTime),
        flow: num(r.flow),
        flow_unit: str(forecast.units),
      };
    });
  });
}
const streamflow = readerWithOptions({
  name: "reach_streamflow",
  category: "water",
  inputs: reachInputs,
  inputDocs: reachDocs,
  exampleInputs: ["'23021904'"],
  description:
    "Read National Water Model streamflow for a reach: analysis_assimilation, short_range, medium_range, long_range, or medium_range_blend. These are model outputs, including the assimilated analysis, not direct gauge measurements. Preserve member and reference_at: ensemble means and members are separate series and must not be summed. Empty upstream products return no rows. Units are retained verbatim.",
  options: {
    series: {
      default: "short_range",
      doc: "National Water Model product identifier; short_range by default. Choose analysis_assimilation for modeled analysis or a medium/long range product for forecasts.",
    },
  },
  constraints: { series: { choices: Object.keys(STREAMFLOW_SERIES) } },
  columns: [
    ["reach_id", "text", "Requested National Water Model reach identifier."],
    ["series", "text", "Selected model product."],
    ["member", "text", "Native series key, such as series, mean, or member1. Not all products have ensemble members."],
    ["reference_at", "time", "UTC model reference/cycle time."],
    ["valid_at", "time", "UTC forecast or analysis valid time."],
    ["flow", "number", "Model streamflow value; missing values remain NULL."],
    ["flow_unit", "text", "Verbatim model discharge units; no conversion to gauge units."],
  ],
  read: async (a) => {
    const series = choose(a.series, Object.keys(STREAMFLOW_SERIES), "series");
    const doc = await getJson("water", query(`${reachPath(a)}/streamflow`, { series }));
    return { rows: streamflowRows(doc.body, String(a.reach_id), series).map((r) => ({ ...r, ...provenance(doc) })) };
  },
  example:
    "SELECT member, max(flow) AS peak, flow_unit FROM nws.main.reach_streamflow('23021904') GROUP BY member, flow_unit ORDER BY member",
  exampleDescription: "Find model streamflow peaks by member without mixing units",
});

const lowThreshold = reader({
  name: "low_water_threshold",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read a gauge's published NWPS low-water threshold with its native units. A missing threshold returns no rows. It is distinct from flood categories and does not establish navigability or water availability.",
  columns: [
    ["gauge_id", "text", "Requested gauge identifier."],
    ["threshold", "number", "Published low-water threshold."],
    ["unit", "text", "Native threshold units; do not assume stage or flow."],
  ],
  read: async (a) => {
    const doc = await gaugeDoc(a),
      value = obj(doc.body).lowThreshold;
    if (value == null) return { rows: [] };
    const p = obj(value);
    return { rows: [{ gauge_id: str(a.gauge_id), threshold: num(p.value), unit: str(p.units), ...provenance(doc) }] };
  },
  example: "SELECT gauge_id, threshold, unit FROM nws.main.low_water_threshold('RMDV2') ORDER BY gauge_id",
  exampleDescription: "Inspect a published low-water threshold when available",
});
const lowImpacts = reader({
  name: "low_water_impacts",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read published NWPS low-water impact statements. The associated value is source text and may include qualifications; no numeric stage or unit is inferred. A gauge without impact statements returns no rows.",
  columns: [
    ["gauge_id", "text", "Requested gauge identifier."],
    ["value_text", "text", "Verbatim associated value, without inferred units or conversion."],
    ["statement", "text", "Original low-water impact statement."],
  ],
  read: async (a) => {
    const doc = await gaugeDoc(a);
    return {
      rows: arr(obj(doc.body).impactsLowWaters ?? []).map((v) => {
        const p = obj(v);
        return {
          gauge_id: str(a.gauge_id),
          value_text: str(p.value),
          statement: str(p.impact),
          ...provenance(doc),
        };
      }),
    };
  },
  example: "SELECT value_text, statement FROM nws.main.low_water_impacts('RMDV2') ORDER BY value_text",
  exampleDescription: "Read local low-water impacts with their original threshold wording",
});
const lowHistory = reader({
  name: "historic_low_water",
  category: "water",
  inputs,
  inputDocs,
  description:
    "Read the NWPS curated historical low-water events, including stage, flow, units, date, and original statement. This is not a continuous historical record. Stage is relative to the gauge datum; the source does not supply a datum-change flag for these events.",
  columns: [
    ["gauge_id", "text", "Requested gauge identifier."],
    ["occurred_at", "time", "UTC occurrence supplied by NWPS; missing sentinel dates become NULL."],
    ["stage", "number", "Historical low-water stage in the declared units; negative stages can be valid."],
    ["stage_unit", "text", "Native stage units."],
    ["flow", "number", "Historical low-water discharge."],
    ["flow_unit", "text", "Native discharge units."],
    ["statement", "text", "Original event description."],
  ],
  read: async (a) => {
    const doc = await gaugeDoc(a),
      flood = obj(obj(doc.body).flood ?? {}),
      lows = obj(flood.lowWaters ?? {});
    return {
      rows: arr(lows.historic ?? []).map((v) => {
        const p = obj(v);
        return {
          gauge_id: str(a.gauge_id),
          occurred_at: statusTime(p.occurredTime),
          stage: num(p.stage),
          stage_unit: str(flood.stageUnits),
          flow: num(p.flow),
          flow_unit: str(flood.flowUnits),
          statement: str(p.statement),
          ...provenance(doc),
        };
      }),
    };
  },
  example:
    "SELECT occurred_at, stage, stage_unit, flow, flow_unit, statement FROM nws.main.historic_low_water('RMDV2') ORDER BY occurred_at",
  exampleDescription: "Review published historical low-water events and their units",
});
export const WATER_EXTENDED_FUNCTIONS = [...ratings, reach, ...streamflow, lowThreshold, lowImpacts, lowHistory];
