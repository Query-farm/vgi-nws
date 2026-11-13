import { afterAll, beforeAll, expect, test } from "bun:test";
import { gisFailure } from "../src/http.ts";
import { ANOMALY_PERIODS, precipitationAnomaly, saturationPercent, snowAnalysis, soilMoisture } from "../src/land.ts";
import { rasterValue } from "../src/raster.ts";
import type { Args, Row } from "../src/reader.ts";
import { reportMagnitude, stormReports } from "../src/storm_reports.ts";

let mock: ReturnType<typeof Bun.spawn>;
const saved: Record<string, string | undefined> = {};
const roots = ["NWS_RASTER_BASE_URL", "NWS_GIS_BASE_URL"];
beforeAll(async () => {
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture failed to start");
  for (const key of roots) {
    saved[key] = process.env[key];
    process.env[key] = `http://127.0.0.1:${port}`;
  }
});
afterAll(() => {
  mock?.kill();
  for (const key of roots) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
test("raw pixels retain negative departures and distinguish zero, NoData and malformed values", () => {
  expect(rasterValue("-1.25")).toBe(-1.25);
  expect(rasterValue("0")).toBe(0);
  expect(rasterValue("1.5e2")).toBe(150);
  expect(rasterValue("NoData")).toBeNull();
  for (const bad of ["", " ", "0x10", "12 inches", "NaN", Infinity, true]) expect(() => rasterValue(bad)).toThrow();
  expect(saturationPercent(0)).toBe(0);
  expect(saturationPercent(1)).toBe(100);
  expect(saturationPercent(null)).toBeNull();
  for (const bad of [-0.1, 1.01, Infinity, "0.5"]) expect(() => saturationPercent(bad)).toThrow();
});
test("GIS body errors preserve messages and only retry server/rate-limit codes", () => {
  expect(gisFailure({ status: "error", messages: ["Could not access server"] })).toEqual({
    message: "NWS GIS error: Could not access server",
    retryable: true,
  });
  expect(gisFailure({ error: { code: 498, message: "Invalid token" } })?.retryable).toBe(false);
  expect(gisFailure({ error: { code: 503, message: "Unavailable" } })?.retryable).toBe(true);
  expect(gisFailure({ results: [] })).toBeNull();
});
test("a transient HTTP 200 raster failure is retried without caching the failed body", async () => {
  const { rows } = await soilMoisture({ latitude: 46, longitude: -78, region: "conus" });
  expect(rows[0]?.saturation_pct).toBe(62.5);
  await expect(soilMoisture({ latitude: 45, longitude: -78, region: "conus" })).rejects.toThrow(
    "Could not access server",
  );
});
test("soil auto resolves regional footprints and converts native fractions, never class codes", async () => {
  const sites = [
    [38, -78, "conus", 62.5],
    [60, -150, "alaska", 80],
    [20, -156, "hawaii", 75],
    [18, -66, "puerto_rico", 90],
  ];
  for (const [latitude, longitude, region, expected] of sites) {
    const page = await soilMoisture({ latitude: Number(latitude), longitude: Number(longitude), region: "auto" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.region).toBe(region);
    expect(page.rows[0]?.saturation_pct).toBe(expected);
    expect(page.rows[0]?.soil_depth_cm).toBe(40);
  }
  expect((await soilMoisture({ latitude: 38, longitude: -78, region: "hawaii" })).rows).toEqual([]);
  expect((await soilMoisture({ latitude: 0, longitude: 0, region: "auto" })).rows).toEqual([]);
});
test("raster NoData inside a footprint retains provenance, zero stays numeric, errors stay errors", async () => {
  const args = { latitude: 40, longitude: -78, region: "conus" };
  const row = (await soilMoisture(args)).rows[0];
  expect(row?.saturation_pct).toBeNull();
  expect(row?.raster_id).toBe(7010);
  expect(row?.valid_at).toBe(Date.parse("2026-01-02T12:00:00Z"));
  expect((await soilMoisture({ ...args, latitude: 41 })).rows[0]?.saturation_pct).toBe(0);
  for (const latitude of [42, 43, 44, 45]) await expect(soilMoisture({ ...args, latitude })).rejects.toThrow();
});
test("all precipitation comparisons resolve every published period without clamping deficits", async () => {
  for (const period of Object.keys(ANOMALY_PERIODS)) {
    const { rows } = await precipitationAnomaly({ latitude: 38, longitude: -78, period, metric: "all" });
    expect(rows.map((r) => [r.metric, r.value, r.unit])).toEqual([
      ["normal", 2, "inches"],
      ["departure", -1.25, "inches"],
      ["percent_of_normal", 37.5, "percent"],
    ]);
    expect(rows.every((r) => r.valid_at === null && r.issued_at !== null)).toBe(true);
  }
});
test("snow depth and water equivalent have separate units, conversions and valid times", async () => {
  const { rows } = await snowAnalysis({ latitude: 38, longitude: -105, variable: "both" });
  expect(rows.map((r) => [r.variable, r.raw_value, r.raw_unit, r.value_mm])).toEqual([
    ["depth", 0.25, "m", 250],
    ["water_equivalent", 45, "kg m-2", 45],
  ]);
  expect(Number(rows[1]?.valid_at) - Number(rows[0]?.valid_at)).toBe(3600000);
});
test("storm magnitudes retain qualified text rather than guessing numeric values", () => {
  expect(reportMagnitude(" 1.25 ")).toBe(1.25);
  expect(reportMagnitude("0")).toBe(0);
  for (const value of ["E60", "Trace", "", "1 inch", null]) expect(reportMagnitude(value)).toBeNull();
});
const reportArgs: Args = { lookback_hours: 24, state: "", event: "", page_size: 1, include_geometry: false, bbox: "" };
async function reports(options: Args = {}, nearby = false): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > 20) throw new Error("Fixture paging did not terminate");
    const page = await stormReports({ ...reportArgs, ...options }, cursor, nearby);
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  return rows;
}
test("storm paging survives filtered empty pages and preserves distinct reports of the same event", async () => {
  const rows = await reports({ state: "VA", event: "hAiL" });
  expect(rows.map((r) => r.object_id)).toEqual([1, 3, 8]);
  expect(rows.every((r) => r.geometry_json === null && r.distance_km === null)).toBe(true);
  expect((await reports({ event: "not an event" })).length).toBe(0);
  expect((await reports({ lookback_hours: 72 })).length).toBe(8);
});
test("storm radius removes bounding-box corners and covers dateline and poles", async () => {
  const nearby = { latitude: 38, longitude: -78, radius_km: 50 };
  expect((await reports(nearby, true)).map((r) => r.object_id)).toEqual([1, 2, 6, 8]);
  expect((await reports({ latitude: 10, longitude: 180, radius_km: 50 }, true)).map((r) => r.object_id)).toEqual([
    4, 5,
  ]);
  expect((await reports({ latitude: 90, longitude: 0, radius_km: 50 }, true)).map((r) => r.object_id)).toEqual([7]);
  expect((await reports({ ...nearby, include_geometry: true }, true)).every((r) => r.geometry_json !== null)).toBe(
    true,
  );
  await expect(reports({ state: "ZZ" })).rejects.toThrow();
  await expect(reports({ ...nearby, radius_km: 0 }, true)).rejects.toThrow();
});
