import { BBOX_OPTION, GIS_COLUMNS, GIS_OPTIONS, gisPage, gisTime } from "./gis.ts";
import { choose, pair, periodTimes } from "./outlooks.ts";
import { RASTER_COLUMNS, sampleRasters } from "./raster.ts";
import { type Args, type Col, num, type Page, readerWithOptions, str } from "./reader.ts";
import { STATE_BOUNDS } from "./state_bounds.ts";

export function wpcHour(value: unknown): number | null {
  if (value == null || value === "") return null;
  const m = typeof value === "string" ? value.match(/^(\d\d)Z (\d{4})\/(\d\d)\/(\d\d)$/) : null;
  return m ? gisTime(`${m[2]}-${m[3]}-${m[4]}T${m[1]}:00:00Z`) : gisTime(value);
}
export async function flashFloodGuidance(a: Args): Promise<Page> {
  const hours = Number(a.hours);
  if (![1, 3, 6, 12].includes(hours))
    throw new Error("hours must be 1, 3, 6 or 12; the 24-hour product was discontinued");
  const rows = await sampleRasters(
    "precip/rfc_gridded_ffg/MapServer",
    [`Flash Flood Guidance ${String(hours).padStart(2, "0")} Hour`],
    a,
  );
  return {
    rows: rows.map((r) => {
      const raw = r.raw_value;
      if (raw !== null && (typeof raw !== "number" || raw < 0)) throw new Error("Invalid flash flood guidance pixel");
      return {
        ...r,
        hours,
        raw_unit: "kg m-2",
        threshold_mm: raw ?? null,
        threshold_inches: typeof raw === "number" ? raw / 25.4 : null,
      };
    }),
  };
}
const flashFlood = readerWithOptions({
  name: "flash_flood_guidance_at",
  inputs: { latitude: "number", longitude: "number" },
  inputDocs: {
    latitude: "WGS84 latitude from -90 to 90; NULL emits no rows.",
    longitude: "WGS84 longitude from -180 to 180; NULL emits no rows.",
  },
  description:
    "Sample RFC gridded flash flood guidance: estimated rainfall over a selected duration that could cause small streams to flood under current soil/stream conditions. Native GRIB FFLDG values are kg/m², numerically equivalent to millimetres of water; inches are explicitly converted, never taken from a color class. Durations 1/3/6 hours have broad CONUS coverage; 12-hour guidance is regional. The discontinued 24-hour layer is rejected even if still listed. Coverage and RFC methods vary. This is guidance, not a forecast rainfall amount or an active warning. NoData remains NULL and no footprint emits no rows.",
  options: { hours: { default: 3, doc: "Rainfall accumulation duration: 1, 3, 6, or regional 12 hours." } },
  constraints: { hours: { choices: [1, 3, 6, 12] } },
  columns: [
    ["hours", "number", "Guidance rainfall duration."],
    ["raw_value", "number", "Native FFLDG rainfall mass per unit area."],
    ["raw_unit", "text", "kg m-2; 1 kg/m² of liquid water equals 1 mm."],
    ["threshold_mm", "number", "Estimated rainfall threshold in millimetres."],
    [
      "threshold_inches",
      "number",
      "Estimated rainfall threshold in inches, converted by dividing millimetres by 25.4.",
    ],
    ...RASTER_COLUMNS,
  ],
  read: flashFloodGuidance,
  example:
    "SELECT hours, threshold_mm, threshold_inches, valid_at FROM nws.main.flash_flood_guidance_at(38.0293,-78.4767) ORDER BY raster_id",
  exampleDescription: "Inspect three-hour flash flood guidance at Charlottesville",
});
const discussions = pair({
  name: "mesoscale_discussions",
  description:
    "Read current SPC mesoscale discussion areas for developing severe thunderstorms or hazardous winter weather. Native discussion identifiers, descriptive information and popup HTML are preserved. Popup HTML includes the source discussion link; original bulletin text is also accessible through the worker's text-product readers. NoArea placeholder polygons are omitted. These are forecaster discussions, not warnings. Each discussion may have a different publication time.",
  options: {},
  constraints: {},
  columns: [
    ["discussion_number", "text", "Native SPC discussion number."],
    ["discussion_info", "text", "Source discussion information/path, unchanged."],
    ["discussion_html", "text", "Native popup HTML containing the discussion link; do not render as trusted HTML."],
  ],
  select: () => ({
    service: "outlooks/spc_mesoscale_discussion/MapServer",
    name: "SPC Mesoscale Discussion",
    snapshot: false,
  }),
  map: (p) => ({
    discussion_number: str(p.name),
    discussion_info: str(p.folderpath),
    discussion_html: str(p.popupinfo),
  }),
  filter: (r) => r.discussion_number !== "NoArea",
  exampleColumns: "discussion_number, discussion_info, discussion_html",
});
const groups: Record<string, string[]> = {
  temperature: ["3-7 Day Temperature Outlook", "8-14 Day Temperature Outlook"],
  precipitation: ["3-7 Day Precipitation Outlook", "8-14 Day Precipitation Outlook"],
  wildfire_drought: ["3-7 Day WildFire/Drought", "8-14 Day Wildfire/Drought"],
};
const hazards = pair({
  name: "weather_hazards",
  description:
    "Read WPC/CPC days 3–7 or 8–14 weather-hazard outlooks. Native layer groups include temperature, precipitation, and wildfire/drought; the temperature group can also contain high winds, so interpret each hazard label. Labels are not invented probabilities or active warnings. Native start/end dates are retained at source precision; date-only end dates are inclusive. NoArea placeholder features are omitted.",
  options: {
    period: { default: "3_7_day", doc: "Hazard outlook period: 3_7_day or 8_14_day." },
    hazard_group: {
      default: "temperature",
      doc: "Native layer group: temperature, precipitation, or wildfire_drought.",
    },
  },
  constraints: { period: { choices: ["3_7_day", "8_14_day"] }, hazard_group: { choices: Object.keys(groups) } },
  columns: [
    ["period", "text", "Selected outlook window."],
    ["hazard_group", "text", "Selected source layer group."],
    ["hazard", "text", "Verbatim hazard label, including any probability wording."],
    ...periodTimes,
  ],
  select: (a) => ({
    service: "hazards/cpc_weather_hazards/MapServer",
    name:
      groups[choose(a.hazard_group, Object.keys(groups), "hazard_group")]?.[
        choose(a.period, ["3_7_day", "8_14_day"], "period") === "3_7_day" ? 0 : 1
      ] ?? "",
  }),
  map: (p, a) => ({
    period: str(a.period),
    hazard_group: str(a.hazard_group),
    hazard: str(p.label),
    issued_at: gisTime(p.issue_time_dt),
    valid_from: gisTime(p.start_date ?? p.valid_time_dt),
    valid_to: gisTime(p.end_date ?? p.validendtime_dt),
  }),
  filter: (r) => r.hazard !== "NoArea",
  exampleColumns: "period, hazard_group, hazard, valid_from, valid_to",
});
const components: Record<string, string> = {
  overall: "Overall_Winter_Storms",
  snow_amount: "Snow_Amount",
  snow_load: "Snow_Load",
  ice: "Ice",
  blowing_snow: "Blowing_Snow",
};
const impacts: Record<string, string> = {
  winter_weather: "WWA",
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
  extreme: "Extreme",
};
const winter = pair({
  name: "winter_storm_probability",
  description:
    "Read WPC probabilistic Winter Storm Severity Index contours for a selected impact threshold and component. Native probability contour percentages are retained; they are not exact interpolated point probabilities. forecast_hour selects a published rolling 24-hour window ending at lead 24–168 hours in six-hour increments; zero returns every published window. Read valid_from and valid_to instead of assuming local calendar days. Overlapping probability contours and forecast periods must not be summed.",
  options: {
    forecast_hour: { default: 24, doc: "Window end lead: 24,30,...,168 hours; 0 returns every available lead." },
    component: { default: "overall", doc: "Impact component: overall, snow_amount, snow_load, ice, or blowing_snow." },
    impact: { default: "moderate", doc: "Impact threshold: winter_weather, minor, moderate, major, or extreme." },
  },
  constraints: {
    forecast_hour: { ge: 0, le: 168 },
    component: { choices: Object.keys(components) },
    impact: { choices: Object.keys(impacts) },
  },
  columns: [
    ["forecast_hour", "number", "Native forecast lead at the end of the rolling window."],
    ["component", "text", "Native impact component."],
    ["impact", "text", "Native impact threshold."],
    ["probability_pct", "number", "Published probability contour in percent."],
    ...periodTimes,
  ],
  select: (a) => {
    const hour = Number(a.forecast_hour);
    if (!Number.isInteger(hour) || (hour !== 0 && (hour < 24 || hour > 168 || hour % 6 !== 0)))
      throw new Error("forecast_hour must be 0 or a six-hour increment from 24 through 168");
    return {
      service: "outlooks/wpc_wssi_p/MapServer",
      name: `${components[choose(a.component, Object.keys(components), "component")]}_${impacts[choose(a.impact, Object.keys(impacts), "impact")]}_Impacts`,
    };
  },
  map: (p) => {
    const prob = num(p.prob),
      lead = typeof p.fcsthr === "string" && /^\d+$/.test(p.fcsthr) ? Number(p.fcsthr) : num(p.fcsthr);
    if (prob !== null && (prob < 0 || prob > 100)) throw new Error("Invalid WSSI probability");
    return {
      forecast_hour: lead,
      component: str(p.component),
      impact: str(p.impact),
      probability_pct: prob,
      issued_at: wpcHour(p.inittime),
      valid_from: p.validstartdatetime == null ? wpcHour(p.validstart) : gisTime(p.validstartdatetime),
      valid_to: p.validenddatetime == null ? wpcHour(p.validend) : gisTime(p.validenddatetime),
    };
  },
  filter: (r, a) => Number(a.forecast_hour) === 0 || r.forecast_hour === Number(a.forecast_hour),
  exampleColumns: "forecast_hour, component, impact, probability_pct, valid_from, valid_to",
});
const flood = pair({
  name: "river_flood_outlook",
  description:
    "Read the national significant river flooding outlook, with source labels such as Possible, Likely, or Occurring. This general outlook does not enumerate every minor, localized, or flash-flood event. Native issue and validity times are retained. Use gauge/stageflow for location-specific river predictions and alerts for official warnings.",
  options: {},
  constraints: {},
  columns: [
    ["outlook", "text", "Native significant-flooding status."],
    ["product", "text", "Source outlook product description."],
    ...periodTimes,
  ],
  select: () => ({ service: "outlooks/sig_riv_fld_outlk/MapServer", name: "Flood Outlook" }),
  map: (p) => ({
    outlook: str(p.outlook),
    product: str(p.product),
    issued_at: gisTime(p.issue_time),
    valid_from: gisTime(p.start_time),
    valid_to: gisTime(p.end_time),
  }),
  filter: (r) => r.outlook !== "NoArea",
  exampleColumns: "outlook, product, valid_from, valid_to",
});
const beach = pair({
  name: "beach_forecast",
  description:
    "Read NWS marine/beach forecast areas for day 1 or day 2. Rip/swim risk, surf, water temperature, UV, weather and wind wording are preserved as source text, because ranges and units vary by office. Unavailable values such as N/A remain distinguishable from measured zero. The service can include locations with no current forecast; has_forecast identifies usable product-date records. This does not supply a continuous coastal ocean model.",
  options: { day: { default: 1, doc: "Beach forecast day 1 or 2 from the current source cycle." } },
  constraints: { day: { choices: [1, 2] } },
  columns: [
    ["day", "number", "Selected source forecast day."],
    ["office_id", "text", "Issuing office identifier."],
    ["beach_name", "text", "Source beach or forecast area name."],
    ["has_forecast", "bool", "Source contains a non-placeholder product date."],
    ["product_date_text", "text", "Native product date text."],
    ["product_time_text", "text", "Native product time text, preserving timezone wording."],
    ["period_text", "text", "Native forecast period description."],
    ["rip_current_risk", "text", "Source rip-current or swim-risk wording."],
    ["surf_text", "text", "Surf height/range with native units."],
    ["water_temperature_text", "text", "Water temperature with native units."],
    ["uv_text", "text", "Published UV information."],
    ["maximum_temperature_text", "text", "Maximum air temperature with native units."],
    ["weather_text", "text", "Weather forecast wording."],
    ["wind_text", "text", "Wind forecast wording."],
    ["thunderstorm_text", "text", "Thunderstorm forecast wording."],
    ["waterspout_text", "text", "Waterspout forecast wording."],
    ["product_url", "text", "Source bulletin link; returned without fetching arbitrary linked URLs."],
  ],
  select: (a) => {
    if (![1, 2].includes(Number(a.day))) throw new Error("day must be 1 or 2");
    return {
      service: "outlooks/marine_beachforecast_summary/MapServer",
      name: `Beach Forecast Day ${a.day}`,
      snapshot: false,
    };
  },
  map: (p, a) => ({
    day: Number(a.day),
    office_id: str(p.id),
    beach_name: str(p.beachname),
    has_forecast: !!str(p.productdat) && !/^(N\/A|N A)$/i.test(String(p.productdat)),
    product_date_text: str(p.productdat),
    product_time_text: str(p.producttim),
    period_text: str(p.period),
    rip_current_risk: str(p.rip),
    surf_text: str(p.surf),
    water_temperature_text: str(p.wtemp),
    uv_text: str(p.uv),
    maximum_temperature_text: str(p.maxtemp),
    weather_text: str(p.weather),
    wind_text: str(p.winds),
    thunderstorm_text: str(p.tstorm),
    waterspout_text: str(p.wspout),
    product_url: str(p.srfprod),
  }),
  exampleColumns: "office_id, beach_name, has_forecast, rip_current_risk, surf_text, water_temperature_text",
});
export function probabilityRange(text: unknown): {
  lower: number | null;
  upper: number | null;
  lowerInclusive: boolean | null;
  upperInclusive: boolean | null;
} {
  const missing = { lower: null, upper: null, lowerInclusive: null, upperInclusive: null };
  if (typeof text !== "string") return missing;
  const m = text.trim().match(/^(<=|>=|<|>)?\s*(0(?:\.\d+)?|1(?:\.0+)?)$/);
  if (!m) return missing;
  const pct = Number(m[2]) * 100;
  return m[1]?.startsWith("<")
    ? { lower: 0, upper: pct, lowerInclusive: true, upperInclusive: m[1] === "<=" }
    : m[1]?.startsWith(">")
      ? { lower: pct, upper: 100, lowerInclusive: m[1] === ">=", upperInclusive: true }
      : { lower: pct, upper: pct, lowerInclusive: true, upperInclusive: true };
}
const thresholds = [5, 10, 25, 50, 75, 90, 95];
export async function longRangeFlood(a: Args, cursor?: string): Promise<Page> {
  const threshold = Number(a.threshold_pct);
  if (!thresholds.includes(threshold)) throw new Error("Unsupported long-range map probability threshold");
  if (typeof a.state !== "string" || (a.state && !Object.hasOwn(STATE_BOUNDS, a.state)))
    throw new Error("state must be an uppercase US state/territory code");
  if (typeof a.gauge_id !== "string" || (a.gauge_id && !/^[A-Za-z0-9]{3,10}$/.test(a.gauge_id)))
    throw new Error("Invalid gauge_id");
  const page = await gisPage(
    {
      service: "outlooks/long_range_flood_outlook/MapServer",
      name: `Long_Range_Flood_Outlook_3_Months_${threshold}_Percent`,
      snapshot: false,
    },
    a,
    cursor,
    (p) => ({
      gauge_id: str(p.gaugelid),
      name: str(p.name),
      state: str(p.state),
      office_id: str(p.wfo),
      rfc_id: str(p.rfc),
      latitude: num(p.latitude),
      longitude: num(p.longitude),
      target_period: str(p.interval),
      map_category: str(p.stage),
      threshold_pct: threshold,
      minor: str(p.minor),
      moderate: str(p.moderate),
      major: str(p.major),
    }),
    false,
  );
  return {
    next: page.next,
    rows: page.rows
      .filter(
        (r) =>
          (!a.state || r.state === a.state) &&
          (!a.gauge_id || String(r.gauge_id).toUpperCase() === String(a.gauge_id).toUpperCase()),
      )
      .flatMap((r) =>
        ["minor", "moderate", "major"].map((category) => {
          const bounds = probabilityRange(r[category]);
          return {
            ...r,
            flood_category: category,
            probability_text: r[category] ?? null,
            probability_min_pct: bounds.lower,
            probability_max_pct: bounds.upper,
            min_inclusive: bounds.lowerInclusive,
            max_inclusive: bounds.upperInclusive,
          };
        }),
      ),
  };
}
const longRange = readerWithOptions({
  name: "long_range_flood_outlook",
  category: "water",
  description:
    "Read three-month probabilistic river flood outlooks at NWS forecast gauges. Emits a row for each minor/moderate/major flood category, preserving censored probabilities such as <0.05 as bounds and explicit inclusivity flags. The map threshold selects the source classification layer and does not change the native category probabilities. target_period is native season text; exact dates are not inferred. Availability is limited to locations with probabilistic forecasts. State/gauge filters continue through every page.",
  options: {
    threshold_pct: { default: 50, doc: "Published map-classification threshold: 5,10,25,50,75,90,95 percent." },
    state: { default: "", doc: "Optional uppercase US state/territory filter." },
    gauge_id: { default: "", doc: "Optional exact gauge LID, matched case-insensitively." },
    bbox: BBOX_OPTION,
    ...GIS_OPTIONS,
  },
  constraints: { threshold_pct: { choices: thresholds }, page_size: { ge: 1, le: 500 } },
  columns: [
    ["gauge_id", "text", "NWS gauge LID."],
    ["name", "text", "Gauge name."],
    ["state", "text", "State code."],
    ["office_id", "text", "Native WFO identifier."],
    ["rfc_id", "text", "Native RFC identifier."],
    ["latitude", "number", "Published gauge latitude."],
    ["longitude", "number", "Published gauge longitude."],
    ["target_period", "text", "Native three-month target label."],
    ["threshold_pct", "number", "Selected map-classification probability threshold."],
    ["map_category", "text", "Native classification at the selected threshold."],
    ["flood_category", "text", "minor, moderate or major."],
    ["probability_text", "text", "Native probability fraction text, including censoring operators."],
    ["probability_min_pct", "number", "Lower bound converted to percent; NULL if text cannot be parsed."],
    ["probability_max_pct", "number", "Upper bound converted to percent; NULL if text cannot be parsed."],
    ["min_inclusive", "bool", "Whether the lower bound is included."],
    ["max_inclusive", "bool", "Whether the upper bound is included."],
    ...GIS_COLUMNS,
  ] as Col[],
  read: longRangeFlood,
  example:
    "SELECT gauge_id, flood_category, probability_text, target_period FROM nws.main.long_range_flood_outlook(state := 'VA') ORDER BY gauge_id, flood_category",
  exampleDescription: "Inspect long-range flood probabilities for Virginia gauges without losing censored values",
});
export const HAZARD_EXTENSION_FUNCTIONS = [
  ...flashFlood,
  ...discussions,
  ...hazards,
  ...winter,
  ...flood,
  ...beach,
  ...longRange,
];
