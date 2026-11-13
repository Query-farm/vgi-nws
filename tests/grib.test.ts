import { afterAll, beforeAll, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { gribSample } from "../src/grib.ts";
import { mrmsAt, mrmsFile, mrmsPath, mrmsProducts, mrmsValue } from "../src/mrms.ts";
import { MRMS_FIELDS } from "../src/mrms_fields.ts";

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(`test/fixtures/grib/${name}.grib2`).arrayBuffer());
let mock: ReturnType<typeof Bun.spawn>;
let saved: string | undefined;
beforeAll(async () => {
  saved = process.env.NWS_MRMS_BASE_URL;
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture failed to start");
  process.env.NWS_MRMS_BASE_URL = `http://127.0.0.1:${port}/mrms`;
});
afterAll(() => {
  mock?.kill();
  if (saved === undefined) delete process.env.NWS_MRMS_BASE_URL;
  else process.env.NWS_MRMS_BASE_URL = saved;
});

test("native ecCodes decodes PNG/gzip, nearest cell, parameter codes, levels and seconds", async () => {
  const sample = await gribSample(gzipSync(await fixture("png")), 38.0293, -78.4767);
  expect(sample).toMatchObject({
    raw_value: 1.25,
    grid_latitude: 38,
    grid_longitude: -78.5,
    discipline: 209,
    category: 6,
    parameter: 1,
    packing_template: 41,
    grid_width: 32,
    grid_height: 32,
    bitmap_missing: false,
    reference_at: Date.parse("2026-01-02T12:00:30Z"),
    valid_at: Date.parse("2026-01-02T12:00:30Z"),
    level_value: null,
  });
});
test("bitmap missing and a genuine 9999 remain distinct; native precision is preserved", async () => {
  const bytes = await fixture("bitmap");
  expect(await gribSample(bytes, 38, -78.5)).toMatchObject({ raw_value: null, bitmap_missing: true });
  expect(await gribSample(bytes, 38, -78.6)).toMatchObject({ raw_value: 9999, bitmap_missing: false });
  expect(await gribSample(bytes, 38, -79)).toMatchObject({ raw_value: 0, bitmap_missing: false });
  const precise = (await gribSample(await fixture("precision"), 38, -78))?.raw_value;
  expect(precise).not.toBeNull();
  expect(Math.abs(Number(precise) - 1.23456789)).toBeLessThan(2e-7);
  expect(precise).not.toBe(1.23457);
});
test("ecCodes forecast leads and explicit interval ends preserve sub-minute times", async () => {
  expect((await gribSample(await fixture("forecast"), 38, -78))?.valid_at).toBe(Date.parse("2026-01-02T12:02:00Z"));
  expect((await gribSample(await fixture("interval"), 38, -78))?.valid_at).toBe(Date.parse("2026-01-02T15:00:45Z"));
});
test("outside grids, dateline crossing and invalid envelopes cannot produce misleading samples", async () => {
  const bytes = await fixture("png");
  expect(await gribSample(bytes, 0, 0)).toBeNull();
  expect(await gribSample(await fixture("dateline"), 38, -179)).toMatchObject({ grid_longitude: -179, raw_value: 2.5 });
  expect(await gribSample(await fixture("dateline"), 38, 0)).toBeNull();
  for (const invalid of [bytes.slice(0, -1), Buffer.concat([bytes, bytes]), new Uint8Array(24)])
    await expect(gribSample(invalid, 38, -78)).rejects.toThrow("one complete GRIB2");
  await expect(gribSample(bytes, NaN, 0)).rejects.toThrow("coordinates");
  await expect(gribSample(gzipSync(Buffer.alloc(65 * 1024 * 1024)), 38, -78)).rejects.toThrow();
});
test("missing ecCodes gives installation guidance and does not poison later calls", async () => {
  const old = process.env.NWS_ECCODES_BIN;
  try {
    process.env.NWS_ECCODES_BIN = "/nonexistent-vgi-nws-eccodes";
    await expect(gribSample(await fixture("png"), 38, -78)).rejects.toThrow("Install ecCodes with PNG support");
  } finally {
    if (old === undefined) delete process.env.NWS_ECCODES_BIN;
    else process.env.NWS_ECCODES_BIN = old;
  }
  expect((await gribSample(await fixture("png"), 38, -78))?.raw_value).toBe(2.5);
});
test("MRMS discovery, file selection, units, special codes and provenance", async () => {
  expect((await mrmsProducts({ folder: "2D" })).rows).toHaveLength(1);
  expect((await mrmsProducts({ folder: "2D/PrecipRate" })).rows).toHaveLength(3);
  const args = { product_id: "2D/PrecipRate", latitude: 38, longitude: -78, level: -1, file_time: "" };
  expect((await mrmsAt(args)).rows[0]).toMatchObject({
    value: 2.5,
    unit: "mm/hr",
    file_level: 0,
    value_status: "valid",
    filename: "MRMS_PrecipRate_00.00_20260102-120030.grib2.gz",
    source_url: "https://mrms.ncep.noaa.gov/2D/PrecipRate/MRMS_PrecipRate_00.00_20260102-120030.grib2.gz",
  });
  for (const [longitude, status, raw] of [
    [-79, "valid", 0],
    [-78.9, "missing", -1],
    [-78.8, "no_coverage", -3],
  ] as const)
    expect((await mrmsAt({ ...args, longitude })).rows[0]).toMatchObject({
      value_status: status,
      raw_value: raw,
      value: raw === 0 ? 0 : null,
    });
  expect((await mrmsAt({ ...args, level: 1, longitude: -78.5 })).rows[0]).toMatchObject({
    value: null,
    value_status: "bitmap_missing",
    file_level: 1,
  });
  expect((await mrmsAt({ ...args, file_time: "2026-01-02T11:00:30Z" })).rows[0]?.filename).toContain("110030");
  await expect(mrmsAt({ ...args, level: 99 })).rejects.toThrow("No matching");
  const field = MRMS_FIELDS.PrecipRate;
  if (!field) throw new Error("Missing fixture parameter");
  expect(mrmsValue(0, { ...field, missing: 0 })).toEqual({ value: 0, status: "ambiguous_zero_code" });
  expect(mrmsValue(3, null)).toEqual({ value: 3, status: "unclassified_parameter" });
  for (const path of ["https://evil.invalid/", "2D/../secrets", "2D/x?bad"]) expect(() => mrmsPath(path)).toThrow();
  expect(mrmsFile("not-a-grib-file")).toBeNull();
});
