import { afterAll, beforeAll, expect, test } from "bun:test";
import { AIR_PRODUCTS, airQuality } from "../src/air_quality.ts";
import { flashFloodGuidance, longRangeFlood, probabilityRange, wpcHour } from "../src/hazards_extended.ts";
import { imagePage, intersectsTime, pixelBands } from "../src/image_service.ts";
import { mapFeatures, mapFields, mapLayers, mapProduct, mapProducts } from "../src/map_catalog.ts";
import type { Args, Page, Row } from "../src/reader.ts";

let mock: ReturnType<typeof Bun.spawn>;
const saved: Record<string, string | undefined> = {};
const roots = {
  NWS_GIS_BASE_URL: "gis",
  NWS_RASTER_BASE_URL: "raster",
  NWS_TROPICAL_BASE_URL: "tropical",
  NWS_EVENT_BASE_URL: "event",
};
beforeAll(async () => {
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture failed to start");
  for (const [key, prefix] of Object.entries(roots)) {
    saved[key] = process.env[key];
    process.env[key] = `http://127.0.0.1:${port}/${prefix}`;
  }
});
afterAll(() => {
  mock?.kill();
  for (const key of Object.keys(roots)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
async function collect(read: (cursor?: string) => Promise<Page>): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > 100) throw new Error("Nonterminating fixture");
    const page = await read(cursor);
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  return rows;
}
const imageArgs: Args = {
  product_id: "raster:air_quality/ndgd_apm25_hr01/ImageServer",
  latitude: 38,
  longitude: -78,
  start_time: "",
  end_time: "",
  subset: "",
  page_size: 20,
};
test("GIS discovery keeps trusted product IDs and omits duplicate alternative views by default", async () => {
  for (const invalid of [
    "https://example.com/MapServer",
    "vector:../private/MapServer",
    "raster:obs/x/ImageServer?url=x",
    "tropical:Utilities/x/MapServer",
  ])
    expect(() => mapProduct(invalid)).toThrow();
  const rows = await collect((c) => mapProducts({ server: "all", folder: "", include_alternates: false }, c));
  expect(new Set(rows.map((r) => r.server)).size).toBe(4);
  expect(rows.some((r) => r.service_type === "FeatureServer")).toBe(false);
  const alternate = await collect((c) =>
    mapProducts({ server: "vector", folder: "outlooks", include_alternates: true }, c),
  );
  expect(alternate.some((r) => r.service_type === "FeatureServer")).toBe(true);
});
test("layer and field discovery supports native IDs and field names", async () => {
  const product_id = "tropical:tropical/NHC_tropical_weather_summary/MapServer";
  expect((await mapLayers({ product_id })).rows[0]?.layer_id).toBe(99);
  expect(
    (await mapFields({ product_id, layer_id: 99 })).rows.find((r) => r.field_type === "esriFieldTypeOID")?.field_name,
  ).toBe("OBJECTID");
  const rows = await collect((c) =>
    mapFeatures({ product_id, layer_id: 99, page_size: 1, bbox: "", include_geometry: true }, c, false),
  );
  expect(rows.map((r) => r.object_id)).toEqual([1, 2, 3]);
  expect(new Set(rows.map((r) => r.source_file_at)).size).toBe(3);
});
test("image sampling enumerates more than the mosaic limit, preserves NULL/zero and source times", async () => {
  const rows = await collect((c) => imagePage(imageArgs, c));
  expect(rows).toHaveLength(23);
  expect(new Set(rows.map((r) => r.raster_id)).size).toBe(23);
  expect(rows[1]?.raw_value).toBeNull();
  expect(rows[2]?.raw_value).toBe(0);
  expect(rows[0]?.issued_at).toBe(Date.parse("2026-01-02T11:00:00Z"));
  expect(rows[22]?.valid_from).toBe(Date.parse("2026-01-03T10:00:00Z"));
  expect((await imagePage({ ...imageArgs, longitude: 78 })).rows).toEqual([]);
});
test("image time windows filter overlapping intervals with an exclusive end", async () => {
  const rows = await collect((c) =>
    imagePage({ ...imageArgs, start_time: "2026-01-02T13:00:00Z", end_time: "2026-01-02T15:00:00Z", page_size: 1 }, c),
  );
  expect(rows.map((r) => r.raster_id)).toEqual([102, 103]);
  expect(intersectsTime(10, 10, 10, 20)).toBe(true);
  expect(intersectsTime(20, 20, 10, 20)).toBe(false);
  expect(() => intersectsTime(20, 10, 0, 30)).toThrow();
});
test("image sampling fails on missing, duplicate, changed or truncated data", async () => {
  for (const latitude of [42, 43, 44, 46]) await expect(imagePage({ ...imageArgs, latitude })).rejects.toThrow();
  await expect(imagePage({ ...imageArgs, start_time: "2026-02-30T00:00:00Z" })).rejects.toThrow();
  await expect(imagePage({ ...imageArgs, page_size: 1.5 })).rejects.toThrow();
  expect((await imagePage({ ...imageArgs, subset: "x' OR 1=1 --" })).rows).toEqual([]);
});
test("multiband imagery is preserved as separate bands, not interpreted as reflectivity", async () => {
  expect(pixelBands("7 13 29 255", 4)).toEqual([7, 13, 29, 255]);
  expect(pixelBands("NoData", 4)).toEqual([null, null, null, null]);
  expect(() => pixelBands("1 2", 1)).toThrow();
  const page = await imagePage({
    ...imageArgs,
    product_id: "eventdriven:radar/radar_base_reflectivity_time/ImageServer",
    page_size: 1,
  });
  expect(page.rows.map((r) => [r.band_index, r.raw_value])).toEqual([
    [1, 7],
    [2, 13],
    [3, 29],
    [4, 255],
  ]);
});
test("every air-quality variant uses its real service and preserves uncertain units", async () => {
  for (const [product, variant] of Object.entries(AIR_PRODUCTS)) {
    for (const bias_corrected of variant.correction ? [false, true] : [false]) {
      const page = await airQuality({ ...imageArgs, product, bias_corrected, page_size: 1 });
      expect(page.rows[0]?.unit).toBe(variant.unit);
      expect(page.rows[0]?.value).toBe(12.5);
    }
  }
  await expect(airQuality({ ...imageArgs, product: "smoke_surface", bias_corrected: true })).rejects.toThrow();
});
test("flash flood guidance converts native mass/area to water depth and rejects retired duration", async () => {
  for (const hours of [1, 3, 6, 12]) {
    const page = await flashFloodGuidance({ latitude: 38, longitude: -78, hours });
    expect(page.rows[0]?.threshold_mm).toBe(50.8);
    expect(page.rows[0]?.threshold_inches).toBe(2);
  }
  await expect(flashFloodGuidance({ latitude: 38, longitude: -78, hours: 24 })).rejects.toThrow();
});
test("winter validity and censored flood probabilities retain source precision", async () => {
  expect(wpcHour("12Z 2026/01/02")).toBe(Date.parse("2026-01-02T12:00:00Z"));
  expect(() => wpcHour("12Z 2026/02/30")).toThrow();
  expect(probabilityRange("< 0.05")).toEqual({ lower: 0, upper: 5, lowerInclusive: true, upperInclusive: false });
  expect(probabilityRange("> 0.95")).toEqual({ lower: 95, upper: 100, lowerInclusive: false, upperInclusive: true });
  expect(probabilityRange("0.25").lower).toBe(25);
  expect(probabilityRange("unknown").lower).toBeNull();
  const rows = await collect((c) =>
    longRangeFlood(
      { threshold_pct: 50, state: "VA", gauge_id: "rmdv2", bbox: "", page_size: 1, include_geometry: false },
      c,
    ),
  );
  expect(rows.map((r) => r.flood_category)).toEqual(["minor", "moderate", "major"]);
  expect(rows[0]?.probability_max_pct).toBe(5);
  expect(rows[0]?.max_inclusive).toBe(false);
});
