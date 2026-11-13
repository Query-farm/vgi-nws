import { fileCursor, listingLinks } from "./file_products.ts";
import { gisTime } from "./gis.ts";
import { getJson, getText } from "./http.ts";
import { type Args, arr, json, num, obj, type Page, provenance, type Row, readerWithOptions } from "./reader.ts";

export function spacePath(value: unknown, directory: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^(json|products|text|lists)(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(value) ||
    value.split("/").some((s) => s === "." || s === "..")
  )
    throw new Error("Invalid SWPC product path; use space_weather_products");
  if (!directory && !/\.(json|txt)$/.test(value))
    throw new Error("SWPC data must be a discovered JSON or text product");
  if (directory && /\.(json|txt)$/.test(value)) throw new Error("folder must be a directory");
  return directory ? `${value.replace(/\/$/, "")}/` : value;
}
export async function spaceProducts(a: Args, cursor?: string): Promise<Page> {
  const folder = a.folder === "all" ? "all" : spacePath(a.folder, true);
  if (folder === "all" && !cursor) {
    const doc = await getText("swpc", "");
    const roots = listingLinks(String(doc.body)).filter((s) => /^(json|products|text|lists)\/$/.test(s));
    if (!roots.length) throw new Error("SWPC root directory lists no supported product folders");
    return {
      rows: roots.map((product) => ({
        product_id: product,
        kind: "directory",
        data_url: `https://services.swpc.noaa.gov/${product}`,
        ...provenance(doc),
      })),
      next: JSON.stringify(roots),
    };
  }
  const queue: string[] = cursor
    ? JSON.parse(cursor)
    : folder === "all"
      ? ["json/", "products/", "text/", "lists/"]
      : [folder];
  const current = queue.shift();
  if (!current) throw new Error("Invalid SWPC directory cursor");
  const path = spacePath(current, true),
    doc = await getText("swpc", path);
  const links = listingLinks(String(doc.body)).filter((s) =>
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/|\.json|\.txt)$/.test(s),
  );
  const rows: Row[] = [];
  for (const link of links) {
    const directory = link.endsWith("/"),
      product = spacePath(path + link, directory);
    // Animations contain image frame sequences, not numeric/text products.
    if (directory && link === "animations/") continue;
    rows.push({
      product_id: product,
      kind: directory ? "directory" : link.endsWith(".json") ? "json" : "text",
      data_url: `https://services.swpc.noaa.gov/${product}`,
      ...provenance(doc),
    });
    if (directory && a.recursive) {
      if (product.split("/").length > 8) throw new Error("SWPC directory nesting exceeded its bound");
      queue.push(product);
    }
  }
  if (queue.length > 1000) throw new Error("Too many SWPC directories; narrow the folder");
  return { rows, next: queue.length ? JSON.stringify(queue) : undefined };
}
export function spaceRecords(body: unknown): { records: unknown[]; keys?: string[]; context: unknown } {
  if (Array.isArray(body)) {
    if (
      body.length &&
      Array.isArray(body[0]) &&
      body[0].every((v) => typeof v === "string") &&
      body.slice(1).every(Array.isArray)
    ) {
      const headers = body[0] as string[];
      if (new Set(headers).size !== headers.length) throw new Error("Duplicate SWPC table column names");
      return {
        records: body.slice(1).map((row) => {
          if (row.length !== headers.length) throw new Error("SWPC table row does not match its header");
          return Object.fromEntries(headers.map((key, i) => [key, row[i]]));
        }),
        context: { columns: headers },
      };
    }
    return { records: body, context: null };
  }
  const data = obj(body);
  if (Array.isArray(data.coordinates) && typeof data["Data Format"] === "string") {
    const { coordinates, ...context } = data;
    return {
      records: arr(coordinates).map((v) => {
        const c = arr(v);
        if (c.length !== 3 || c.some((x) => num(x) === null)) throw new Error("Malformed SWPC aurora coordinate");
        return { longitude: c[0], latitude: c[1], aurora: c[2] };
      }),
      context,
    };
  }
  // Numeric horizon keys are used by the current NOAA scales product.
  const keys = Object.keys(data);
  if (keys.length && keys.every((k) => /^-?\d+$/.test(k)))
    return { records: keys.map((k) => data[k]), keys, context: null };
  return { records: [data], context: null };
}
function sourceTime(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  let text = value;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)) text = `${text.replace(" ", "T")}Z`;
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text)) return gisTime(text);
  return null;
}
export async function spaceRows(a: Args, cursor?: string): Promise<Page> {
  const path = spacePath(a.product_id, false),
    isText = path.endsWith(".txt"),
    doc = await (isText ? getText : getJson)("swpc", path);
  if (isText)
    return {
      rows: [
        {
          product_id: path,
          record_index: 0,
          record_key: null,
          observed_at: null,
          forecast_at: null,
          record_json: null,
          context_json: null,
          text: String(doc.body),
          ...provenance(doc),
        },
      ],
    };
  const data = spaceRecords(doc.body),
    state = fileCursor(JSON.stringify(doc.body), cursor, data.records.length, a.page_size),
    until = Math.min(data.records.length, state.offset + state.size);
  const context = data.context && typeof data.context === "object" ? obj(data.context) : {};
  return {
    next: state.token(until),
    rows: data.records.slice(state.offset, until).map((record, i) => {
      const p = record && typeof record === "object" && !Array.isArray(record) ? obj(record) : {};
      return {
        product_id: path,
        record_index: state.offset + i,
        record_key: data.keys?.[state.offset + i] ?? null,
        observed_at: sourceTime(p.time_tag ?? p["Observation Time"] ?? context["Observation Time"]),
        forecast_at: sourceTime(p["Forecast Time"] ?? context["Forecast Time"]),
        record_json: json(record),
        context_json: json(data.context),
        text: null,
        ...provenance(doc),
      };
    }),
  };
}
export const SPACE_WEATHER_FUNCTIONS = [
  ...readerWithOptions({
    name: "space_weather_products",
    category: "reference",
    description:
      "Discover current SWPC JSON and text products from the official public directories. Covers geomagnetic indices and forecasts, solar wind, GOES particles/X-rays/magnetometers, aurora models, NOAA scales, alerts, bulletins and solar-cycle products. Directory rows can be passed back as folder; file product_ids can be read with space_weather_rows. Image animation folders are omitted. Files and available durations can change, so use discovery instead of constructing guessed URLs.",
    options: {
      folder: {
        default: "all",
        doc: "Directory path from discovery, or the special value all to discover top-level folders. Example: json/goes/primary.",
      },
      recursive: {
        default: false,
        doc: "Recursively scan child directories. max_pages bounds directory requests and fails rather than silently truncating.",
      },
    },
    columns: [
      ["product_id", "text", "Trusted relative SWPC file or directory path."],
      ["kind", "text", "json, text, or directory."],
      ["data_url", "text", "Canonical official source URL."],
    ],
    read: spaceProducts,
    example:
      "SELECT product_id, kind FROM nws.main.space_weather_products(folder := 'json/goes/primary') ORDER BY product_id",
    exampleDescription: "Discover current GOES space-weather feeds",
  }),
  ...readerWithOptions({
    name: "space_weather_rows",
    inputs: { product_id: "text" },
    inputDocs: { product_id: "Exact JSON/text product path returned by space_weather_products; NULL emits no rows." },
    exampleInputs: ["'products/noaa-scales.json'"],
    description:
      "Read SWPC data records or original forecast/alert bulletin text. Object arrays emit native records; header-row tables become objects without changing native string/number/null values. NOAA-scale horizon keys remain record_key. Aurora grids emit one longitude/latitude/aurora row with original model timing and format in context_json. No physical units, missing codes or risk category are invented; consult native fields and the product's documentation. Explicit native UTC time_tag and aurora timestamps are exposed when available. Pages retain a source-content fingerprint and fail if the file changes mid-read. This is current published space-weather data, not a comprehensive archive.",
    options: {
      page_size: { default: 500, doc: "Records per batch, 1–1000. Text products emit one original-text row." },
    },
    constraints: { page_size: { ge: 1, le: 1000 } },
    columns: [
      ["product_id", "text", "Selected relative SWPC product path."],
      ["record_index", "number", "Zero-based source row; not a stable record ID."],
      ["record_key", "text", "Native key for keyed products such as NOAA scale horizons."],
      ["observed_at", "time", "Explicit native time_tag/observation time when present; NULL otherwise."],
      ["forecast_at", "time", "Explicit native forecast time when present; NULL otherwise."],
      [
        "record_json",
        "text",
        "Full native record, preserving string values, native missing markers and nested quantities.",
      ],
      ["context_json", "text", "Original table header or grid metadata needed to interpret each record."],
      ["text", "text", "Original complete text bulletin, or NULL for JSON data."],
    ],
    read: spaceRows,
    example:
      "SELECT record_key, record_json FROM nws.main.space_weather_rows('products/noaa-scales.json') ORDER BY record_key",
    exampleDescription: "Inspect current and forecast NOAA space-weather scales without losing native probabilities",
  }),
];
