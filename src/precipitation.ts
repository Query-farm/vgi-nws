/** RFC QPE raster sampling. Never interpret a rendered class/color as rainfall. */
import { choose } from "./outlooks.ts";
import { sampleRasters } from "./raster.ts";
import { type Args, type Page, readerWithOptions } from "./reader.ts";

export const QPE_PERIODS: Record<string, string> = {
  since_12z: "Since 12Z",
  hour1: "Last 1 Hours",
  hour2: "Last 2 Hours",
  hour3: "Last 3 Hours",
  hour6: "Last 6 Hours",
  hour12: "Last 12 Hours",
  hour24: "Last 24 Hours",
  today: "Today's Analysis",
  day2: "Last 2 Days",
  day3: "Last 3 Days",
  day4: "Last 4 Days",
  day5: "Last 5 Days",
  day6: "Last 6 Days",
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
export function pixelValue(value: unknown): number | null {
  if (value == null || value === "NoData") return null;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "")
    throw new Error("Malformed QPE pixel value");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Malformed QPE pixel value");
  return n;
}
export async function observedPrecipitation(a: Args): Promise<Page> {
  const period = choose(a.period, Object.keys(QPE_PERIODS), "period");
  const samples = await sampleRasters("obs/rfc_qpe/MapServer", [`${QPE_PERIODS[period]} Observed (inches)`], a);
  return { rows: samples.map((r) => ({ ...r, period, precipitation: pixelValue(r.raw_value), unit: "inches" })) };
}

export const PRECIPITATION_FUNCTIONS = readerWithOptions({
  name: "precipitation_observed_at",
  description:
    "Sample the latest RFC quantitative precipitation estimate raster at a WGS84 point. Values are estimated observed precipitation in inches, not forecasts or rain-gauge measurements. Period selects the published rolling/calendar accumulation. Native NoData is NULL, zero is retained, and no raster coverage returns no rows. Each overlapping raster remains a separate row: never sum these rows or overlapping periods. issued_at is the source issuance, not an asserted observation interval boundary. Raw pixels are used, never map color/class codes.",
  inputs: { latitude: "number", longitude: "number" },
  inputDocs: {
    latitude: "WGS84 latitude, -90 to 90; NULL produces no rows.",
    longitude: "WGS84 longitude, -180 to 180, west negative; NULL produces no rows.",
  },
  options: {
    period: {
      default: "hour24",
      doc: "Latest RFC accumulation window. hour24 is rolling 24 hours; today is Today's Analysis. Additional rolling and calendar choices are listed in the constraint.",
    },
  },
  constraints: { period: { choices: Object.keys(QPE_PERIODS) } },
  columns: [
    ["latitude", "number", "Requested WGS84 latitude."],
    ["longitude", "number", "Requested WGS84 longitude."],
    ["period", "text", "Requested accumulation selector."],
    ["precipitation", "number", "Raw estimated precipitation; NULL for NoData. Never a rendered class index."],
    ["unit", "text", "Native rainfall estimate units: inches."],
    ["layer_name", "text", "Published accumulation layer name."],
    ["raster_id", "number", "Current raster object ID, not stable across publications."],
    ["raster_name", "text", "Source raster dataset name."],
    ["issued_at", "time", "Source issuance timestamp; not an invented validity boundary."],
    ["source_file_at", "time", "UTC source file time."],
    ["ingested_at", "time", "UTC GIS ingestion time."],
    ["attributes_json", "text", "Original identify attributes, including raw pixel and class values."],
    ["footprint_json", "text", "Source raster metadata with original publication fields."],
    ["metadata_url", "text", "Canonical footprint metadata request URL."],
  ],
  read: observedPrecipitation,
  example:
    "SELECT period, precipitation, unit, issued_at FROM nws.main.precipitation_observed_at(38.0293, -78.4767) ORDER BY raster_id",
  exampleDescription: "Read the latest estimated 24-hour precipitation at Charlottesville",
});
