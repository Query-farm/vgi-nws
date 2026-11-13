import { choose } from "./outlooks.ts";
import { RASTER_COLUMNS, sampleRasters } from "./raster.ts";
import { type Args, type Page, readerWithOptions } from "./reader.ts";

const inputs = { latitude: "number", longitude: "number" } as const;
const inputDocs = {
  latitude: "WGS84 latitude, -90 to 90; NULL emits no rows.",
  longitude: "WGS84 longitude, -180 to 180, west negative; NULL emits no rows.",
};
const rasterSemantics =
  " Raw NoData within a raster becomes NULL; no raster footprint emits no rows. Source valid, issue, file, and retrieval times remain separate. Each overlapping raster is a separate row; use its name and provenance, never sum overlaps. The service is not a historical archive.";
export const SOIL_REGIONS: Record<string, string> = {
  conus: "CONUS",
  alaska: "Alaska",
  hawaii: "Hawaii",
  puerto_rico: "Puerto Rico",
};
const soilLayer = (region: string) => `${SOIL_REGIONS[region]} Near-Surface Soil Moisture (% saturation)`;
export function saturationPercent(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Expected a soil saturation fraction between 0 and 1");
  return value * 100;
}
export async function soilMoisture(a: Args): Promise<Page> {
  const region = choose(a.region, ["auto", ...Object.keys(SOIL_REGIONS)], "region");
  const regions = region === "auto" ? Object.keys(SOIL_REGIONS) : [region];
  const samples = await sampleRasters("obs/NWM_Land_Analysis/MapServer", regions.map(soilLayer), a);
  return {
    rows: samples.map((r) => ({
      ...r,
      region: regions.find((key) => soilLayer(key) === String(r.layer_name).trim()) ?? null,
      saturation_pct: saturationPercent(r.raw_value),
      raw_unit: "fraction",
      soil_depth_cm: 40,
    })),
  };
}
const soil = readerWithOptions({
  name: "soil_moisture_at",
  inputs,
  inputDocs,
  description:
    "Sample National Water Model near-surface soil moisture saturation for the top 40 cm. This is modeled saturation, not volumetric water content, a garden sensor reading, or an irrigation prescription. Native 0–1 fractions are preserved in raw_value and explicitly converted to saturation_pct. Auto checks all four published regional layers and retains their actual coverage." +
    rasterSemantics,
  options: {
    region: {
      default: "auto",
      doc: "Published model region: auto, conus, alaska, hawaii, or puerto_rico. Auto queries all regions and returns only rasters with footprints at the point.",
    },
  },
  constraints: { region: { choices: ["auto", ...Object.keys(SOIL_REGIONS)] } },
  columns: [
    ["region", "text", "Resolved model region, never auto in output."],
    ["saturation_pct", "number", "Modeled saturation in percent, converted from the native 0–1 fraction."],
    ["raw_value", "number", "Native soil saturation fraction; not a map color/class code."],
    ["raw_unit", "text", "fraction; multiply by 100 for percent saturation."],
    ["soil_depth_cm", "number", "Depth represented by the near-surface product: top 40 cm."],
    ...RASTER_COLUMNS,
  ],
  read: soilMoisture,
  example:
    "SELECT region, saturation_pct, soil_depth_cm, valid_at FROM nws.main.soil_moisture_at(38.0293,-78.4767) ORDER BY region, raster_id",
  exampleDescription: "Inspect modeled near-surface soil saturation at Charlottesville",
});

