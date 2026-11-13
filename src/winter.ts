import { gisTime } from "./gis.ts";
import { choose, day, pair, periodTimes } from "./outlooks.ts";
import { num, str } from "./reader.ts";

/** Published bands are ranges, never exact probabilities or native category IDs. */
export function winterBand(value: unknown): [number | null, number | null] {
  const match = typeof value === "string" ? value.match(/\((\d+)-(\d+)%\)/) : null;
  if (!match) return [null, null];
  const low = Number(match[1]),
    high = Number(match[2]);
  if (low < 0 || high > 100 || low > high) throw new Error("Invalid winter probability band");
  return [low, high];
}

/** Resolve WSSI two-digit years against the full product issue year, including New Year. */
export function winterTime(value: unknown, issued: number | null): number | null {
  if (value == null || value === "") return null;
  const match = typeof value === "string" ? value.match(/^(\d\d)Z (\d\d)\/(\d\d)\/(\d\d)$/) : null;
  if (!match) return gisTime(value);
  if (issued === null) throw new Error("WSSI validity date requires a full issue year");
  const anchor = new Date(issued).getUTCFullYear();
  let year = Math.floor(anchor / 100) * 100 + Number(match[4]);
  if (year - anchor > 50) year -= 100;
  if (anchor - year > 50) year += 100;
  return gisTime(`${year}-${match[2]}-${match[3]}T${match[1]}:00:00Z`);
}

const probability = pair({
  name: "winter_precipitation",
  description:
    "Read WPC day 1–3 snow and ice accumulation probability bands. Snow thresholds are 4, 8, or 12 inches; ice uses 0.25 inches. The service names snow thresholds 'at least' while source product text says 'greater than'; both texts are retained. Bands are not exact point probabilities. Snow depth and ice accumulation are not liquid-equivalent rainfall.",
  options: {
    day: { default: 1, doc: "Forecast day 1, 2, or 3 from the current WPC cycle." },
    hazard: { default: "snow", doc: "Accumulation type: snow or ice." },
    threshold_inches: {
      default: 4,
      doc: "Snow: 4, 8, or 12 inches. Ice: exactly 0.25 inches; set this explicitly with hazard ice.",
    },
  },
  constraints: {
    day: { ge: 1, le: 3 },
    hazard: { choices: ["snow", "ice"] },
    threshold_inches: { choices: [0.25, 4, 8, 12] },
  },
  columns: [
    ["day", "number", "Forecast day."],
    ["hazard", "text", "snow or ice."],
    ["threshold_inches", "number", "Selected accumulation threshold in inches."],
    ["product", "text", "Verbatim WPC product description, including its threshold wording."],
    ["category", "text", "Native risk label and probability band."],
    ["category_code", "number", "Native category ID; not a probability."],
    ["probability_min_pct", "number", "Published lower bound of the probability band, inclusive."],
    ["probability_max_pct", "number", "Published upper bound of the probability band, inclusive."],
    ...periodTimes,
  ],
  select: (a) => {
    const d = day(a, 3),
      hazard = choose(a.hazard, ["snow", "ice"], "hazard"),
      threshold = Number(a.threshold_inches);
    if (hazard === "snow" ? ![4, 8, 12].includes(threshold) : threshold !== 0.25)
      throw new Error("Snow threshold_inches must be 4, 8, or 12; ice must be 0.25");
    return {
      service: "precip/wpc_prob_winter_precip/MapServer",
      name:
        hazard === "snow"
          ? `Day ${d} probability of at least ${threshold} inches of snow`
          : `Day ${d} probability of icing >0.25 inches`,
    };
  },
  map: (p, a) => {
    const [low, high] = winterBand(p.outlook);
    return {
      day: Number(a.day),
      hazard: str(a.hazard),
      threshold_inches: Number(a.threshold_inches),
      product: str(p.product),
      category: str(p.outlook),
      category_code: num(p.dn),
      probability_min_pct: low,
      probability_max_pct: high,
      issued_at: gisTime(p.issue_time),
      valid_from: gisTime(p.start_time),
      valid_to: gisTime(p.end_time),
    };
  },
  exampleColumns: "hazard, threshold_inches, category, probability_min_pct, probability_max_pct, valid_from",
  exampleOptions: "day := 1",
});

const components: Record<string, string> = {
  overall: "Overall_Impact",
  snow_amount: "Snow_Amount",
  snow_load: "Snow_Load",
  ice: "Ice_Accumulation",
  blowing_snow: "Blowing_Snow",
};
const severity = pair({
  name: "winter_storm_severity",
  description:
    "Read WPC Winter Storm Severity Index (WSSI) impact polygons for day 1, 2, 3, or days 1–3, overall or by component. Categories describe potential societal impacts, not probabilities, snow amounts, or official warnings. Overall is the maximum component impact; do not sum components. All published intersecting areas are retained.",
  options: {
    period: { default: "day1_3", doc: "WSSI period: day1, day2, day3, or day1_3 (the full forecast window)." },
    component: { default: "overall", doc: "WSSI component: overall, snow_amount, snow_load, ice, or blowing_snow." },
  },
  constraints: {
    period: { choices: ["day1", "day2", "day3", "day1_3"] },
    component: { choices: Object.keys(components) },
  },
  columns: [
    ["period", "text", "Selected WSSI forecast window."],
    ["component", "text", "Requested WSSI component."],
    ["source_component", "text", "Native component identifier."],
    ["impact", "text", "Verbatim impact category, including WINTER WEATHER AREA and MINOR through EXTREME."],
    ["product", "text", "Original WPC product name."],
    ...periodTimes,
  ],
  select: (a) => {
    const period = choose(a.period, ["day1", "day2", "day3", "day1_3"], "period");
    return {
      service: "outlooks/wpc_wssi/MapServer",
      name: `${components[choose(a.component, Object.keys(components), "component")]}_${period === "day1_3" ? "Days_1-3" : `Day_${period.slice(-1)}`}`,
    };
  },
  map: (p, a) => {
    const issued = gisTime(p.issue_time);
    return {
      period: str(a.period),
      component: str(a.component),
      source_component: str(p.component),
      impact: str(p.impact),
      product: str(p.product),
      issued_at: issued,
      valid_from: winterTime(p.start_time, issued),
      valid_to: winterTime(p.end_time, issued),
    };
  },
  exampleColumns: "period, component, impact, valid_from, valid_to",
  exampleOptions: "period := 'day1_3'",
});
export const WINTER_FUNCTIONS = [...probability, ...severity];
