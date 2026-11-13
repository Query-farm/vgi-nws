import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileCursor } from "../src/file_products.ts";
import { buoyLine, buoyMeasurements, stationRecords } from "../src/ndbc.ts";
import type { Page, Row } from "../src/reader.ts";
import { spacePath, spaceProducts, spaceRecords, spaceRows } from "../src/space_weather.ts";

let mock: ReturnType<typeof Bun.spawn>;
const saved: Record<string, string | undefined> = {};
const roots = { NWS_NDBC_BASE_URL: "ndbc", NWS_SWPC_BASE_URL: "swpc" };
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
  let count = 0;
  do {
    if (++count > 100) throw new Error("Nonterminating fixture");
    const page = await read(cursor);
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  return rows;
}
const buoy = { station_id: "44014", product: "txt", variable: "", start_time: "", end_time: "", page_size: 1 };
test("buoy lines preserve units, missing versus zero, categories, seconds and combined times", async () => {
  const rows = await collect((c) => buoyMeasurements(buoy, c));
  expect(rows.length).toBe(9);
  expect(rows.find((r) => r.value_text === "MM")).toMatchObject({ value: null, is_missing: true, unit: "m" });
  expect(rows.find((r) => r.value_text === "0")).toMatchObject({ value: 0, is_missing: false });
  expect(
    (await buoyMeasurements({ ...buoy, product: "spec" })).rows.find((r) => r.variable === "STEEPNESS"),
  ).toMatchObject({ value: null, value_text: "VERY_STEEP", is_missing: false });
  expect((await buoyMeasurements({ ...buoy, product: "dart" })).rows[0]?.observed_at).toBe(
    Date.parse("2026-01-02T12:00:30Z"),
  );
  expect((await buoyMeasurements({ ...buoy, product: "drift" })).rows[0]?.observed_at).toBe(
    Date.parse("2026-01-02T12:05:00Z"),
  );
  const selected = await collect((c) =>
    buoyMeasurements(
      { ...buoy, variable: "WVHT", start_time: "2026-01-02T11:00:00Z", end_time: "2026-01-02T12:00:00Z" },
      c,
    ),
  );
  expect(selected.length).toBe(1);
  expect(selected[0]?.value).toBeNull();
  await expect(buoyMeasurements({ ...buoy, start_time: "2026-02-30T00:00:00Z" })).rejects.toThrow();
});
test("all NDBC products parse, spectral bins retain missing codes and variable ADCP bin counts", async () => {
  for (const product of [
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
  ])
    expect((await buoyMeasurements({ ...buoy, product })).rows.length).toBeGreaterThan(0);
  const spectral = (await buoyMeasurements({ ...buoy, product: "data_spec" })).rows;
  expect(spectral.length).toBe(4);
  expect(spectral[0]).toMatchObject({ variable: "Sep_Freq", value: null, unit: "Hz" });
  expect(spectral[1]).toMatchObject({ value: 0, frequency_hz: 0.033, unit: "m2 Hz-1" });
  expect(spectral[2]).toMatchObject({ value: null, value_text: "999.0" });
  const adcp = buoyLine(
    "2026 01 02 12 00 1 90 0 2 180 MM",
    "YY MM DD hh mm DEP01 DIR01 SPD01".split(" "),
    "yr mo dy hr mn m degT cm/s".split(" "),
    "adcp",
  );
  expect(adcp.length).toBe(6);
  expect(adcp[5]).toMatchObject({ variable: "SPD02", value: null, unit: "cm/s" });
  expect((await buoyMeasurements({ ...buoy, product: "cwind" })).rows.filter((r) => r.is_missing).length).toBe(3);
  expect(() => buoyLine("2026 01 02 12 00 1 bad", "YY MM DD hh mm values".split(" "), null, "swdir")).toThrow();
});
test("station XML decodes entities without processing external references", () => {
  expect(
    stationRecords('<stations><station id="44014" lat="36" lon="-74" name="A &amp; B" /></stations>')[0],
  ).toMatchObject({ name: "A & B", elevation_m: null });
  expect(() => stationRecords("<html>failure</html>")).toThrow();
  expect(() => stationRecords('<stations><station id="x" lat="bad" lon="0" /></stations>')).toThrow();
});
test("file paging fails if publication changes or cursor is malformed", () => {
  const cursor = fileCursor("first", undefined, 3, 1).token(1);
  expect(fileCursor("first", cursor, 3, 1).offset).toBe(1);
  expect(() => fileCursor("second", cursor, 3, 1)).toThrow("changed");
  expect(() => fileCursor("first", undefined, 3, 0)).toThrow();
});
test("SWPC discovery uses available root folders and safe recursive paths", async () => {
  const rows = await collect((c) => spaceProducts({ folder: "all", recursive: true }, c));
  expect(rows.some((r) => r.product_id === "json/goes/primary/xrays-6-hour.json")).toBe(true);
  expect(rows.some((r) => String(r.product_id).includes("animations"))).toBe(false);
  expect(rows.some((r) => String(r.product_id).includes("evil"))).toBe(false);
  for (const path of ["https://example.com/x.json", "json/../secret.json", "json/x.json?q=1", "json/foo.png"])
    expect(() => spacePath(path, false)).toThrow();
});
test("space-weather records retain headers, string zeros, native NULLs, horizon keys and model times", async () => {
  const rows = await collect((c) => spaceRows({ product_id: "products/table.json", page_size: 1 }, c));
  expect(rows.length).toBe(3);
  expect(JSON.parse(String(rows[0]?.record_json)).density).toBe("0");
  expect(JSON.parse(String(rows[1]?.record_json)).density).toBeNull();
  expect(rows[0]?.observed_at).toBe(Date.parse("2026-01-02T12:00:00Z"));
  const aurora = await collect((c) => spaceRows({ product_id: "json/ovation_aurora_latest.json", page_size: 1 }, c));
  expect(aurora.length).toBe(3);
  expect(aurora[0]?.forecast_at).toBe(Date.parse("2026-01-02T12:30:00Z"));
  expect(JSON.parse(String(aurora[0]?.record_json))).toEqual({ longitude: 0, latitude: 60, aurora: 0 });
  const scales = await collect((c) => spaceRows({ product_id: "products/noaa-scales.json", page_size: 1 }, c));
  expect(new Set(scales.map((r) => r.record_key))).toEqual(new Set(["-1", "0", "1"]));
  expect((await spaceRows({ product_id: "text/3-day-forecast.txt", page_size: 1 })).rows[0]?.text).toContain(
    "No significant activity",
  );
  expect(() =>
    spaceRecords([
      ["a", "a"],
      [1, 2],
    ]),
  ).toThrow();
  expect(() => spaceRecords([["a"], [1, 2]])).toThrow();
});
