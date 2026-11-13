/** Schema-driven GET access to public NWS APIs, retaining native response structure. */
import { getJson, getText, type Service } from "./http.ts";
import { choose } from "./outlooks.ts";
import {
  type Args,
  arr,
  type Col,
  json,
  num,
  type ObjectData,
  obj,
  type Page,
  provenance,
  readerWithOptions,
  str,
} from "./reader.ts";

const SOURCES = {
  weather: "openapi.json",
  water: "docs/swagger.json",
  aviation: "data/schema/openapi.yaml",
} as const;
type ApiService = keyof typeof SOURCES;
interface Endpoint {
  operation: string;
  path: string;
  description: string;
  parameters: ObjectData[];
  format: "json" | "text";
  deprecated: boolean;
}
export function localRef(document: ObjectData, value: unknown): ObjectData {
  let current = obj(value);
  for (let depth = 0; current.$ref != null; depth++) {
    if (depth > 12 || typeof current.$ref !== "string" || !current.$ref.startsWith("#/"))
      throw new Error("Unsupported external or cyclic API schema reference");
    let target: unknown = document;
    for (const key of current.$ref.slice(2).split("/"))
      target = obj(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    current = obj(target);
  }
  return current;
}
export function endpoints(document: ObjectData, service: ApiService): Endpoint[] {
  return Object.entries(obj(document.paths)).flatMap(([path, raw]) => {
    const item = obj(raw);
    if (!item.get || !path.startsWith("/") || path.includes("..")) return [];
    const get = obj(item.get),
      responses = obj(get.responses);
    const success = responses["200"] ? localRef(document, responses["200"]) : null;
    const content = success?.content == null ? {} : obj(success.content);
    const types = Object.keys(content);
    const isJson = types.some((t) => /(?:json|geo\+json|ld\+json)/.test(t));
    // Swagger 2 water descriptions declare produces globally, not response content.
    const legacyJson = service === "water" && !types.length && !path.includes("monitor");
    const text = types.includes("text/plain") || types.some((t) => t.endsWith("+xml") || t === "application/xml");
    if (!isJson && !legacyJson && !text) return [];
    const parameters = [
      ...(item.parameters == null ? [] : arr(item.parameters)),
      ...(get.parameters == null ? [] : arr(get.parameters)),
    ]
      .map((p) => localRef(document, p))
      .filter((p) => p.in === "path" || p.in === "query");
    const unique = new Map<string, ObjectData>();
    for (const p of parameters) {
      if (typeof p.name !== "string") throw new Error("API schema parameter has no name");
      unique.set(p.name, { ...p, schema: localRef(document, p.schema ?? p) });
    }
    return [
      {
        operation:
          str(get.operationId) ||
          path
            .replace(/^\/nwps\/v1\//, "")
            .replace(/^\/api\/data\//, "")
            .replaceAll("/", "_")
            .replaceAll(/[{}]/g, ""),
        path: service === "water" ? path.replace(/^\/nwps\/v1/, "") : path,
        description: [str(get.summary), str(get.description)].filter(Boolean).join(". "),
        parameters: [...unique.values()],
        format: isJson || legacyJson ? "json" : "text",
        deprecated: get.deprecated === true,
      },
    ];
  });
}
async function specification(service: ApiService) {
  const doc =
    service === "aviation" ? await getText(service, SOURCES[service]) : await getJson(service, SOURCES[service]);
  const body = obj(service === "aviation" ? Bun.YAML.parse(String(doc.body)) : doc.body);
  return { doc, body, endpoints: endpoints(body, service) };
}
function scalar(value: unknown, schema: ObjectData, name: string): string {
  if (value === null || !["string", "number", "boolean"].includes(typeof value))
    throw new Error(`${name} must be a scalar value`);
  const type = schema.type;
  if (
    (type === "string" && typeof value !== "string") ||
    (type === "boolean" && typeof value !== "boolean") ||
    (["integer", "number"].includes(String(type)) && (typeof value !== "number" || !Number.isFinite(value))) ||
    (type === "integer" && !Number.isInteger(value))
  )
    throw new Error(`Invalid API parameter type: ${name}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error(`Unsupported API parameter value: ${name}`);
  if (
    typeof value === "number" &&
    ((typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    throw new Error(`API parameter out of range: ${name}`);
  if (
    typeof value === "string" &&
    (value.length > 2000 || (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)))
  )
    throw new Error(`Invalid API parameter: ${name}`);
  return String(value);
}
export function endpointPath(endpoint: Endpoint, supplied: unknown): string {
  const values = obj(supplied);
  const known = new Set(endpoint.parameters.map((p) => String(p.name)));
  for (const key of Object.keys(values)) if (!known.has(key)) throw new Error(`Unknown API parameter: ${key}`);
  let path = endpoint.path;
  const query = new URLSearchParams();
  for (const p of endpoint.parameters) {
    const name = String(p.name),
      schema = obj(p.schema);
    let value = values[name];
    if (name === "format" && p.in === "query") {
      const wanted = endpoint.format === "json" ? "json" : "raw";
      if (value !== undefined && value !== wanted) throw new Error(`This reader requires format ${wanted}`);
      value = wanted;
    }
    if (value === undefined) {
      if (p.required === true || p.in === "path") throw new Error(`Required API parameter: ${name}`);
      continue;
    }
    if (p.in === "path") {
      const text = scalar(value, schema, name);
      if (!text || /[/\\?#]/.test(text) || text === "." || text === "..")
        throw new Error(`Invalid path parameter: ${name}`);
      path = path.replaceAll(`{${name}}`, encodeURIComponent(text));
    } else if (schema.type === "array") {
      if (!Array.isArray(value) || value.length > 200)
        throw new Error(`${name} must be an array of at most 200 values`);
      const entries = value.map((v) => scalar(v, obj(schema.items ?? {}), name));
      if (p.explode === true) for (const entry of entries) query.append(name, entry);
      else query.set(name, entries.join(","));
    } else query.set(name, scalar(value, schema, name));
  }
  if (/[{}]/.test(path)) throw new Error("API schema has an unresolved path parameter");
  return `${path}${query.size ? `?${query}` : ""}`;
}
const columns: Col[] = [
  ["service", "text", "weather, water, or aviation."],
  ["operation_id", "text", "Operation from api_endpoints."],
  ["row_index", "number", "Zero-based position within this upstream page, not a persistent record ID."],
  ["record_id", "text", "Native record identifier when present; NULL otherwise."],
  ["record_json", "text", "Complete native JSON record, retaining nested quantities, units, dates and missing values."],
  ["properties_json", "text", "GeoJSON properties if present."],
  ["geometry_json", "text", "Native geometry if present. Consult the source CRS; no reprojection is inferred."],
  ["text", "text", "Original text for text-only aviation products; NULL for JSON."],
];
export async function apiRows(a: Args, cursor?: string): Promise<Page> {
  const service = choose(a.service, Object.keys(SOURCES), "service") as ApiService;
  if (typeof a.parameters_json !== "string" || a.parameters_json.length > 16000)
    throw new Error("parameters_json must be a JSON object of at most 16000 characters");
  const spec = await specification(service);
  const matches = spec.endpoints.filter((e) => e.operation === a.operation_id);
  if (matches.length !== 1) throw new Error("Unknown or ambiguous operation_id; use api_endpoints");
  const e = matches[0] as Endpoint;
  const path = endpointPath(e, JSON.parse(a.parameters_json));
  const doc = await (e.format === "json" ? getJson : getText)(service as Service, cursor || path);
  if (e.format === "text")
    return {
      rows: String(doc.body).trim()
        ? [
            {
              service,
              operation_id: String(a.operation_id),
              row_index: 0,
              record_id: null,
              record_json: null,
              properties_json: null,
              geometry_json: null,
              text: String(doc.body),
              ...provenance(doc),
            },
          ]
        : [],
    };
  const body = doc.body;
  let records: unknown[], next: string | undefined;
  if (Array.isArray(body)) records = body;
  else {
    const data = obj(body);
    const key = ["features", "@graph", "items", "gauges", "stations"].find((k) => Array.isArray(data[k]));
    records = key ? arr(data[key]) : [data];
    if (data.pagination != null) next = str(obj(data.pagination).next) || undefined;
  }
  if (service === "aviation" && records.length >= 400)
    throw new Error("Aviation response reached its record cap; narrow station, time or geographic filters");
  return {
    next: records.length ? next : undefined,
    rows: records.map((record, index) => {
      const item = record && typeof record === "object" && !Array.isArray(record) ? obj(record) : {};
      const key = item.id ?? item["@id"] ?? item.icaoId ?? item.stationId;
      return {
        service,
        operation_id: String(a.operation_id),
        row_index: index,
        record_id: str(key) ?? (num(key) === null ? null : String(key)),
        record_json: json(record),
        properties_json: json(item.properties),
        geometry_json: json(item.geometry),
        text: null,
        ...provenance(doc),
      };
    }),
  };
}
export const API_FUNCTIONS = [
  ...readerWithOptions({
    name: "api_endpoints",
    category: "reference",
    description:
      "Discover readable GET operations directly from the current official weather.gov, NWPS or Aviation Weather Center API specification. Includes station discovery, zone forecasts, office headlines, radio transmitters/broadcasts, radar status, aviation METAR/TAF/PIREPs/SIGMETs/G-AIRMETs/CWAs, navigation references and remaining river products. Parameters retain published names, required flags, types and constraints. Use api_rows to read actual records. Binary imagery and internal monitoring are excluded; deprecated operations are labeled.",
    options: { service: { default: "weather", doc: "Official specification: weather, water or aviation." } },
    constraints: { service: { choices: Object.keys(SOURCES) } },
    columns: [
      ["service", "text", "API service."],
      ["operation_id", "text", "Input to api_rows."],
      ["path", "text", "Public GET route template."],
      ["description", "text", "Official operation summary and description."],
      ["parameters_json", "text", "Parameter descriptors, including path/query placement and constraints."],
      ["response_format", "text", "json or text."],
      ["deprecated", "bool", "Whether the source marks this operation deprecated."],
    ],
    read: async (a) => {
      const service = choose(a.service, Object.keys(SOURCES), "service") as ApiService;
      const s = await specification(service);
      return {
        rows: s.endpoints.map((e) => ({
          service,
          operation_id: e.operation,
          path: e.path,
          description: e.description,
          parameters_json: json(e.parameters),
          response_format: e.format,
          deprecated: e.deprecated,
          ...provenance(s.doc),
        })),
      };
    },
    example:
      "SELECT operation_id, description, parameters_json FROM nws.main.api_endpoints(service := 'aviation') WHERE NOT deprecated ORDER BY operation_id",
    exampleDescription: "Discover current aviation products and required filters",
  }),
  ...readerWithOptions({
    name: "api_rows",
    inputs: { service: "text", operation_id: "text", parameters_json: "text" },
    inputDocs: {
      service: "weather, water or aviation; NULL emits no rows.",
      operation_id: "Exact operation ID from api_endpoints; NULL emits no rows.",
      parameters_json:
        "JSON object using the operation's published parameter names. Required path/query values must be provided; unknown keys, invalid types and unsupported formats fail. Arrays use JSON arrays. NULL emits no rows.",
    },
    description:
      "Read actual records from an operation discovered through api_endpoints, retaining all native JSON or original aviation text. GeoJSON features and standard collections emit one row per record; hierarchical products emit one complete JSON record, preserving their nested units and times. Follow NWS pagination to completion. Aviation has no pagination: responses reaching 400 records fail so filters can be narrowed. Missing aviation data (HTTP 204) emits no rows. Requests are limited to trusted official roots; schema constraints and parameter names are checked. Use dedicated typed readers where available and JSON extraction for less common products. Native geometry is not reprojected.",
    columns,
    constraints: { service: { choices: Object.keys(SOURCES) } },
    read: apiRows,
    exampleInputs: ["'aviation'", "'metar'", '\'{"ids":"KCHO"}\''],
    example:
      "SELECT record_id, record_json FROM nws.main.api_rows('aviation','metar','{\"ids\":\"KCHO\"}') ORDER BY row_index",
    exampleDescription: "Read decoded METAR records with their full native fields and units",
  }),
];
