import { afterAll, beforeAll, expect, test } from "bun:test";
import { gisTime } from "../src/gis.ts";
import { resolveUrl } from "../src/http.ts";
import { observedPrecipitation, pixelValue, QPE_PERIODS } from "../src/precipitation.ts";
import { streamflowRows } from "../src/water_extended.ts";
import { winterBand, winterTime } from "../src/winter.ts";

let mock: ReturnType<typeof Bun.spawn>;
let saved: string | undefined;
beforeAll(async () => {
  saved = process.env.NWS_RASTER_BASE_URL;
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture failed to start");
  process.env.NWS_RASTER_BASE_URL = `http://127.0.0.1:${port}`;
});
afterAll(() => {
  mock?.kill();
  if (saved === undefined) delete process.env.NWS_RASTER_BASE_URL;
  else process.env.NWS_RASTER_BASE_URL = saved;
});
test("GIS dates reject impossible calendar dates instead of rolling into the next month", () => {
  for (const value of [
    "02/30/2026",
    "02/29/2025",
    "02/29/2100",
    "202602300000",
    "2026-04-31 1200Z",
    "2026-01-01T24:00:00Z",
  ])
    expect(() => gisTime(value)).toThrow();
  expect(gisTime("02/29/2024")).toBe(Date.parse("2024-02-29T00:00:00Z"));
  expect(gisTime("2026-01-02 1516Z")).toBe(Date.parse("2026-01-02T15:16:00Z"));
});
test("WSSI validity dates use the issue century and handle New Year", () => {
  expect(winterTime("00Z 01/01/26", gisTime("2025-12-31 2316Z"))).toBe(Date.parse("2026-01-01T00:00:00Z"));
  expect(winterTime("00Z 01/01/00", gisTime("2099-12-31 2316Z"))).toBe(Date.parse("2100-01-01T00:00:00Z"));
  expect(() => winterTime("00Z 01/01/26", null)).toThrow();
  expect(() => winterTime("00Z 02/30/26", gisTime("2026-02-28 1200Z"))).toThrow();
});
test("winter bands preserve published ranges without interpreting native IDs", () => {
  expect(winterBand("Slight (10-39%)")).toEqual([10, 39]);
  expect(winterBand("High (70-100%)")).toEqual([70, 100]);
  expect(winterBand("Unrecognized category")).toEqual([null, null]);
  expect(() => winterBand("Invalid (90-110%)")).toThrow();
});
test("raw precipitation pixels retain zero, missing data, and decimal precision", () => {
  expect(pixelValue("0")).toBe(0);
  expect(pixelValue("0.0246063")).toBe(0.0246063);
  expect(pixelValue("NoData")).toBeNull();
  expect(pixelValue(null)).toBeNull();
  for (const value of ["", "not a pixel", "-999", {}, Number.NaN]) expect(() => pixelValue(value)).toThrow();
  expect(resolveUrl("raster", "obs/rfc_qpe/MapServer").source).toContain("/raster/rest/services/");
  expect(() => resolveUrl("raster", "https://mapservices.weather.noaa.gov/vector/rest/services/x")).toThrow();
});
test("QPE resolves layer IDs, reads raw values rather than class 14, and joins source metadata", async () => {
  const r = await observedPrecipitation({ latitude: 38, longitude: -78, period: "hour24" });
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]?.precipitation).toBe(1.25);
  expect(r.rows[0]?.unit).toBe("inches");
  expect(r.rows[0]?.issued_at).toBe(Date.parse("2026-01-02T12:00:00Z"));
  expect(r.rows[0]?.source_file_at).toBe(Date.parse("2026-01-02T12:00:01Z"));
  expect(r.rows[0]?.source_url).toContain("layers=all%3A325");
  expect(r.rows[0]?.metadata_url).toContain("objectIds=700");
  for (const period of Object.keys(QPE_PERIODS)) {
    const result = await observedPrecipitation({ latitude: 38, longitude: -78, period });
    expect(result.rows[0]?.layer_name).toBe(`${QPE_PERIODS[period]} Observed (inches)`);
  }
});
test("QPE distinguishes no coverage from NoData and fails on errors and missing metadata", async () => {
  expect((await observedPrecipitation({ latitude: 0, longitude: 0, period: "hour24" })).rows).toEqual([]);
  expect(
    (await observedPrecipitation({ latitude: 40, longitude: -78, period: "hour24" })).rows[0]?.precipitation,
  ).toBeNull();
  expect((await observedPrecipitation({ latitude: 41, longitude: -78, period: "hour24" })).rows[0]?.precipitation).toBe(
    0,
  );
  for (const latitude of [10, 42, 43, 91])
    await expect(observedPrecipitation({ latitude, longitude: -78, period: "hour24" })).rejects.toThrow();
  await expect(observedPrecipitation({ latitude: 38, longitude: -78, period: "nonsense" })).rejects.toThrow();
});
test("model series retain member identity, reference times, missing values, and units", () => {
  const series = {
    referenceTime: "2026-01-02T12:00:00Z",
    units: "ft³/s",
    data: [
      { validTime: "2026-01-02T13:00:00Z", flow: 0 },
      { validTime: "2026-01-02T14:00:00Z", flow: null },
    ],
  };
  const rows = streamflowRows(
    { longRange: { mean: series, member1: series }, shortRange: { series } },
    "23021904",
    "long_range",
  );
  expect(rows).toHaveLength(4);
  expect(rows.map((r) => r.member)).toEqual(["mean", "mean", "member1", "member1"]);
  expect(rows.map((r) => r.flow)).toEqual([0, null, 0, null]);
  expect(rows[0]?.flow_unit).toBe("ft³/s");
  expect(rows[0]?.reference_at).toBe(Date.parse("2026-01-02T12:00:00Z"));
  expect(streamflowRows({ shortRange: {} }, "23021904", "short_range")).toEqual([]);
  expect(() => streamflowRows({ shortRange: { series: { data: "bad" } } }, "23021904", "short_range")).toThrow();
});
