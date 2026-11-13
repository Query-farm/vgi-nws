import { checkedBody } from "./gis.ts";
import { getJson } from "./http.ts";
import { IMAGE_COLUMNS, IMAGE_OPTIONS, imagePage } from "./image_service.ts";
import { choose } from "./outlooks.ts";
import { type Args, type Page, readerWithOptions, str } from "./reader.ts";

interface AirProduct {
  service: string;
  pollutant: string;
  statistic: string;
  hours: number | null;
  unit: string | null;
  correction: boolean;
}
export const AIR_PRODUCTS: Record<string, AirProduct> = {
  pm25_1h: {
    service: "ndgd_apm25_hr01",
    pollutant: "PM2.5",
    statistic: "mean",
    hours: 1,
    unit: "ug m-3",
    correction: true,
  },
  pm25_24h: {
    service: "ndgd_apm25_hr24",
    pollutant: "PM2.5",
    statistic: "mean",
    hours: 24,
    unit: "ug m-3",
    correction: true,
  },
  pm25_daily_max: {
    service: "ndgd_mpm25_hr01",
    pollutant: "PM2.5",
    statistic: "daily_maximum",
    hours: 1,
    unit: "ug m-3",
    correction: true,
  },
  ozone_1h: {
    service: "ndgd_ozone_1hr_avg_time",
    pollutant: "ozone",
    statistic: "mean",
    hours: 1,
    unit: "ppb",
    correction: true,
  },
  ozone_8h: {
    service: "ndgd_ozone_8hr_avg_time",
    pollutant: "ozone",
    statistic: "mean",
    hours: 8,
    unit: "ppb",
    correction: true,
  },
  ozone_daily_max_1h: {
    service: "ndgd_ozone_1hr_max_time",
    pollutant: "ozone",
    statistic: "daily_maximum",
    hours: 1,
    unit: "ppb",
    correction: true,
  },
  ozone_daily_max_8h: {
    service: "ndgd_ozone_8hr_max_time",
    pollutant: "ozone",
    statistic: "daily_maximum",
    hours: 8,
    unit: "ppb",
    correction: true,
  },
  smoke_surface: {
    service: "ndgd_smoke_sfc_1hr_avg_time",
    pollutant: "smoke",
    statistic: "surface_mean",
    hours: 1,
    unit: null,
    correction: false,
  },
  smoke_column: {
    service: "ndgd_smoke_vert_1hr_avg_time",
    pollutant: "smoke",
    statistic: "column_integral",
    hours: 1,
    unit: null,
    correction: false,
  },
  dust_surface: {
    service: "ndgd_dust_sfc_time",
    pollutant: "dust",
    statistic: "surface_concentration",
    hours: null,
    unit: "ug m-3",
    correction: false,
  },
  dust_column: {
    service: "ndgd_dust_vert_time",
    pollutant: "dust",
    statistic: "column_integral",
    hours: null,
    unit: null,
    correction: false,
  },
};
export async function airQuality(a: Args, cursor?: string): Promise<Page> {
  const product = choose(a.product, Object.keys(AIR_PRODUCTS), "product"),
    selected = AIR_PRODUCTS[product];
  if (!selected) throw new Error("Unknown air-quality product");
  if (typeof a.bias_corrected !== "boolean" || (a.bias_corrected && !selected.correction))
    throw new Error("Bias correction is available only for PM2.5 and ozone");
  const service = `air_quality/${selected.service}${a.bias_corrected ? "_bc" : ""}/ImageServer`;
  const metadata = checkedBody((await getJson("raster", `${service}?f=json`)).body);
  const page = await imagePage({ ...a, product_id: `raster:${service}` }, cursor);
  return {
    next: page.next,
    rows: page.rows.map((r) => {
      if (r.band_index !== 1) throw new Error("Expected a single-band air-quality field");
      return {
        ...r,
        product,
        pollutant: selected.pollutant,
        statistic: selected.statistic,
        averaging_hours: selected.hours,
        bias_corrected: a.bias_corrected ?? false,
        value: r.raw_value ?? null,
        unit: selected.unit,
        source_description: str(metadata.serviceDescription) || str(metadata.description),
        interpretation_note:
          selected.unit === null
            ? "Source descriptions give ambiguous smoke/column units; native values are retained without conversion."
            : product === "pm25_1h" && a.bias_corrected
              ? "The hr01 service identifier and native hourly validity are retained; its legacy prose describes a 24-hour average. Confirm source metadata before averaging."
              : null,
      };
    }),
  };
}
export const AIR_QUALITY_FUNCTIONS = readerWithOptions({
  name: "air_quality_at",
  inputs: { latitude: "number", longitude: "number" },
  inputDocs: {
    latitude: "WGS84 latitude, -90 to 90; NULL emits no rows.",
    longitude: "WGS84 longitude, -180 to 180; NULL emits no rows.",
  },
  description:
    "Read NWS air-quality forecast rasters at a point, covering all published PM2.5, ozone, smoke and dust service variants. Native values and complete currently published time slices are preserved. PM2.5 and surface dust use micrograms/m³ and ozone uses ppb according to service descriptions. Smoke and column-integral descriptions contain ambiguous units, so unit remains NULL and source_description/interpretation_note retain that uncertainty. No AQI, health category, or unit conversion is inferred. Product averaging periods and daily maxima are separate choices; native validity times remain authoritative. The hr01 bias-corrected PM2.5 service has conflicting legacy averaging prose, explicitly noted in output.",
  options: {
    product: {
      default: "pm25_1h",
      doc: "Air-quality product selector; PM2.5/ozone averages and daily maxima, surface/column smoke, or surface/column dust.",
    },
    bias_corrected: {
      default: false,
      doc: "Select the separately published bias-corrected PM2.5 or ozone product; unsupported for smoke/dust.",
    },
    ...IMAGE_OPTIONS,
  },
  constraints: { product: { choices: Object.keys(AIR_PRODUCTS) }, page_size: { ge: 1, le: 20 } },
  columns: [
    ["product", "text", "Requested air-quality variant."],
    ["pollutant", "text", "PM2.5, ozone, smoke or dust."],
    ["statistic", "text", "Mean, daily maximum, surface concentration or column integral."],
    [
      "averaging_hours",
      "number",
      "Averaging period identified by the product selector; NULL where unspecified. Read interpretation_note for source inconsistencies.",
    ],
    ["bias_corrected", "bool", "Whether the bias-corrected source product was requested."],
    ["value", "number", "Native concentration/integral pixel, without conversion or AQI calculation."],
    ["unit", "text", "Source-described ug m-3 or ppb; NULL for ambiguous smoke/column units."],
    ["source_description", "text", "Original service description, including source unit/averaging claims."],
    ["interpretation_note", "text", "Known source interpretation caveats; NULL if none identified."],
    ...IMAGE_COLUMNS,
  ],
  read: airQuality,
  example:
    "SELECT pollutant, value, unit, valid_from, issued_at FROM nws.main.air_quality_at(38.0293,-78.4767) ORDER BY valid_from, raster_id",
  exampleDescription: "Inspect the complete available PM2.5 forecast at Charlottesville",
});
