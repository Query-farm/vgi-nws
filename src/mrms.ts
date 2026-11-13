import { listingLinks } from "./file_products.ts";
import { gisTime } from "./gis.ts";
import { gribSample } from "./grib.ts";
import { getBytes, getText } from "./http.ts";
import { MRMS_FIELDS, MRMS_FIELDS_SOURCE, type MrmsField } from "./mrms_fields.ts";
import { type Args, coords, type Page, provenance, readerWithOptions } from "./reader.ts";

export function mrmsPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^(2D|3DRefl|3DRhoHV|3DZdr)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value)
  )
    throw new Error("Invalid MRMS directory; use mrms_products");
  return `${value.replace(/\/$/, "")}/`;
}
export function mrmsFile(value: string): { filename: string; name: string; level: number; file_time: number } | null {
  const m = value.match(/^MRMS_([A-Za-z0-9_-]+)_(\d+\.\d+)_(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.grib2\.gz$/);
  if (!m) return null;
  const at = gisTime(`${m[3]}-${m[4]}-${m[5]}T${m[6]}:${m[7]}:${m[8]}Z`);
  if (at === null) throw new Error("Missing MRMS file time");
  return { filename: value, name: m[1] ?? "", level: Number(m[2]), file_time: at };
}
function fieldFor(name: string, discipline: number, category: number, parameter: number): MrmsField | null {
  const direct = MRMS_FIELDS[name];
  if (direct && direct.discipline === discipline && direct.category === category && direct.parameter === parameter)
    return direct;
  const fields = Object.values(MRMS_FIELDS).filter(
    (f) => f.discipline === discipline && f.category === category && f.parameter === parameter,
  );
  if (!fields.length) return null;
  const first = fields[0] as MrmsField;
  if (
    fields.some(
      (f) =>
        f.unit !== first.unit ||
        f.missing !== first.missing ||
        f.no_coverage !== first.no_coverage ||
        f.folded !== first.folded,
    )
  )
    return null;
  return first;
}
export function mrmsValue(raw: number | null, field: MrmsField | null): { value: number | null; status: string } {
  if (raw === null) return { value: null, status: "bitmap_missing" };
  if (!field) return { value: raw, status: "unclassified_parameter" };
  const codes = (["missing", "folded", "no_coverage"] as const).filter(
    (key) => field[key] !== null && Math.abs(raw - Number(field[key])) < 1e-8,
  );
  if (!codes.length) return { value: raw, status: "valid" };
  // Some official fields use zero for both real zero and special codes; never erase it.
  if (raw === 0) return { value: 0, status: "ambiguous_zero_code" };
  return { value: null, status: codes.join("|") };
}
export async function mrmsProducts(a: Args): Promise<Page> {
  const path = mrmsPath(a.folder),
    doc = await getText("mrms", path);
  const rows = [];
  for (const link of listingLinks(String(doc.body))) {
    if (/^[A-Za-z0-9_-]+\/$/.test(link)) {
      const product_id = path + link.slice(0, -1),
        info = MRMS_FIELDS[link.slice(0, -1)];
      rows.push({
        product_id,
        kind: "directory",
        product_name: link.slice(0, -1),
        filename: null,
        level: null,
        file_time: null,
        unit: info?.unit ?? null,
        description: info?.description ?? null,
        notes: info?.notes ?? null,
        data_url: `https://mrms.ncep.noaa.gov/${product_id}/`,
        ...provenance(doc),
      });
    } else {
      const file = mrmsFile(link);
      if (!file) continue;
      const info = MRMS_FIELDS[file.name];
      rows.push({
        product_id: path.slice(0, -1),
        kind: "grib2",
        product_name: file.name,
        filename: file.filename,
        level: file.level,
        file_time: file.file_time,
        unit: info?.unit ?? null,
        description: info?.description ?? null,
        notes: info?.notes ?? null,
        data_url: `https://mrms.ncep.noaa.gov/${path}${link}`,
        ...provenance(doc),
      });
    }
  }
  return { rows };
}
export async function mrmsAt(a: Args): Promise<Page> {
  coords(a);
  const path = mrmsPath(a.product_id),
    level = Number(a.level);
  if (!Number.isFinite(level) || level < -1 || (level < 0 && level !== -1))
    throw new Error("level must be -1 or a nonnegative native file level");
  if (typeof a.file_time !== "string") throw new Error("file_time must be an RFC3339 timestamp or empty");
  const at = a.file_time ? gisTime(a.file_time) : null,
    listing = await getText("mrms", path);
  const files = listingLinks(String(listing.body))
    .flatMap((s) => {
      const f = mrmsFile(s);
      return f ? [f] : [];
    })
    .filter((f) => (level === -1 || Math.abs(f.level - level) < 1e-8) && (at === null || f.file_time === at))
    .sort((a, b) => b.file_time - a.file_time || a.level - b.level || a.filename.localeCompare(b.filename));
  const selected = files[0];
  if (!selected) throw new Error("No matching MRMS GRIB file; inspect mrms_products for available levels and times");
  const doc = await getBytes("mrms", path + selected.filename);
  if (!(doc.body instanceof Uint8Array)) throw new Error("Expected binary MRMS file");
  const sample = await gribSample(doc.body, Number(a.latitude), Number(a.longitude));
  if (!sample) return { rows: [] };
  const field = fieldFor(selected.name, sample.discipline, sample.category, sample.parameter),
    normalized = mrmsValue(sample.raw_value, field);
  return {
    rows: [
      {
        product_id: path.slice(0, -1),
        product_name: selected.name,
        filename: selected.filename,
        file_level: selected.level,
        file_time: selected.file_time,
        latitude: Number(a.latitude),
        longitude: Number(a.longitude),
        ...sample,
        value: normalized.value,
        value_status: normalized.status,
        unit: field?.unit ?? null,
        description: field?.description ?? null,
        parameter_notes: field?.notes ?? null,
        missing_code: field?.missing ?? null,
        no_coverage_code: field?.no_coverage ?? null,
        range_folded_code: field?.folded ?? null,
        parameter_table_url: MRMS_FIELDS_SOURCE,
        ...provenance(doc),
      },
    ],
  };
}
export const MRMS_FUNCTIONS = [
  ...readerWithOptions({
    name: "mrms_products",
    category: "reference",
    description:
      "Discover native public MRMS GRIB2 directories and currently retained files, including physical radar reflectivity, precipitation rate and accumulations, multi-sensor QPE, hail, rotation, lightning, quality fields, environmental fields and 3D radar levels. Start at 2D, 3DRefl, 3DRhoHV or 3DZdr; follow directory product_ids through regional and product folders. File rows expose native levels and filename UTC times. Units/descriptions come from NOAA NSSL's published v12.2 parameter table; unknown products retain NULL metadata. Use mrms_at for an actual decoded point sample. Directory availability varies by region and is not a historical archive.",
    options: {
      folder: {
        default: "2D",
        doc: "Directory returned by discovery, or a top-level MRMS grid directory. Example: 2D/ALASKA or 2D/PrecipRate.",
      },
    },
    columns: [
      ["product_id", "text", "Directory path for further discovery or mrms_at."],
      ["kind", "text", "directory or grib2."],
      ["product_name", "text", "Native directory/product name."],
      ["filename", "text", "Published compressed GRIB2 filename for a file row."],
      ["level", "number", "Native level encoded in the filename; interpretation depends on product."],
      ["file_time", "time", "UTC timestamp encoded in the filename, separate from decoded reference/validity times."],
      ["unit", "text", "Published parameter-table units when known."],
      ["description", "text", "Published parameter description."],
      ["notes", "text", "Source parameter notes, including regional availability."],
      ["data_url", "text", "Canonical official directory or data URL."],
    ],
    read: mrmsProducts,
    example:
      "SELECT product_id, unit, description FROM nws.main.mrms_products() WHERE kind = 'directory' ORDER BY product_id",
    exampleDescription: "Discover quantitative MRMS radar and precipitation products",
  }),
  ...readerWithOptions({
    name: "mrms_at",
    inputs: { product_id: "text", latitude: "number", longitude: "number" },
    inputDocs: {
      product_id: "Product directory returned by mrms_products, for example 2D/PrecipRate. NULL emits no rows.",
      latitude: "WGS84 latitude; NULL emits no rows.",
      longitude: "WGS84 longitude; NULL emits no rows.",
    },
    exampleInputs: ["'2D/PrecipRate'", "38.0293", "-78.4767"],
    description:
      "Download and decode a native MRMS GRIB2 grid to return the nearest grid-cell value, not a rendered color. Uses native ECMWF ecCodes for regular latitude/longitude GRIB2 grids and the packing codecs enabled in that build, including PNG. Requires grib_ls and grib_get on PATH or in NWS_ECCODES_BIN. Defaults to the latest retained file and lowest available native file level; specify file_time and level to reproduce a listed file. Returns physical units and distinct missing/no-coverage/range-folded codes from NOAA's parameter table, preserving raw_value. Zero remains numeric even when a source table uses ambiguous zero codes, which are labeled. Unknown parameter codes retain raw values and NULL units. Outside the grid emits no rows. Unsupported/corrupt encodings fail explicitly. Each call reads a complete source grid: compressed downloads are bounded to 32 MiB, GRIB messages to 64 MiB, and grids to 64 million points. Native decoding is serialized per worker process with a 30-second limit per ecCodes command. Shared HTTP caching reduces repeated downloads; use GIS QPE sampling for lightweight routine rainfall queries.",
    options: {
      level: {
        default: -1,
        doc: "Native filename level, or -1 to select the lowest available level at the chosen file time.",
      },
      file_time: {
        default: "",
        doc: "Exact RFC3339 filename time returned by mrms_products. Empty selects the newest retained file.",
      },
    },
    constraints: { level: { ge: -1 } },
    columns: [
      ["product_id", "text", "Selected source directory."],
      ["product_name", "text", "Native GRIB file product name."],
      ["filename", "text", "Exact source filename."],
      ["file_level", "number", "Native filename level."],
      ["file_time", "time", "Filename timestamp."],
      ["latitude", "number", "Requested WGS84 latitude."],
      ["longitude", "number", "Requested WGS84 longitude."],
      ["grid_latitude", "number", "Latitude of the sampled native grid cell."],
      ["grid_longitude", "number", "Longitude of the sampled grid cell, normalized to -180..180."],
      ["raw_value", "number", "Decoded value before interpreting product-specific missing codes."],
      [
        "value",
        "number",
        "Decoded value in native units, or NULL for recognized nonzero special codes/bitmap missing.",
      ],
      [
        "value_status",
        "text",
        "valid, bitmap_missing, missing, no_coverage, folded, ambiguous_zero_code, or unclassified_parameter; combined codes use a pipe.",
      ],
      ["unit", "text", "Native published parameter-table units, NULL if unclassified."],
      ["description", "text", "Source parameter meaning."],
      ["parameter_notes", "text", "Published notes and regional qualifications."],
      ["reference_at", "time", "GRIB identification reference time in UTC."],
      [
        "valid_at",
        "time",
        "GRIB reference plus ecCodes endStep, or the explicit statistical interval end, retaining seconds.",
      ],
      ["discipline", "number", "GRIB discipline code."],
      ["category", "number", "GRIB parameter category code."],
      ["parameter", "number", "GRIB parameter number."],
      ["grid_width", "number", "Native grid columns."],
      ["grid_height", "number", "Native grid rows."],
      [
        "packing_template",
        "number",
        "Native GRIB data representation template number, for example 0 simple or 41 PNG.",
      ],
      ["bitmap_missing", "bool", "Whether an explicit GRIB bitmap marks this point missing."],
      ["level_type", "number", "GRIB first fixed surface type code."],
      ["level_value", "number", "Scaled first fixed surface value in units defined by its type code."],
      ["missing_code", "number", "Published missing value code, if known."],
      ["no_coverage_code", "number", "Published no-coverage code, if known."],
      ["range_folded_code", "number", "Published range-folded code, if known."],
      ["parameter_table_url", "text", "NOAA NSSL parameter table used to interpret the GRIB code."],
    ],
    read: mrmsAt,
    example:
      "SELECT valid_at, value, unit, value_status, grid_latitude, grid_longitude FROM nws.main.mrms_at('2D/PrecipRate',38.0293,-78.4767) ORDER BY valid_at",
    exampleDescription: "Read actual radar precipitation rate at Charlottesville from native GRIB2",
  }),
];
