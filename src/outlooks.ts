import { BBOX_OPTION, GIS_COLUMNS, GIS_OPTIONS, gisPage, gisTime, type Layer } from "./gis.ts";
import { type Args, type Col, num, type ObjectData, type Row, readerWithOptions, type Spec, str } from "./reader.ts";

const points = { latitude: "number", longitude: "number" } as const;
const pointDocs = {
  latitude: "WGS84 latitude in decimal degrees, from -90 to 90.",
  longitude: "WGS84 longitude in decimal degrees, from -180 to 180; west is negative.",
};
const dayOption = {
  default: 1,
  doc: "Forecast day counted from the latest product cycle; availability depends on the selected product.",
};
export const periodTimes: Col[] = [
  ["issued_at", "time", "UTC product issue time when provided; file time is reported separately."],
  ["valid_from", "time", "UTC start of the forecast period."],
  ["valid_to", "time", "UTC end of the forecast period."],
];
const categoryColumns: Col[] = [
  ["category", "text", "Published risk label or the documented name of its native category code."],
  [
    "category_code",
    "number",
    "Native GIS category code. This is not necessarily a probability or common severity scale.",
  ],
];
interface Product {
  name: string;
  description: string;
  options: Spec["options"];
  constraints: Spec["constraints"];
  columns: Col[];
  select: (args: Args) => Layer;
  map: (p: ObjectData, args: Args) => Row;
  filter?: (row: Row, args: Args) => boolean;
  exampleColumns: string;
  exampleOptions?: string;
}
export function pair(product: Product) {
  return [false, true].flatMap((atPoint) => {
    const name = `${product.name}${atPoint ? "_at" : ""}`;
    return readerWithOptions({
      name,
      inputs: atPoint ? points : undefined,
      inputDocs: atPoint ? pointDocs : undefined,
      description: `${product.description} ${atPoint ? "Returns every polygon intersecting the point, including boundaries; no match means no published intersecting feature, not a guarantee of no hazard." : "Optionally restrict results with bbox; intersecting polygons are returned without clipping."}`,
      options: { ...product.options, ...GIS_OPTIONS, ...(atPoint ? {} : { bbox: BBOX_OPTION }) },
      constraints: { ...product.constraints, page_size: { ge: 1, le: 500 } },
      columns: [...product.columns, ...GIS_COLUMNS],
      read: async (a, c) => {
        const result = await gisPage(product.select(a), a, c, (p) => product.map(p, a), atPoint);
        return product.filter ? { ...result, rows: result.rows.filter((r) => product.filter?.(r, a)) } : result;
      },
      example: `SELECT ${product.exampleColumns} FROM nws.main.${name}(${atPoint ? "38.0293, -78.4767" : ""}${product.exampleOptions ? `${atPoint ? ", " : ""}${product.exampleOptions}` : ""}) ORDER BY object_id`,
      exampleDescription: `${atPoint ? "Inspect local" : "List published"} ${product.name.replaceAll("_", " ")} features with their original categories or units`,
    });
  });
}
export function day(a: Args, max: number): number {
  const value = Number(a.day);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`day must be a whole number from 1 to ${max}`);
  return value;
}
export function choose(value: unknown, choices: string[], name: string): string {
  if (typeof value !== "string" || !choices.includes(value))
    throw new Error(`Invalid ${name}: choose ${choices.join(", ")}`);
  return value;
}
const severe = pair({
  name: "severe_outlook",
  description:
    "Read SPC categorical and probabilistic convective outlooks. Categorical codes are not percentages; probabilistic contours retain the selected hazard. Overlapping contours remain separate rows.",
  options: {
    day: dayOption,
    hazard: {
      default: "categorical",
      doc: "SPC product selector; categorical, tornado, hail, wind, or severe. Day 3 and later probabilities use severe; tornado, hail, and wind are supported on days 1 and 2.",
    },
  },
  constraints: { day: { ge: 1, le: 8 }, hazard: { choices: ["categorical", "tornado", "hail", "wind", "severe"] } },
  columns: [
    ["day", "number", "Forecast day."],
    ["hazard", "text", "Selected convective product."],
    ...categoryColumns,
    ["probability_pct", "number", "Native SPC probability contour in percent; NULL for categorical outlooks."],
    ...periodTimes,
  ],
  select: (a) => {
    const d = day(a, 8),
      hazard = choose(a.hazard, ["categorical", "tornado", "hail", "wind", "severe"], "hazard");
    if (
      (hazard === "categorical" && d > 3) ||
      (hazard === "severe" && d < 3) ||
      (["tornado", "hail", "wind"].includes(hazard) && d > 2)
    )
      throw new Error("Unsupported SPC day/hazard combination");
    const kind =
      hazard === "categorical"
        ? "Categorical Outlook"
        : hazard === "severe"
          ? "Probabilistic Outlook"
          : `Probabilistic ${hazard[0]?.toUpperCase()}${hazard.slice(1)} Outlook`;
    return { service: "outlooks/SPC_wx_outlks/MapServer", name: `Day ${d} ${kind}` };
  },
  map: (p, a) => ({
    day: Number(a.day),
    hazard: str(a.hazard),
    category: str(p.label2) || str(p.label),
    category_code: num(p.dn),
    probability_pct: a.hazard === "categorical" ? null : num(p.dn),
    issued_at: gisTime(p.issue),
    valid_from: gisTime(p.valid),
    valid_to: gisTime(p.expire),
  }),
  exampleColumns: "day, hazard, category, probability_pct, valid_from, valid_to",
  exampleOptions: "day := 1",
});
const fire = pair({
  name: "fire_outlook",
  description:
    "Read SPC day 1–8 fire-weather outlooks for wind/low humidity or dry thunderstorms. Days 1–2 use categorical codes; days 3–8 use native probability fractions, converted to percent separately. A zero code means no delineated probability area, not zero risk. These are not active fire perimeters or warnings.",
  options: {
    day: dayOption,
    hazard: { default: "wind_rh", doc: "Fire-weather product: wind_rh or dry_thunderstorm." },
  },
  constraints: { day: { ge: 1, le: 8 }, hazard: { choices: ["wind_rh", "dry_thunderstorm"] } },
  columns: [
    ["day", "number", "Forecast day."],
    ["hazard", "text", "Selected fire-weather product."],
    ...categoryColumns,
    [
      "probability_pct",
      "number",
      "Day 3–8 native probability fraction multiplied by 100; NULL for categorical products and no delineated area.",
    ],
    ...periodTimes,
  ],
  select: (a) => {
    const d = day(a, 8),
      dry = choose(a.hazard, ["wind_rh", "dry_thunderstorm"], "hazard") === "dry_thunderstorm";
    return {
      service: "fire_weather/SPC_firewx/MapServer",
      name:
        d <= 2
          ? `Day ${d} Outlook${dry ? " Dry Thunderstorm" : ""}`
          : `Day ${d} ${dry ? "Dry Thunderstorm" : "Winds and Low Humidity"}`,
    };
  },
  map: (p, a) => {
    const code = num(p.dn);
    const labels: Record<number, string> =
      a.hazard === "dry_thunderstorm"
        ? { 0: "No delineated area", 5: "Isolated Dry Thunderstorm", 8: "Scattered Dry Thunderstorm" }
        : { 0: "No delineated area", 5: "Elevated", 8: "Critical", 10: "Extremely Critical" };
    return {
      day: Number(a.day),
      hazard: str(a.hazard),
      category:
        str(p.label2)?.trim() ||
        str(p.label)?.trim() ||
        (Number(a.day) <= 2 && code !== null ? labels[code] || null : null),
      category_code: code,
      probability_pct: Number(a.day) >= 3 && code !== null && code > 0 ? code * 100 : null,
      issued_at: gisTime(p.issue),
      valid_from: gisTime(p.valid),
      valid_to: gisTime(p.expire),
    };
  },
  exampleColumns: "day, hazard, category, valid_from, valid_to",
  exampleOptions: "day := 1",
});
const rain = pair({
  name: "rainfall_outlook",
  description:
    "Read WPC excessive-rainfall outlook polygons and native risk labels. This is a rainfall/flash-flood risk outlook, not a rainfall amount or an active flood warning. No probability is invented from the category code.",
  options: { day: dayOption },
  constraints: { day: { ge: 1, le: 5 } },
  columns: [
    ["day", "number", "Forecast day."],
    ...categoryColumns,
    ["risk_description", "text", "Original risk explanation when supplied by WPC."],
    ...periodTimes,
  ],
  select: (a) => ({ service: "hazards/wpc_precip_hazards/MapServer", name: `Excessive Rainfall Day ${day(a, 5)}` }),
  map: (p, a) => ({
    day: Number(a.day),
    category: str(p.outlook),
    category_code: num(p.dn),
    risk_description: str(p.snippet),
    issued_at: gisTime(p.issue_time),
    valid_from: gisTime(p.start_time),
    valid_to: gisTime(p.end_time),
  }),
  exampleColumns: "day, category, risk_description, valid_from, valid_to",
  exampleOptions: "day := 1",
});
const qpfPeriods: Record<string, string> = {
  day1: "QPF 24 Hour Day 1",
  day2: "QPF 24 Hour Day 2",
  day3: "QPF 24 Hour Day 3",
  day4_5: "QPF 48 Hour Day 4-5",
  day6_7: "QPF 48 Hour Day 6-7",
  day1_2: "QPF 48 Hour Day 1-2",
  day1_3: "QPF 72 Hour Day 1-3",
  day1_5: "QPF 120 Hour Day 1-5",
  day1_7: "QPF 168 Hour Day 1-7",
};
const precipitation = pair({
  name: "precipitation_forecast",
  description:
    "Read WPC quantitative precipitation forecast contour polygons. Values are native liquid-equivalent precipitation contour levels, not exact point estimates. Return all intersecting contours; do not sum overlapping contours or overlapping forecast periods.",
  options: {
    period: {
      default: "day1",
      doc: "WPC accumulation period selector, for example day1 or day1_7; supported periods are published in argument choices.",
    },
  },
  constraints: { period: { choices: Object.keys(qpfPeriods) } },
  columns: [
    ["period", "text", "Requested accumulation period selector."],
    ["product", "text", "Native WPC product name."],
    ["contour_value", "number", "Native precipitation contour value, not an interpolated point amount."],
    ["unit", "text", "Native precipitation units, normally Inches; not automatically converted."],
    ...periodTimes,
  ],
  select: (a) => ({
    service: "precip/wpc_qpf/MapServer",
    name: qpfPeriods[choose(a.period, Object.keys(qpfPeriods), "period")] || "",
  }),
  map: (p, a) => ({
    period: str(a.period),
    product: str(p.product),
    contour_value: num(p.qpf),
    unit: str(p.units),
    issued_at: gisTime(p.issue_time),
    valid_from: gisTime(p.start_time),
    valid_to: gisTime(p.end_time),
  }),
  exampleColumns: "period, contour_value, unit, valid_from, valid_to",
  exampleOptions: "period := 'day1'",
});
const climate = pair({
  name: "climate_outlook",
  description:
    "Read CPC 6–10 day, 8–14 day, monthly, or seasonal temperature/precipitation outlooks. Seasonal leads 1–13 select successive three-month windows; monthly and seasonal target_period text is retained without inventing exact timestamps. Probabilities refer to the published above/near/below-normal category, not temperature values, rainfall amounts, or the chance of any rain. Forecast dates have day precision; the last validity date is inclusive.",
  options: {
    period: { default: "8_14_day", doc: "CPC lead window: 6_10_day, 8_14_day, monthly, or seasonal." },
    lead: {
      default: 1,
      doc: "Seasonal layer index 1–13, each a successive three-month window. Must be 1 for other periods.",
    },
    variable: { default: "temperature", doc: "CPC variable: temperature or precipitation." },
  },
  constraints: {
    period: { choices: ["6_10_day", "8_14_day", "monthly", "seasonal"] },
    lead: { ge: 1, le: 13 },
    variable: { choices: ["temperature", "precipitation"] },
  },
  columns: [
    ["period", "text", "Selected lead window."],
    ["lead", "number", "Seasonal layer index 1–13; NULL for non-seasonal periods."],
    ["target_period", "text", "Native monthly or three-month seasonal target label, including its year(s)."],
    ["variable", "text", "Temperature or precipitation."],
    ["category", "text", "Native CPC category label relative to climatological normal."],
    ["probability_pct", "number", "Published category probability contour in percent; not chance of precipitation."],
    ["forecast_date", "time", "Forecast date at midnight UTC; no precise issue time is asserted."],
    ["valid_from", "time", "First valid date at midnight UTC."],
    ["valid_to", "time", "Last valid date at midnight UTC, inclusive; not an exclusive interval boundary."],
  ],
  select: (a) => {
    const period = choose(a.period, ["6_10_day", "8_14_day", "monthly", "seasonal"], "period"),
      variable = choose(a.variable, ["temperature", "precipitation"], "variable");
    const lead = Number(a.lead);
    if (!Number.isInteger(lead) || lead < 1 || lead > 13 || (period !== "seasonal" && lead !== 1))
      throw new Error("lead must be 1–13 for seasonal outlooks and 1 for other periods");
    if (period === "monthly" || period === "seasonal")
      return {
        service: `outlooks/cpc_${period === "monthly" ? "mthly" : "sea"}_${variable === "temperature" ? "temp" : "precip"}_outlk/MapServer`,
        name:
          period === "seasonal"
            ? `Lead ${lead}`
            : `Monthly ${variable === "temperature" ? "Temperature" : "Precipitation"} Outlook`,
      };
    return {
      service: `outlooks/cpc_${period}_outlk/MapServer`,
      name: `CPC ${period === "6_10_day" ? "6-10" : "8-14"} Day ${variable === "temperature" ? "Temperature" : "Precipitation"} Outlook`,
    };
  },
  map: (p, a) => ({
    period: str(a.period),
    variable: str(a.variable),
    lead: a.period === "seasonal" ? Number(a.lead) : null,
    target_period: str(p.valid_seas),
    category: str(p.cat),
    probability_pct: num(p.prob),
    forecast_date: gisTime(p.fcst_date),
    valid_from: gisTime(p.start_date),
    valid_to: gisTime(p.end_date),
  }),
  exampleColumns: "variable, category, probability_pct, valid_from, valid_to",
  exampleOptions: "period := '8_14_day'",
});
const drought = pair({
  name: "drought_outlook",
  description:
    "Read CPC monthly or seasonal drought outlook polygon layers for the US and Puerto Rico. These describe expected drought change, not a current drought-severity index. Native target-period text is retained without inventing a missing end year; separate island-territory point layers are outside this function's coverage.",
  options: { period: { default: "monthly", doc: "Drought outlook period: monthly or seasonal." } },
  constraints: { period: { choices: ["monthly", "seasonal"] } },
  columns: [
    ["period", "text", "Requested outlook period."],
    ["category", "text", "Original drought outlook category, including No_Drought when supplied."],
    ["forecast_date", "time", "Published forecast date at midnight UTC, with day precision."],
    ["target_period", "text", "Verbatim target period; may omit the year."],
  ],
  select: (a) => ({
    service: "outlooks/cpc_drought_outlk/MapServer",
    name: `${choose(a.period, ["monthly", "seasonal"], "period") === "monthly" ? "Monthly" : "Seasonal"} Drought Outlook For US and Puerto Rico`,
  }),
  map: (p, a) => ({
    period: str(a.period),
    category: str(p.outlook),
    forecast_date: gisTime(p.fcst_date),
    target_period: str(p.target),
  }),
  exampleColumns: "period, category, forecast_date, target_period",
  exampleOptions: "period := 'monthly'",
});
export const OUTLOOK_FUNCTIONS = [...severe, ...fire, ...rain, ...precipitation, ...climate, ...drought];
