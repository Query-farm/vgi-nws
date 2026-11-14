import { afterAll, beforeAll, expect, test } from "bun:test";
import { CATALOG, FUNCTIONS } from "../src/catalog.ts";
import { COMPOSED_EXAMPLES, COMPOSED_TASKS } from "../src/composed.ts";
import { freshness, getJson, resolveUrl, retryDelay } from "../src/http.ts";
import { coords, dateRange, obj, page, time } from "../src/reader.ts";
import { interval, measure } from "../src/weather.ts";

let mock: ReturnType<typeof Bun.spawn>;
let savedWeather: string | undefined;
let savedWater: string | undefined;
beforeAll(async () => {
  savedWeather = process.env.NWS_API_BASE_URL;
  savedWater = process.env.NWPS_API_BASE_URL;
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture did not start");
  process.env.NWS_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.NWPS_API_BASE_URL = process.env.NWS_API_BASE_URL;
});
afterAll(() => {
  mock?.kill();
  if (savedWeather === undefined) delete process.env.NWS_API_BASE_URL;
  else process.env.NWS_API_BASE_URL = savedWeather;
  if (savedWater === undefined) delete process.env.NWPS_API_BASE_URL;
  else process.env.NWPS_API_BASE_URL = savedWater;
});
test("catalog contains all 92 domain functions with example SQL", () => {
  expect(FUNCTIONS.length).toBe(129);
  expect(new Set(FUNCTIONS.map((f) => f.meta.name)).size).toBe(92);
  for (const f of FUNCTIONS) expect(f.meta.examples?.length).toBeGreaterThan(0);
});
test("composed examples lead the schema list and sit in the driving function's first five", () => {
  const schemaSql = JSON.parse(CATALOG.schemas[0]?.tags?.["vgi.example_queries"] ?? "[]").map(
    (e: { sql: string }) => e.sql,
  );
  expect(new Set(schemaSql).size).toBe(schemaSql.length);
  for (const [name, examples] of Object.entries(COMPOSED_EXAMPLES)) {
    const fn = FUNCTIONS.find((f) => f.meta.name === name && f.meta.tags?.["nws.compat"] !== "true");
    const published = JSON.parse(fn?.meta.tags?.["vgi.example_queries"] ?? "[]").map((e: { sql: string }) => e.sql);
    for (const ex of examples) {
      expect(published.slice(0, 5)).toContain(ex.sql);
      expect(schemaSql).toContain(ex.sql);
      expect(ex.sql).not.toContain(";");
    }
  }
  const tasks = JSON.parse(CATALOG.tags?.["vgi.agent_test_tasks"] ?? "[]").map((t: { name: string }) => t.name);
  for (const t of COMPOSED_TASKS) expect(tasks).toContain(t.name);
});
test("intervals preserve multi-hour and multi-day duration and timestamp offsets", () => {
  expect(interval("2026-01-02T12:00:00-05:00/PT2H")).toEqual([
    Date.parse("2026-01-02T17:00:00Z"),
    Date.parse("2026-01-02T19:00:00Z"),
  ]);
  const [start, end] = interval("2026-01-02T12:00:00Z/P1DT30M");
  expect(end - start).toBe(88200000);
  expect(interval("2026-01-02T12:00:00Z/2026-01-02T13:00:00Z")[1] - start).toBe(3600000);
  for (const value of ["bad", "2026-01-02/P1M", "2026-01-02/PT0S", "2026-01-02/2025-01-01"])
    expect(() => interval(value)).toThrow();
});
test("unit conversions do not turn missing observations into zero", () => {
  expect(measure({ value: 18, unitCode: "wmoUnit:km_h-1" }, "m_s-1")).toBe(5);
  expect(measure({ value: 32, unitCode: "wmoUnit:degF" }, "degC")).toBe(0);
  expect(measure({ value: null, unitCode: "wmoUnit:degC" }, "degC")).toBeNull();
  expect(measure(undefined, "mm")).toBeNull();
  expect(() => measure({ value: 3, unitCode: "unknown" }, "m")).toThrow("Unsupported unit");
});
test("validate coordinates, date ranges, and malformed response shapes", () => {
  expect(coords({ latitude: 38.02931, longitude: -78.47672 })).toBe("38.0293,-78.4767");
  for (const latitude of [91, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => coords({ latitude, longitude: 0 })).toThrow();
  expect(() => dateRange({ start_time: "2026-01-01" })).toThrow();
  expect(() => dateRange({ start_time: "2026-01-02T00:00:00Z", end_time: "2026-01-01T00:00:00Z" })).toThrow();
  expect(() => time("garbage")).toThrow();
  expect(() => obj([])).toThrow();
});
test("canonical links are rewritten only into configured trusted roots", () => {
  expect(resolveUrl("water", "https://api.water.noaa.gov/nwps/v1/gauges/RMDV2").url).toBe(
    `${process.env.NWPS_API_BASE_URL}/gauges/RMDV2`,
  );
  for (const path of [
    "https://example.com/secrets",
    "//example.com/test",
    "https://api.weather.gov@evil.test/x",
    "https://api.weather.gov/x#fragment",
  ])
    expect(() => resolveUrl("weather", path)).toThrow();
  expect(() => resolveUrl("water", "https://api.water.noaa.gov/other")).toThrow();
});
test("HTTP cache freshness respects directives, Age, and Date", () => {
  expect(freshness(new Headers({ "cache-control": "public, max-age=60", age: "20" }))).toBe(40000);
  expect(freshness(new Headers({ "cache-control": "no-cache, max-age=60" }))).toBe(0);
  expect(freshness(new Headers({ "cache-control": "no-store, max-age=60" }))).toBe(0);
  expect(freshness(new Headers())).toBe(0);
  expect(freshness(new Headers({ "cache-control": "max-age=60", date: new Date(0).toUTCString() }), 90000)).toBe(0);
});
test("Retry-After supports both seconds and HTTP dates without premature retries", () => {
  expect(retryDelay("120", 0)).toBe(120000);
  expect(retryDelay("Thu, 01 Jan 1970 00:00:10 GMT", 0, 3000)).toBe(7000);
  expect(retryDelay(null, 1)).toBe(500);
});
test("real HTTP fixture pagination, provenance and cache reuse", async () => {
  const first = await page("weather", "/alerts/active", (v) => ({ id: String(obj(v.properties).id) }), "features");
  expect(first.rows.length).toBe(2);
  expect(first.next).toContain("cursor=2");
  const next = await page("weather", first.next || "", (v) => ({ id: String(obj(v.properties).id) }), "features");
  expect(next.rows.length).toBe(1);
  expect(next.next).toBeUndefined();
  const [a, b] = await Promise.all([getJson("weather", "/stations/KCHO"), getJson("weather", "/stations/KCHO")]);
  expect(a).toBe(b);
  expect(a.source_url).toBe("https://api.weather.gov/stations/KCHO");
  expect(await getJson("weather", "/stations/KCHO")).toBe(a);
  await expect(getJson("weather", "/missing")).rejects.toThrow("HTTP 404");
});
test("HTTP revalidation, no-store, malformed JSON, redirect and retry errors", async () => {
  const previous = process.env.NWS_API_BASE_URL;
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      calls++;
      const path = new URL(request.url).pathname;
      if (path === "/revalidate")
        return request.headers.get("if-none-match") === '"a"'
          ? new Response(null, { status: 304 })
          : Response.json({ ok: true }, { headers: { etag: '"a"', "cache-control": "no-cache" } });
      if (path === "/store") return Response.json({}, { headers: { "cache-control": "no-store" } });
      if (path === "/bad") return new Response("{not JSON");
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1" } });
      if (path === "/rate") return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    },
  });
  process.env.NWS_API_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    const a = await getJson("weather", "/revalidate");
    const b = await getJson("weather", "/revalidate");
    expect(b.body).toEqual(a.body);
    expect(calls).toBe(2);
    await getJson("weather", "/store");
    await getJson("weather", "/store");
    expect(calls).toBe(4);
    await expect(getJson("weather", "/bad")).rejects.toThrow();
    await expect(getJson("weather", "/rate")).rejects.toThrow("retry after 120000 ms");
    await expect(getJson("weather", "/down")).rejects.toThrow("HTTP 503");
    await expect(getJson("weather", "/redirect")).rejects.toThrow();
  } finally {
    server.stop(true);
    process.env.NWS_API_BASE_URL = previous;
  }
});

test("an empty NWS station page terminates despite its next cursor", async () => {
  const result = await page("weather", "/stations?cursor=empty", () => ({}), "features");
  expect(result.rows).toEqual([]);
  expect(result.next).toBeUndefined();
});

test("interval start and end require explicit timezones", () => {
  expect(() => interval("2026-01-02T12:00:00/PT2H")).toThrow("timezone");
  expect(() => interval("2026-01-02T12:00:00Z/2026-01-02T13:00:00")).toThrow("timezone");
});
