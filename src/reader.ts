import {
  type ArgumentConstraints,
  batchFromColumns,
  bool,
  defineRowTransformFunction,
  defineTableFunction,
  float64,
  moreOutputMetadata,
  parentRowsMetadata,
  schema,
  timestampMillis,
  utf8,
  type VgiDataType,
  type VgiSchema,
} from "@query-farm/vgi";
import { type Document, getJson, type Service } from "./http.ts";
import { column, objectTags } from "./meta.ts";
export type Value = string | number | boolean | null;
export type Row = Record<string, Value>;
export type Args = Record<string, Value>;
export type ObjectData = Record<string, unknown>;
export function obj(value: unknown): ObjectData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed API response: expected an object");
  return value as ObjectData;
}
export function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Malformed API response: expected an array");
  return value;
}
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}
export function time(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`Malformed API timestamp: ${String(value)}`);
  return parsed;
}
export function id(value: Value | undefined, pattern = /^[A-Za-z0-9_-]+$/): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("Invalid identifier");
  return encodeURIComponent(value);
}
export function coords(a: Args): string {
  if (
    typeof a.latitude !== "number" ||
    typeof a.longitude !== "number" ||
    !Number.isFinite(a.latitude) ||
    !Number.isFinite(a.longitude) ||
    Math.abs(a.latitude) > 90 ||
    Math.abs(a.longitude) > 180
  )
    throw new Error("Invalid latitude or longitude");
  return `${a.latitude.toFixed(4)},${a.longitude.toFixed(4)}`;
}
export function query(path: string, values: Record<string, Value | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== "") q.set(key, String(value));
  return `${path}${q.size ? `?${q}` : ""}`;
}
export function dateRange(a: Args): void {
  for (const name of ["start_time", "end_time"]) {
    const value = a[name];
    if (
      value &&
      (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || time(value) === null)
    )
      throw new Error(`${name} must be an RFC3339 timestamp with timezone`);
  }
  if (a.start_time && a.end_time && (time(a.start_time) ?? 0) >= (time(a.end_time) ?? 0))
    throw new Error("start_time must precede end_time");
}
export type Col = [name: string, type: "text" | "number" | "time" | "bool", description: string];
const types = { text: utf8, number: float64, time: () => timestampMillis("UTC"), bool: () => bool };
const sqlTypes = { text: "VARCHAR", number: "DOUBLE", time: "TIMESTAMP WITH TIME ZONE", bool: "BOOLEAN" };
export interface Page {
  rows: Row[];
  next?: string;
}
export interface Spec {
  name: string;
  description: string;
  category?: "weather" | "water" | "reference";
  inputs?: Record<string, "text" | "number">;
  options?: Record<string, { default: Value; doc: string }>;
  inputDocs?: Record<string, string>;
  constraints?: Record<string, ArgumentConstraints>;
  prepareArgs?: (args: Args) => Args;
  columns: Col[];
  read: (args: Args, cursor?: string) => Promise<Page>;
  example: string;
  exampleDescription: string;
  exampleInputs?: string[];
}
export function provenance(doc: Document): Row {
  return { source_url: doc.source_url, fetched_at: doc.fetched_at };
}
export async function page(
  service: Service,
  path: string,
  map: (value: ObjectData) => Row,
  collection?: string,
): Promise<Page> {
  const doc = await getJson(service, path);
  const body = obj(doc.body);
  const values = collection ? arr(body[collection]) : [body];
  const next = values.length === 0 || body.pagination == null ? undefined : str(obj(body.pagination).next) || undefined;
  return { rows: values.map((v) => ({ ...map(obj(v)), ...provenance(doc) })), next };
}
interface Cursor {
  // JSON keeps mixed NULL/non-NULL input structs homogeneous in Arrow HTTP state.
  inputsJson: string;
  index: number;
  cursor?: string;
  pages: number;
  seen: string[];
}
function columns(rows: Row[], output: VgiSchema) {
  return Object.fromEntries(output.fields.map((field) => [field.name, rows.map((r) => r[field.name] ?? null)]));
}
export function reader(spec: Spec) {
  const allColumns: Col[] = [
    ...spec.columns,
    ["source_url", "text", "Canonical upstream API URL for this row."],
    ["fetched_at", "time", "UTC time this API representation was fetched or revalidated; cache hits retain this time."],
  ];
  const outputSchema = schema(allColumns.map(([n, t, d]) => column(n, types[t](), d)));
  const options = {
    ...spec.options,
    max_pages: {
      default: 100,
      doc: "Maximum upstream pages per input (1–1000); exceeding it raises an error instead of returning a partial result.",
    },
  };
  const namedArgs: Record<string, VgiDataType> = {};
  for (const [n, o] of Object.entries(options))
    namedArgs[n] = typeof o.default === "boolean" ? bool : typeof o.default === "number" ? float64() : utf8();
  const common = {
    name: spec.name,
    description: spec.description,
    argDefaults: Object.fromEntries(Object.entries(options).map(([n, o]) => [n, o.default])),
    argDocs: {
      ...Object.fromEntries(
        Object.keys(spec.inputs || {}).map((n) => [
          n,
          spec.inputDocs?.[n] || `${n.replaceAll("_", " ")} supplied per input row; NULL produces no rows.`,
        ]),
      ),
      ...Object.fromEntries(Object.entries(options).map(([n, o]) => [n, o.doc])),
    },
    argConstraints: {
      max_pages: { ge: 1, le: 1000 },
      ...(spec.inputs?.latitude ? { latitude: { ge: -90, le: 90 }, longitude: { ge: -180, le: 180 } } : {}),
      ...spec.constraints,
    },
    onBind: () => ({ outputSchema }),
    initialState: (): Cursor => ({ inputsJson: "[]", index: 0, pages: 0, seen: [] }),
    tags: {
      ...objectTags({
        title: spec.name.replaceAll("_", " "),
        category: spec.category || "weather",
        keywords: `NWS, NOAA, ${spec.name.replaceAll("_", ", ")}`,
        docLlm: `${spec.description} ${spec.inputs ? "Positional arguments accept columns and correlated LATERAL joins; NULL inputs emit no rows." : "All filters are named arguments."} HTTP errors are raised, never represented as empty data. Results reflect the upstream service, not a historical archive. Pages stream with a bounded continuation cursor.`,
        docMd: `${spec.description}\n\nUse the source_url and fetched_at columns for provenance. Units and missing values are retained. No API key is needed.\n\nSee [NWS API documentation](https://www.weather.gov/documentation/services-web-api).`,
      }),
      "vgi.result_columns_schema": JSON.stringify(
        allColumns.map(([name, t, description]) => ({ name, type: sqlTypes[t], description })),
      ),
    },
    examples: [{ sql: spec.example, description: spec.exampleDescription }],
  };
  async function next(args: Args, state: Cursor): Promise<{ rows: Row[]; parents: number[]; more: boolean }> {
    const inputs = JSON.parse(state.inputsJson) as Args[];
    while (state.index < inputs.length) {
      const input = inputs[state.index];
      if (!input) throw new Error("Invalid continuation state");
      if (Object.values(input).some((v) => v === null)) {
        state.index++;
        continue;
      }
      const merged = { ...args, ...input };
      const callArgs = spec.prepareArgs ? spec.prepareArgs(merged) : merged;
      const max = Number(callArgs.max_pages);
      if (!Number.isInteger(max) || max < 1 || max > 1000)
        throw new Error("max_pages must be an integer between 1 and 1000");
      if (state.pages >= max) throw new Error(`max_pages (${max}) reached; narrow the query or raise max_pages`);
      const result = await spec.read(callArgs, state.cursor);
      state.pages++;
      const parent = state.index;
      if (result.next) {
        if (state.seen.includes(result.next)) throw new Error("Upstream pagination cycle detected");
        state.seen.push(result.next);
        state.cursor = result.next;
      } else {
        state.index++;
        state.cursor = undefined;
        state.pages = 0;
        state.seen = [];
      }
      return { rows: result.rows, parents: result.rows.map(() => parent), more: state.index < inputs.length };
    }
    return { rows: [], parents: [], more: false };
  }
  if (spec.inputs) {
    return defineRowTransformFunction<Args, Cursor>({
      ...common,
      args: Object.fromEntries(Object.entries(spec.inputs).map(([n, t]) => [n, types[t]()])),
      namedArgs,
      inputRowsPerCall: 16,
      process: async (params, batch, out, state) => {
        state.inputsJson = JSON.stringify(
          Array.from({ length: batch.numRows }, (_, i) =>
            Object.fromEntries(
              Object.keys(spec.inputs || {}).map((name) => {
                const value = (batch.getChild(name)?.get(i) ?? null) as Value;
                if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Invalid non-finite ${name}`);
                return [name, value];
              }),
            ),
          ),
        );
        state.index = 0;
        state.cursor = undefined;
        state.pages = 0;
        state.seen = [];
        const result = await next(params.args, state);
        out.emit(
          batchFromColumns(columns(result.rows, params.outputSchema), params.outputSchema),
          moreOutputMetadata(result.more, parentRowsMetadata(result.parents, result.rows.length)),
        );
      },
      resume: async (params, state, out) => {
        const result = await next(params.args, state);
        out.emit(
          batchFromColumns(columns(result.rows, params.outputSchema), params.outputSchema),
          moreOutputMetadata(result.more, parentRowsMetadata(result.parents, result.rows.length)),
        );
      },
    });
  }
  return defineTableFunction<Args, Cursor>({
    ...common,
    args: namedArgs,
    initialState: () => ({ inputsJson: "[{}]", index: 0, pages: 0, seen: [] }),
    process: async (params, state, out) => {
      if (state.index >= 1) {
        out.finish();
        return;
      }
      const result = await next(params.args, state);
      out.emit(batchFromColumns(columns(result.rows, params.outputSchema), params.outputSchema));
    },
  });
}

/** Stock DuckDB 2.0.0 cannot bind named options in correlated calls (duckdb#27833).
 * A positional JSON overload preserves the same names and full per-site options.
 */
export function readerWithOptions(spec: Spec) {
  if (!spec.inputs) return [reader(spec)];
  const defaults: Args = {
    ...Object.fromEntries(Object.entries(spec.options || {}).map(([key, value]) => [key, value.default])),
    max_pages: 100,
  };
  const allowed = new Set(Object.keys(defaults));
  const config = JSON.stringify(Object.fromEntries(Object.entries(defaults).slice(0, 1)));
  const signature = `${(
    spec.exampleInputs ||
      Object.keys(spec.inputs).map((name) =>
        name.includes("latitude") ? "38.0293" : name.includes("longitude") ? "-78.4767" : "'RMDV2'",
      )
  ).join(", ")}, '${config.replaceAll("'", "''")}'`;
  const positional: Spec = {
    ...spec,
    description: `${spec.description} This compatibility form accepts options_json as a final positional argument for correlated calls on stock DuckDB 2.0.0. JSON keys match the named options on nws.main.${spec.name}.`,
    inputs: { ...spec.inputs, options_json: "text" },
    inputDocs: {
      ...spec.inputDocs,
      options_json:
        "JSON configuration matching the named options documented on the corresponding main-schema function. Unknown keys and incorrect value types raise errors. NULL produces no rows.",
    },
    // These options come from JSON on this overload, not from named parameters.
    options: {},
    constraints: Object.fromEntries(
      Object.entries(spec.constraints || {}).filter(([key]) => Object.hasOwn(spec.inputs || {}, key)),
    ),
    prepareArgs: (args) => {
      if (typeof args.options_json !== "string" || args.options_json.length > 4096)
        throw new Error("options_json must be a JSON object of at most 4096 characters");
      const options = obj(JSON.parse(args.options_json));
      for (const [key, value] of Object.entries(options)) {
        if (!allowed.has(key)) throw new Error(`Unknown options_json key: ${key}`);
        if (
          value === null ||
          typeof value !== typeof defaults[key] ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          throw new Error(`Invalid options_json value for ${key}`);
        const constraint = spec.constraints?.[key];
        if (constraint?.choices && !constraint.choices.includes(value as string))
          throw new Error(`Invalid options_json choice for ${key}`);
      }
      return { ...defaults, ...args, ...options } as Args;
    },
    example: `SELECT ${spec.columns[0]?.[0]} FROM nws.compat.${spec.name}(${signature}) ORDER BY ${spec.columns[0]?.[0]}`,
    exampleDescription: `Use positional JSON options with ${spec.name} on stock DuckDB`,
  };
  const compat = reader(positional);
  compat.meta.tags = { ...compat.meta.tags, "nws.compat": "true" };
  return [reader(spec), compat];
}