export const ANOMALY_PERIODS: Record<string, string> = {
  today: "Today's",
  day7: "Last 7 Days",
  day10: "Last 10 Days",
  day14: "Last 14 Days",
  day30: "Last 30 Days",
  day60: "Last 60 Days",
  day90: "Last 90 Days",
  day120: "Last 120 Days",
  day180: "Last 180 Days",
  day365: "Last 365 Days",
  month_to_date: "Month to Date",
  year_to_date: "Year to Date",
  water_year_to_date: "Water Year to Date",
};
const metrics: Record<string, string> = {
  normal: "Normal (inches)",
  departure: "Departure from Normal (inches)",
  percent_of_normal: "Percent of Normal (%)",
};
export async function precipitationAnomaly(a: Args): Promise<Page> {
  const period = choose(a.period, Object.keys(ANOMALY_PERIODS), "period");
  const metric = choose(a.metric, ["all", ...Object.keys(metrics)], "metric");
  const selected = metric === "all" ? Object.keys(metrics) : [metric];
  const name = (key: string) => `${ANOMALY_PERIODS[period]} ${metrics[key]}`;
  const samples = await sampleRasters("obs/rfc_qpe/MapServer", selected.map(name), a);
  return {
    rows: samples.map((r) => {
      const metric = selected.find((key) => name(key) === String(r.layer_name).trim());
      if (!metric) throw new Error("Unknown precipitation anomaly layer");
      if (r.raw_value !== null && (typeof r.raw_value !== "number" || (metric !== "departure" && r.raw_value < 0)))
        throw new Error("Invalid precipitation normal or percent value");
      return {
        ...r,
        period,
        metric,
        value: r.raw_value ?? null,
        unit: metric === "percent_of_normal" ? "percent" : "inches",
      };
    }),
  };
}
const anomalies = readerWithOptions({
  name: "precipitation_anomaly_at",
  inputs,
  inputDocs,
  description:
    "Read RFC precipitation normals and comparisons with PRISM normals: normal amount, observed departure from normal, or percent of normal. Default all returns three separate metrics. Negative departure indicates a deficit; 100 percent means the normal amount, not a rain probability. Read the published pixels directly, without dividing by a potentially zero normal or inferring the climatological baseline years. Periods use the source's 12Z daily accounting, not local midnight. Different rasters may have different publication times." +
    rasterSemantics,
  options: {
    period: {
      default: "day30",
      doc: "Published daily accumulation window: today; day7, day10, day14, day30, day60, day90, day120, day180, day365; month_to_date, year_to_date, or water_year_to_date. Hourly normals are unavailable.",
    },
    metric: {
      default: "all",
      doc: "Comparison metric: all, normal, departure, or percent_of_normal. All returns distinct rows with their own units and timestamps.",
    },
  },
  constraints: {
    period: { choices: Object.keys(ANOMALY_PERIODS) },
    metric: { choices: ["all", ...Object.keys(metrics)] },
  },
  columns: [
    ["period", "text", "Selected daily accumulation window."],
    ["metric", "text", "normal, departure, or percent_of_normal."],
    ["value", "number", "Published raw comparison value; negative departures and zero are retained, NoData is NULL."],
    ["unit", "text", "inches for normal/departure, percent for percent_of_normal."],
    ...RASTER_COLUMNS,
  ],
  read: precipitationAnomaly,
  example:
    "SELECT metric, value, unit, issued_at FROM nws.main.precipitation_anomaly_at(38.0293,-78.4767) ORDER BY metric, raster_id",
  exampleDescription: "Compare the last 30 days of rainfall with published normals",
});

const snowLayers: Record<string, string> = { depth: "Snow Depth", water_equivalent: "Snow Water Equivalent" };
export async function snowAnalysis(a: Args): Promise<Page> {
  const variable = choose(a.variable, ["both", ...Object.keys(snowLayers)], "variable");
  const selected = variable === "both" ? Object.keys(snowLayers) : [variable];
  const samples = await sampleRasters(
    "snow/NOHRSC_Snow_Analysis/MapServer",
    selected.map((key) => snowLayers[key] ?? ""),
    a,
  );
  return {
    rows: samples.map((r) => {
      const variable = selected.find((key) => snowLayers[key] === String(r.layer_name).trim());
      if (!variable) throw new Error("Unknown snow analysis layer");
      const raw = r.raw_value;
      if (raw !== null && (typeof raw !== "number" || raw < 0)) throw new Error("Invalid snow analysis value");
      return {
        ...r,
        variable,
        raw_unit: variable === "depth" ? "m" : "kg m-2",
        value_mm: raw === null ? null : Number(raw) * (variable === "depth" ? 1000 : 1),
      };
    }),
  };
}
const snow = readerWithOptions({
  name: "snow_analysis_at",
  inputs,
  inputDocs,
  description:
    "Sample NOHRSC analyzed snow depth and snow water equivalent for the conterminous US. These analyses combine model estimates and assimilated observations; these are current snowpack quantities, not new snowfall or forecasts. Native GRIB snow depth is metres and snow water equivalent is kg per square metre. value_mm converts depth to millimetres or water equivalent to millimetres of liquid water (1 kg/m² = 1 mm). Read variable with every value and do not sum depth with water equivalent. Native pixels differ from the inches shown in the map legend. Each variable retains its own valid time." +
    rasterSemantics,
  options: {
    variable: {
      default: "both",
      doc: "Snow quantity: both, depth, or water_equivalent. Both emits separate rows and preserves each variable's valid time.",
    },
  },
  constraints: { variable: { choices: ["both", ...Object.keys(snowLayers)] } },
  columns: [
    ["variable", "text", "depth or water_equivalent; never sum these distinct quantities."],
    ["raw_value", "number", "Native GRIB pixel value; zero and missing data are distinct."],
    ["raw_unit", "text", "m for snow depth, kg m-2 for water equivalent."],
    [
      "value_mm",
      "number",
      "Snow depth in millimetres or liquid-water-equivalent millimetres, as identified by variable.",
    ],
    ...RASTER_COLUMNS,
  ],
  read: snowAnalysis,
  example:
    "SELECT variable, raw_value, raw_unit, value_mm, valid_at FROM nws.main.snow_analysis_at(40,-105) ORDER BY variable, raster_id",
  exampleDescription: "Inspect current analyzed snow depth and water equivalent near Boulder",
});
export const LAND_FUNCTIONS = [...soil, ...anomalies, ...snow];
