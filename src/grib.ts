/** ecCodes owns GRIB parsing, packing codecs, bitmap decoding and nearest-cell selection. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { gisTime } from "./gis.ts";
import { obj } from "./reader.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_POINTS = 64_000_000;
const END_KEYS = ["year", "month", "day", "hour", "minute", "second"].map((k) => `${k}OfEndOfOverallTimeInterval`);
const KEYS = [
  "edition",
  "gridType",
  "numberOfPoints",
  "Ni",
  "Nj",
  "discipline",
  "parameterCategory",
  "parameterNumber",
  "dataDate",
  "dataTime",
  "second",
  "dataRepresentationTemplateNumber",
  "bitmapPresent",
  "typeOfFirstFixedSurface",
  "scaleFactorOfFirstFixedSurface",
  "scaledValueOfFirstFixedSurface",
  "latitudeOfFirstGridPointInDegrees",
  "latitudeOfLastGridPointInDegrees",
  "longitudeOfFirstGridPointInDegrees",
  "longitudeOfLastGridPointInDegrees",
  "iScansNegatively",
  ...END_KEYS,
];

export interface GribSample {
  discipline: number;
  category: number;
  parameter: number;
  reference_at: number;
  valid_at: number;
  grid_latitude: number;
  grid_longitude: number;
  raw_value: number | null;
  bitmap_missing: boolean;
  grid_width: number;
  grid_height: number;
  packing_template: number;
  level_type: number;
  level_value: number | null;
}

async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("ecCodes output exceeds 1 MiB");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

async function codes(tool: "grib_ls" | "grib_get", args: string[]): Promise<string> {
  const binary = process.env.NWS_ECCODES_BIN ? join(process.env.NWS_ECCODES_BIN, tool) : tool;
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    child = Bun.spawn([binary, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
  } catch (cause) {
    throw new Error(
      `Cannot start ecCodes ${tool}. Install ecCodes with PNG support and put its tools on PATH, or set NWS_ECCODES_BIN to their directory.`,
      { cause },
    );
  }
  try {
    const [stdout, stderr, code] = await Promise.all([
      boundedText(child.stdout),
      boundedText(child.stderr),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `ecCodes ${tool} failed (exit ${code}, signal ${child.signalCode ?? "none"}; 30s limit): ${stderr.trim().slice(0, 2000) || stdout.trim().slice(0, 2000)}. PNG-packed MRMS requires a PNG-enabled ecCodes build.`,
      );
    return stdout;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

function number(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`ecCodes returned invalid ${key}`);
  return value;
}
function optional(row: Record<string, unknown>, key: string): number | null {
  return typeof row[key] === "string" && /^(?:missing|not_found)$/i.test(row[key]) ? null : number(row, key);
}
function date(parts: number[]): number {
  const [year, month, day, hour, minute, second] = parts.map((n, i) => String(n).padStart(i ? 2 : 4, "0"));
  const result = gisTime(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (result === null) throw new Error("Invalid ecCodes timestamp");
  return result;
}
const circle = (x: number) => ((x % 360) + 360) % 360;

// Serialise large grid decodes within each worker process. Waiting calls do not inflate their input yet.
let queue = Promise.resolve();
export async function gribSample(input: Uint8Array, latitude: number, longitude: number): Promise<GribSample | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    throw new Error("Invalid sample coordinates");
  const previous = queue;
  let release = () => {};
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await decode(input, latitude, longitude);
  } finally {
    release();
  }
}

async function decode(input: Uint8Array, latitude: number, longitude: number): Promise<GribSample | null> {
  if (input.length > MAX_BYTES) throw new Error("GRIB input exceeds 64 MiB");
  const bytes = input[0] === 31 && input[1] === 139 ? gunzipSync(input, { maxOutputLength: MAX_BYTES }) : input;
  // Check only the outer envelope, so ecCodes cannot silently skip junk or concatenated messages.
  if (
    bytes.length < 20 ||
    bytes.length > MAX_BYTES ||
    Buffer.from(bytes.subarray(0, 4)).toString() !== "GRIB" ||
    bytes[7] !== 2 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(8) !== BigInt(bytes.length) ||
    Buffer.from(bytes.subarray(-4)).toString() !== "7777"
  )
    throw new Error("Expected exactly one complete GRIB2 message");
  const directory = await mkdtemp(join(tmpdir(), "vgi-nws-grib-"));
  try {
    const file = join(directory, "grid.grib2");
    await writeFile(file, bytes, { mode: 0o600 });
    // Read original interval timestamps before setting stepUnits, which ecCodes can rewrite.
    const metadata = obj(
      JSON.parse(
        await codes("grib_ls", [
          "-j",
          "-F",
          "%.17g",
          "-p",
          KEYS.map((k) => `${k}:${k === "gridType" ? "s" : "d"}`).join(","),
          file,
        ]),
      ),
    );
    if (!Array.isArray(metadata.messages) || metadata.messages.length !== 1)
      throw new Error("Expected one GRIB field; multi-field MRMS files are unsupported");
    const m = obj(metadata.messages[0]);
    if (number(m, "edition") !== 2 || m.gridType !== "regular_ll")
      throw new Error("MRMS sampling requires a regular latitude/longitude GRIB2 grid");
    const width = number(m, "Ni"),
      height = number(m, "Nj"),
      count = number(m, "numberOfPoints");
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 2 ||
      height < 2 ||
      width * height !== count ||
      count > MAX_POINTS
    )
      throw new Error("Invalid or oversized GRIB grid (64 million points maximum)");
    const lat0 = number(m, "latitudeOfFirstGridPointInDegrees"),
      lat1 = number(m, "latitudeOfLastGridPointInDegrees"),
      lon0 = number(m, "longitudeOfFirstGridPointInDegrees"),
      lon1 = number(m, "longitudeOfLastGridPointInDegrees"),
      direction = number(m, "iScansNegatively") ? -1 : 1;
    if (
      latitude < Math.min(lat0, lat1) ||
      latitude > Math.max(lat0, lat1) ||
      circle(direction * (longitude - lon0)) > circle(direction * (lon1 - lon0)) + 1e-8
    )
      return null;
    const nearest: unknown = JSON.parse(
      await codes("grib_ls", ["-j", "-l", `${latitude},${longitude},1`, "-p", "count:i", file]),
    );
    if (!Array.isArray(nearest) || nearest.length !== 1) throw new Error("Invalid ecCodes nearest-cell response");
    const neighbours = obj(nearest[0]).neighbours;
    if (!Array.isArray(neighbours) || neighbours.length !== 1) throw new Error("Missing ecCodes nearest cell");
    const cell = obj(neighbours[0]),
      index = number(cell, "index");
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Invalid ecCodes grid index");
    // grib_ls nearest JSON hardcodes %g. Re-read the selected index without six-digit rounding.
    // NaN is an in-memory bitmap sentinel, so a valid native 9999 is never mistaken for missing.
    const valueText = (
      await codes("grib_get", [
        "-F",
        "%.17g",
        "-s",
        "missingValue:d=nan,stepUnits=s",
        "-p",
        "bitmapPresent:i,endStep:d",
        "-i",
        String(index),
        file,
      ])
    )
      .trim()
      .split(/\s+/);
    if (valueText.length !== 3 || !/^[01]$/.test(valueText[0] ?? "")) throw new Error("Invalid ecCodes value response");
    const missing = /^[-+]?nan$/i.test(valueText[2] ?? "");
    const raw = missing ? null : Number(valueText[2]);
    if ((missing && valueText[0] !== "1") || (raw !== null && !Number.isFinite(raw)))
      throw new Error("Invalid decoded GRIB value");
    const day = number(m, "dataDate"),
      clock = number(m, "dataTime"),
      reference = date([
        Math.floor(day / 10000),
        Math.floor(day / 100) % 100,
        day % 100,
        Math.floor(clock / 100),
        clock % 100,
        number(m, "second"),
      ]),
      end = END_KEYS.map((k) => optional(m, k)),
      valid = end.every((v) => v !== null) ? date(end as number[]) : reference + Number(valueText[1]) * 1000,
      scale = optional(m, "scaleFactorOfFirstFixedSurface"),
      level = optional(m, "scaledValueOfFirstFixedSurface");
    if (end.some((v) => v !== null) && end.some((v) => v === null)) throw new Error("Incomplete GRIB interval end");
    if (!Number.isFinite(valid)) throw new Error("Invalid GRIB validity time");
    return {
      discipline: number(m, "discipline"),
      category: number(m, "parameterCategory"),
      parameter: number(m, "parameterNumber"),
      reference_at: reference,
      valid_at: valid,
      grid_latitude: number(cell, "latitude"),
      grid_longitude: circle(number(cell, "longitude") + 180) - 180,
      raw_value: raw,
      bitmap_missing: missing,
      grid_width: width,
      grid_height: height,
      packing_template: number(m, "dataRepresentationTemplateNumber"),
      level_type: number(m, "typeOfFirstFixedSurface"),
      level_value: scale === null || level === null ? null : level * 10 ** -scale,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
