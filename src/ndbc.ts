import { fileCursor, listingLinks } from "./file_products.ts";
import { gisTime } from "./gis.ts";
import { getText } from "./http.ts";
import { type Args, type Col, dateRange, json, type Page, provenance, type Row, readerWithOptions } from "./reader.ts";

const PRODUCTS = [
  "txt",
  "spec",
  "data_spec",
  "swdir",
  "swdir2",
  "swr1",
  "swr2",
  "ocean",
  "supl",
  "adcp",
  "dart",
  "rain",
  "srad",
  "cwind",
  "drift",
];
function stationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9]{3,8}$/.test(value)) throw new Error("Invalid NDBC station_id");
  return value.toUpperCase();
}
function xmlText(text: string): string {
  return text
    .replace(
      /&(?:quot|apos|amp|lt|gt);/g,
      (s) => ({ "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" })[s] ?? s,
    )
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n: string) =>
      String.fromCodePoint(n[0]?.toLowerCase() === "x" ? Number.parseInt(n.slice(1), 16) : Number(n)),
    );
}
export function stationRecords(text: string): Row[] {
  if (!/<stations\b/.test(text) || !/<\/stations>/.test(text)) throw new Error("Malformed NDBC station XML");
  return [...text.matchAll(/<station\s+([^>]+)\/>/g)].map((m) => {
    const p = Object.fromEntries(
      [...String(m[1]).matchAll(/([A-Za-z_]+)="([^"]*)"/g)].map((a) => [String(a[1]), xmlText(a[2] ?? "")]),
    );
    const number = (key: string) => (p[key] == null || p[key] === "" ? null : Number(p[key]));
    const latitude = number("lat"),
      longitude = number("lon"),
      elevation = number("elev");
    if (
      latitude === null ||
      longitude === null ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180 ||
      (elevation !== null && !Number.isFinite(elevation))
    )
      throw new Error("Malformed NDBC station coordinates");
    return {
      station_id: stationId(p.id),
      name: p.name ?? null,
      latitude,
      longitude,
      elevation_m: elevation,
      owner: p.owner ?? null,
      program: p.pgm ?? null,
      station_type: p.type ?? null,
      meteorology: p.met === "y",
      currents: p.currents === "y",
      water_quality: p.waterquality === "y",
      dart: p.dart === "y",
      attributes_json: json(p),
    };
  });
}
function observed(fields: string[], combined: boolean, seconds: boolean): { timestamp: number; offset: number } {
  const [y, m, d] = fields;
  if (!y || !m || !d || !/^\d{4}$/.test(y)) throw new Error("Malformed NDBC observation date");
  const h = combined ? fields[3]?.slice(0, 2) : fields[3],
    minute = combined ? fields[3]?.slice(2) : fields[4];
  const second = seconds ? fields[5] : "00";
  if (![h, minute, second].every((v) => v && /^\d{1,2}$/.test(v))) throw new Error("Malformed NDBC observation time");
  const timestamp = gisTime(
    `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h?.padStart(2, "0")}:${minute?.padStart(2, "0")}:${second?.padStart(2, "0")}Z`,
  );
  if (timestamp === null) throw new Error("Missing NDBC observation time");
  return { timestamp, offset: combined ? 4 : seconds ? 6 : 5 };
}
function measurement(
  product: string,
  variable: string,
  value: string,
  unit: string | null,
  frequency: number | null = null,
): Row {
  const numeric = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value) ? Number(value) : null;
  const spectral = ["data_spec", "swdir", "swdir2", "swr1", "swr2"].includes(product);
  const missing =
    value === "MM" ||
    value === "N/A" ||
    (spectral && numeric === 999) ||
    (variable === "Sep_Freq" && numeric === 9.999) ||
    (product === "cwind" &&
      ((["WDIR", "GDR"].includes(variable) && numeric === 999) ||
        (["WSPD", "GST"].includes(variable) && numeric === 99) ||
        (variable === "GTIME" && numeric === 9999)));
  return {
    variable,
    value: missing ? null : numeric,
    value_text: value,
    unit: unit === "-" ? null : unit,
    is_missing: missing,
    frequency_hz: frequency,
  };
}
export function buoyLine(line: string, header: string[], units: string[] | null, product: string): Row[] {
  const parts = line.trim().split(/\s+/),
    { timestamp, offset } = observed(parts, header[3] === "hhmm", header[5] === "ss");
  const spectral = ["data_spec", "swdir", "swdir2", "swr1", "swr2"].includes(product);
  let rows: Row[];
  if (spectral) {
    const start = product === "data_spec" ? offset + 1 : offset;
    rows = product === "data_spec" ? [measurement(product, "Sep_Freq", parts[offset] ?? "", "Hz")] : [];
    if ((parts.length - start) % 2 !== 0) throw new Error("Malformed spectral frequency/value pairs");
    for (let i = start; i < parts.length; i += 2) {
      const frequency = parts[i + 1]?.match(/^\((\d*\.?\d+)\)$/)?.[1];
      if (!frequency || Number(frequency) <= 0) throw new Error("Invalid spectral frequency");
      rows.push(
        measurement(
          product,
          product === "data_spec" ? "spectral_density" : product,
          parts[i] ?? "",
          product === "data_spec" ? "m2 Hz-1" : product.startsWith("swdir") ? "degree_true" : "1",
          Number(frequency),
        ),
      );
    }
  } else if (product === "adcp") {
    if (
      (parts.length - offset) % 3 !== 0 ||
      header.slice(offset, offset + 3).join(",") !== "DEP01,DIR01,SPD01" ||
      units?.slice(offset, offset + 3).join(",") !== "m,degT,cm/s"
    )
      throw new Error("Malformed ADCP depth/direction/speed triplets");
    // NDBC's fixed header shows 20 bins, while actual records can contain more or fewer.
    rows = parts
      .slice(offset)
      .map((value, i) =>
        measurement(
          product,
          `${["DEP", "DIR", "SPD"][i % 3]}${String(Math.floor(i / 3) + 1).padStart(2, "0")}`,
          value,
          ["m", "degT", "cm/s"][i % 3] ?? null,
        ),
      );
  } else {
    if (parts.length !== header.length || (units && units.length !== header.length))
      throw new Error("NDBC columns do not match the published header");
    rows = parts
      .slice(offset)
      .map((value, i) => measurement(product, header[offset + i] ?? "", value, units?.[offset + i] ?? null));
  }
  return rows.map((r) => ({ ...r, observed_at: timestamp }));
}
export async function buoyMeasurements(a: Args, cursor?: string): Promise<Page> {
  const station = stationId(a.station_id),
    product = String(a.product);
  if (!PRODUCTS.includes(product)) throw new Error("Unsupported NDBC product; use buoy_products");
  dateRange(a);
  const start = a.start_time ? gisTime(a.start_time) : null,
    end = a.end_time ? gisTime(a.end_time) : null;
  if (typeof a.variable !== "string") throw new Error("variable must be a native column name or empty");
  const doc = await getText("ndbc", `data/realtime2/${station}.${product}`),
    text = String(doc.body);
  const lines = text.trim().split(/\r?\n/);
  if (!lines[0]?.startsWith("#YY")) throw new Error("NDBC data is missing its column header");
  const header = lines[0].slice(1).trim().split(/\s+/),
    units = lines[1]?.startsWith("#yr") ? lines[1].slice(1).trim().split(/\s+/) : null;
  const data = lines.filter((l) => l.trim() && !l.startsWith("#"));
  const state = fileCursor(text, cursor, data.length, a.page_size);
  const until = Math.min(data.length, state.offset + state.size),
    rows: Row[] = [];
  for (let i = state.offset; i < until; i++)
    for (const row of buoyLine(data[i] ?? "", header, units, product)) {
      const at = Number(row.observed_at);
      if ((start !== null && at < start) || (end !== null && at >= end) || (a.variable && row.variable !== a.variable))
        continue;
      rows.push({ station_id: station, product, record_index: i, ...row, ...provenance(doc) });
    }
  return { rows, next: state.token(until) };
}
const idInput = { station_id: "text" } as const;
const idDoc = {
  station_id: "NDBC station identifier from buoy_stations or buoy_products, case-insensitive; NULL emits no rows.",
};
const measurementColumns: Col[] = [
  ["station_id", "text", "NDBC station ID."],
  ["product", "text", "Native realtime filename suffix."],
  ["record_index", "number", "Zero-based line in this source file; not a permanent ID."],
  ["observed_at", "time", "UTC observation timestamp from the source date/time columns."],
  ["variable", "text", "Native column name or spectral component."],
  ["value", "number", "Numeric value in native units; NULL for missing or nonnumeric categorical text."],
  ["value_text", "text", "Original token, retaining missing codes and categorical information."],
  ["unit", "text", "Native header unit, or documented spectral unit; NULL when unspecified."],
  ["is_missing", "bool", "Recognized source missing token; a nonnumeric category is not automatically missing."],
  ["frequency_hz", "number", "Frequency for a spectral bin; NULL for ordinary columns and separation frequency."],
];
export const NDBC_FUNCTIONS = [
  ...readerWithOptions({
    name: "buoy_stations",
    category: "reference",
    description:
      "Discover active NDBC stations and partner platforms, including buoys, coastal stations and DART tsunami instruments. Source flags describe instrument/data capabilities, not whether every product currently has a fresh observation. Units and positions are native station metadata; drifting platform measurements may contain changing positions.",
    columns: [
      ["station_id", "text", "NDBC station ID."],
      ["name", "text", "Station name."],
      ["latitude", "number", "WGS84 latitude."],
      ["longitude", "number", "WGS84 longitude."],
      ["elevation_m", "number", "Site elevation above mean sea level in metres when supplied."],
      ["owner", "text", "Station owner."],
      ["program", "text", "Source program."],
      ["station_type", "text", "Native platform type."],
      ["meteorology", "bool", "Source meteorological data flag."],
      ["currents", "bool", "Source current data flag."],
      ["water_quality", "bool", "Source water-quality flag."],
      ["dart", "bool", "Source DART flag."],
      ["attributes_json", "text", "All original station XML attributes."],
    ],
    read: async () => {
      const doc = await getText("ndbc", "activestations.xml");
      return { rows: stationRecords(String(doc.body)).map((r) => ({ ...r, ...provenance(doc) })) };
    },
    example:
      "SELECT station_id, name, latitude, longitude FROM nws.main.buoy_stations() WHERE meteorology ORDER BY station_id",
    exampleDescription: "Discover active marine observation stations",
  }),
  ...readerWithOptions({
    name: "buoy_products",
    category: "reference",
    inputs: idInput,
    inputDocs: idDoc,
    exampleInputs: ["'44014'"],
    description:
      "List realtime files actually published for an NDBC station. Includes meteorology, wave summary/spectra, ocean chemistry, currents, radiation, rainfall, drifting platforms, supplemental wind/pressure, and DART water-column height where available. File existence does not imply freshness; inspect observation timestamps. Supported suffixes can be passed to buoy_measurements; unrecognized formats remain discoverable with supported=false.",
    columns: [
      ["station_id", "text", "Requested station ID."],
      ["product", "text", "Native file suffix."],
      ["supported", "bool", "Whether buoy_measurements currently parses this format."],
      ["data_url", "text", "Canonical data file URL."],
    ],
    read: async (a) => {
      const station = stationId(a.station_id),
        doc = await getText("ndbc", "data/realtime2/");
      return {
        rows: listingLinks(String(doc.body))
          .filter((f) => new RegExp(`^${station}\\.[a-z0-9_]+$`, "i").test(f))
          .map((f) => ({
            station_id: station,
            product: f.split(".")[1] ?? null,
            supported: PRODUCTS.includes(f.split(".")[1] ?? ""),
            data_url: `https://www.ndbc.noaa.gov/data/realtime2/${f}`,
            ...provenance(doc),
          })),
      };
    },
    example: "SELECT product, supported, data_url FROM nws.main.buoy_products('44014') ORDER BY product",
    exampleDescription: "Find currently published products for an offshore buoy",
  }),
  ...readerWithOptions({
    name: "buoy_measurements",
    inputs: idInput,
    inputDocs: idDoc,
    exampleInputs: ["'44014'"],
    description:
      "Read NDBC realtime measurements as long-form rows with native variable names, units, timestamps and original value tokens. Supports all 15 current realtime formats, including directional wave spectra and DART seconds. MM and documented spectral/continuous-wind missing codes become NULL; zero remains zero and categorical text remains available. Each spectral bin has frequency_hz; ADCP bin names and quality fields remain distinct. Source files normally cover recent observations, not a complete historical archive. File content changes during paging raise an error. DART water-column heights are raw measurements, not tsunami warnings.",
    options: {
      product: { default: "txt", doc: `Native product suffix: ${PRODUCTS.join(", ")}.` },
      variable: { default: "", doc: "Optional exact native variable name; empty returns every measurement." },
      start_time: { default: "", doc: "Optional RFC3339 inclusive observation time." },
      end_time: { default: "", doc: "Optional RFC3339 exclusive observation time." },
      page_size: {
        default: 100,
        doc: "Source observation lines per batch, 1–1000; each line may emit multiple variable or spectral-bin rows.",
      },
    },
    constraints: { product: { choices: PRODUCTS }, page_size: { ge: 1, le: 1000 } },
    columns: measurementColumns,
    read: buoyMeasurements,
    example:
      "SELECT observed_at, variable, value, unit FROM nws.main.buoy_measurements('44014', variable := 'WVHT') ORDER BY observed_at DESC",
    exampleDescription: "Read buoy wave-height observations in native metres",
  }),
];
