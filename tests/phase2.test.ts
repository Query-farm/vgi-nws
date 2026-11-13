import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkedBody, gisPage, gisTime } from "../src/gis.ts";
import { resolveUrl } from "../src/http.ts";
import { type Args, num, type ObjectData } from "../src/reader.ts";
import { distanceKm, owns, parseBounds, radiusBounds, tiles } from "../src/spatial.ts";
import { statusTime } from "../src/water_discovery.ts";

let mock: ReturnType<typeof Bun.spawn>;
let saved: string | undefined;
beforeAll(async () => {
  saved = process.env.NWS_GIS_BASE_URL;
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture failed to start");
  process.env.NWS_GIS_BASE_URL = `http://127.0.0.1:${port}`;
});
afterAll(() => {
  mock?.kill();
  if (saved === undefined) delete process.env.NWS_GIS_BASE_URL;
  else process.env.NWS_GIS_BASE_URL = saved;
});
test("GIS date formats explicitly use UTC and preserve date-only precision", () => {
  const noon = Date.parse("2026-01-02T12:00:00Z");
  for (const input of [noon, "202601021200", "2026-01-02 12:00:00", "2026-01-02T07:00:00-05:00"])
    expect(gisTime(input)).toBe(noon);
  expect(gisTime("01/02/2026")).toBe(Date.parse("2026-01-02T00:00:00Z"));
  expect(gisTime(null)).toBeNull();
  for (const input of ["March 31", "bad", {}, Number.NaN]) expect(() => gisTime(input)).toThrow();
  expect(statusTime("0001-01-01T00:00:00Z")).toBeNull();
});
test("bounding boxes validate and split at the dateline", () => {
  expect(parseBounds("170,-10,-170,10")).toEqual([
    [170, -10, 180, 10],
    [-180, -10, -170, 10],
  ]);
  expect(parseBounds("-180,-90,180,90")).toEqual([[-180, -90, 180, 90]]);
  for (const input of ["", "1,2,3", "1,,3,4", "1,5,3,4", "181,1,3,4", "1,2,1,3", "1,2,NaN,3"])
    expect(() => parseBounds(input)).toThrow();
});
test("radius bounds cover dateline and polar circles; distances filter corners", () => {
  expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.195, 3);
  expect(distanceKm(10, 179.9, 10, -179.9)).toBeLessThan(23);
  expect(radiusBounds({ latitude: 10, longitude: 179.9, radius_km: 50 }).length).toBe(2);
  expect(radiusBounds({ latitude: 89.9, longitude: 0, radius_km: 50 })[0]?.[0]).toBe(-180);
  expect(distanceKm(37.5407, -77.436, 37.96, -76.94)).toBeGreaterThan(50);
  expect(() => radiusBounds({ latitude: 0, longitude: 0, radius_km: 501 })).toThrow();
});
test("adjacent tile edges have exactly one owner including outer edges", () => {
  const grid = tiles([[-125, 24, -66, 50]]);
  for (const [lat, lon] of [
    [40, -85],
    [44, -105],
    [50, -66],
    [24, -125],
  ])
    expect(grid.filter((tile) => owns(tile, lat ?? 0, lon ?? 0)).length).toBe(1);
});
test("GIS uses a dedicated trusted root and surfaces JSON errors", () => {
  expect(resolveUrl("gis", "outlooks/a/MapServer").source).toBe(
    "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/a/MapServer",
  );
  expect(() => resolveUrl("gis", "https://mapservices.weather.noaa.gov/other")).toThrow();
  expect(() => checkedBody({ error: { code: 498, message: "Denied" } })).toThrow("GIS error 498: Denied");
});
const layer = { service: "outlooks/SPC_wx_outlks/MapServer", name: "Day 1 Categorical Outlook" };
const defaults: Args = { page_size: 1, include_geometry: true, bbox: "" };
const map = (p: ObjectData) => ({ code: num(p.dn) });
test("GIS streams every page using resolved layer IDs and server limits", async () => {
  let cursor: string | undefined;
  const ids: unknown[] = [];
  do {
    const result = await gisPage(layer, defaults, cursor, map, false);
    ids.push(...result.rows.map((r) => r.object_id));
    cursor = result.next;
  } while (cursor);
  expect(ids).toEqual([1, 2, 3]);
  const capped = await gisPage(layer, { ...defaults, page_size: 500 }, undefined, map, false);
  expect(capped.rows.length).toBe(2);
  expect(capped.next).toBeDefined();
});
test("point and bbox queries are server-side intersections, not local approximations", async () => {
  const point = await gisPage(
    layer,
    { ...defaults, latitude: 38, longitude: -78, page_size: 100 },
    undefined,
    map,
    true,
  );
  expect(point.rows.map((r) => r.object_id)).toEqual([1, 2]);
  expect(point.rows[0]?.geometry_json).toContain("MultiPolygon");
  const empty = await gisPage(layer, { ...defaults, latitude: 0, longitude: 0 }, undefined, map, true);
  expect(empty.rows).toEqual([]);
  expect(empty.next).toBeUndefined();
  const bounds = await gisPage(layer, { ...defaults, bbox: "-80,36,-79.5,36.5" }, undefined, map, false);
  expect(bounds.rows.map((r) => r.object_id)).toEqual([1]);
});
test("dateline polygons are deduplicated across the two bounding-box queries", async () => {
  let cursor: string | undefined;
  const ids: unknown[] = [];
  do {
    const r = await gisPage(layer, { ...defaults, bbox: "179,9,-179,11" }, cursor, map, false);
    ids.push(...r.rows.map((v) => v.object_id));
    cursor = r.next;
  } while (cursor);
  expect(ids).toEqual([3]);
});
test("truncation, repeated pages and publication changes fail instead of losing rows", async () => {
  await expect(gisPage(layer, { ...defaults, bbox: "10,10,11,11" }, undefined, map, false)).rejects.toThrow(
    "GIS error 498",
  );
  await expect(gisPage(layer, { ...defaults, bbox: "30,10,31,11" }, undefined, map, false)).rejects.toThrow(
    "empty truncated",
  );
  for (const [bbox, message] of [
    ["20,10,21,11", "did not advance"],
    ["40,10,41,11", "publication changed"],
  ]) {
    const args = { ...defaults, bbox: bbox || "" };
    const first = await gisPage(layer, args, undefined, map, false);
    await expect(gisPage(layer, args, first.next, map, false)).rejects.toThrow(message);
  }
  await expect(gisPage({ ...layer, name: "Gone" }, defaults, undefined, map, false)).rejects.toThrow(
    "layer unavailable",
  );
});
