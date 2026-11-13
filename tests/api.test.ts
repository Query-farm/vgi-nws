import { afterAll, beforeAll, expect, test } from "bun:test";
import { apiRows, endpointPath, endpoints, localRef } from "../src/api_catalog.ts";
import { getJson } from "../src/http.ts";
import { obj } from "../src/reader.ts";
import { riverGlance } from "../src/water_glance.ts";

let mock: ReturnType<typeof Bun.spawn>;
const saved: Record<string, string | undefined> = {};
const roots = { NWS_API_BASE_URL: "", NWPS_API_BASE_URL: "", NWS_AVIATION_BASE_URL: "/aviation" };
beforeAll(async () => {
  mock = Bun.spawn(["python3", "test/mock_api/server.py"], { stdout: "pipe", stderr: "inherit" });
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const port = new TextDecoder().decode(chunk.value).match(/PORT:(\d+)/)?.[1];
  if (!port) throw new Error("Fixture failed to start");
  for (const [key, prefix] of Object.entries(roots)) {
    saved[key] = process.env[key];
    process.env[key] = `http://127.0.0.1:${port}${prefix}`;
  }
});
afterAll(() => {
  mock?.kill();
  for (const key of Object.keys(roots)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
test("schema discovery resolves inherited parameters and rejects binary/external/cyclic references", async () => {
  const document = obj((await getJson("weather", "openapi.json")).body);
  const found = endpoints(document, "weather");
  expect(found.map((e) => e.operation)).toEqual(["zone_forecast", "area_radio", "alerts_query"]);
  const zone = found[0];
  if (!zone) throw new Error("Missing fixture operation");
  expect(endpointPath(zone, { type: "forecast", zoneId: "VAZ037" })).toBe("/zones/forecast/VAZ037/forecast");
  for (const params of [
    { type: "forecast" },
    { type: "bad", zoneId: "VAZ037" },
    { type: "forecast", zoneId: "../../secret" },
    { type: "forecast", zoneId: "VAZ037", unknown: 1 },
  ])
    expect(() => endpointPath(zone, params)).toThrow();
  expect(() => localRef({}, { $ref: "https://example.com/schema" })).toThrow();
  expect(() => localRef({ loop: { $ref: "#/loop" } }, { $ref: "#/loop" })).toThrow();
  const operation = endpoints(
    {
      paths: {
        "/test/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          get: { responses: { "200": { content: { "application/json": {} } } } },
        },
      },
    },
    "weather",
  )[0];
  if (!operation) throw new Error("Missing generated operation");
  expect(endpointPath(operation, { id: 12 })).toBe("/test/12");
  expect(() => endpointPath(operation, { id: 1.2 })).toThrow();
});
test("API rows preserve native values, paging, text/XML and complete nested products", async () => {
  const a = { service: "weather", operation_id: "alerts_query", parameters_json: '{"area":["VA"]}' };
  const first = await apiRows(a);
  expect(first.rows.length).toBe(2);
  expect(first.next).toBeDefined();
  expect((await apiRows(a, first.next)).rows.length).toBe(1);
  const zone = await apiRows({
    service: "weather",
    operation_id: "zone_forecast",
    parameters_json: '{"type":"forecast","zoneId":"VAZ037"}',
  });
  expect(JSON.parse(String(zone.rows[0]?.properties_json)).periods[0].name).toBe("Today");
  const radio = await apiRows({
    service: "weather",
    operation_id: "area_radio",
    parameters_json: '{"callSign":"KHB36"}',
  });
  expect(radio.rows[0]?.text).toBe("<speak><p>Cold weather forecast.</p></speak>");
  const water = await apiRows({
    service: "water",
    operation_id: "Products_GetStageFlow",
    parameters_json: '{"identifier":"RMDV2","pedts":"HGIRG"}',
  });
  expect(JSON.parse(String(water.rows[0]?.record_json)).primaryUnits).toBe("ft");
});
test("aviation handles HTTP 204, preserves zero/NULL and raises on record caps and bad parameters", async () => {
  const a = { service: "aviation", operation_id: "metar", parameters_json: '{"ids":"KCHO"}' };
  const rows = (await apiRows(a)).rows;
  expect(rows[0]?.record_id).toBe("KCHO");
  expect(JSON.parse(String(rows[0]?.record_json))).toMatchObject({ temp: 0, wspd: null, visib: "10+" });
  expect((await apiRows({ ...a, parameters_json: '{"ids":"NONE"}' })).rows).toEqual([]);
  await expect(apiRows({ ...a, parameters_json: '{"ids":"CAP"}' })).rejects.toThrow("record cap");
  for (const parameters_json of [
    '{"ids":"KCHO","hours":-1}',
    '{"ids":"KCHO","format":"raw"}',
    '{"ids":12}',
    '{"ids":"KCHO","bogus":true}',
  ])
    await expect(apiRows({ ...a, parameters_json })).rejects.toThrow();
  expect((await apiRows({ ...a, operation_id: "fcstdisc" })).rows[0]?.text).toContain("Cold high pressure");
}, 10000);
test("River at a Glance submits a bounded distinct gauge list without losing statements", async () => {
  const rows = (await riverGlance({ gauge_ids: "rmdv2, RMDV2, OTHER" })).rows;
  expect(rows.map((r) => r.gauge_id)).toEqual(["RMDV2", "OTHER"]);
  expect(JSON.parse(String(rows[0]?.flood_statements_json))[0].units).toBe("ft");
  expect((await riverGlance({ gauge_ids: "NONE" })).rows).toEqual([]);
  for (const gauge_ids of ["", "../path", Array(101).fill("RMDV2").join(",")])
    await expect(riverGlance({ gauge_ids })).rejects.toThrow();
});
