/** Bounded, shared HTTP cache. Only server-configured roots can be contacted. */
export type MapService = "gis" | "raster" | "tropical" | "event";
export type Service = "weather" | "water" | "aviation" | "ndbc" | "swpc" | "mrms" | MapService;
const ROOTS = {
  weather: "https://api.weather.gov",
  water: "https://api.water.noaa.gov/nwps/v1",
  gis: "https://mapservices.weather.noaa.gov/vector/rest/services",
  raster: "https://mapservices.weather.noaa.gov/raster/rest/services",
  tropical: "https://mapservices.weather.noaa.gov/tropical/rest/services",
  event: "https://mapservices.weather.noaa.gov/eventdriven/rest/services",
  aviation: "https://aviationweather.gov",
  ndbc: "https://www.ndbc.noaa.gov",
  swpc: "https://services.swpc.noaa.gov",
  mrms: "https://mrms.ncep.noaa.gov",
};
const ENV = {
  weather: "NWS_API_BASE_URL",
  water: "NWPS_API_BASE_URL",
  gis: "NWS_GIS_BASE_URL",
  raster: "NWS_RASTER_BASE_URL",
  tropical: "NWS_TROPICAL_BASE_URL",
  event: "NWS_EVENT_BASE_URL",
  aviation: "NWS_AVIATION_BASE_URL",
  ndbc: "NWS_NDBC_BASE_URL",
  swpc: "NWS_SWPC_BASE_URL",
  mrms: "NWS_MRMS_BASE_URL",
};
export interface Document {
  body: unknown;
  source_url: string;
  fetched_at: number;
}
/** ArcGIS can report an application/server failure inside an HTTP 200 response. */
export function gisFailure(body: unknown): { message: string; retryable: boolean } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  if (data.error != null) {
    const error = typeof data.error === "object" ? (data.error as Record<string, unknown>) : {};
    const code = Number(error.code);
    return {
      message: `NWS GIS error ${String(error.code)}: ${String(error.message || "unknown error")}`,
      retryable: code === 429 || (code >= 500 && code <= 599),
    };
  }
  if (data.status === "error") {
    const messages = Array.isArray(data.messages) ? data.messages.filter((v) => typeof v === "string") : [];
    return { message: `NWS GIS error: ${messages.join("; ") || "server failure"}`, retryable: true };
  }
  return null;
}
interface Entry {
  doc: Document;
  expires: number;
  etag: string | null;
  modified: string | null;
  size: number;
}
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Document>>();
const MAX_BYTES = 8 * 1024 * 1024;
let active = 0;
let aviationNext = 0;
const waiting: (() => void)[] = [];

export function resolveUrl(service: Service, path: string): { url: string; source: string } {
  const canonical = new URL(`${ROOTS[service]}/`);
  const base = new URL(`${(process.env[ENV[service]] || ROOTS[service]).replace(/\/$/, "")}/`);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error(`${ENV[service]} must be an HTTP(S) API root without credentials, query, or fragment`);
  }
  // Relative API paths are relative to the API root, including NWPS's /nwps/v1.
  const supplied = new URL(path.replace(/^\/(?!\/)/, ""), canonical);
  let suffix: string;
  if (supplied.origin === canonical.origin && supplied.pathname.startsWith(canonical.pathname)) {
    suffix = supplied.pathname.slice(canonical.pathname.length);
  } else if (supplied.origin === base.origin && supplied.pathname.startsWith(base.pathname)) {
    suffix = supplied.pathname.slice(base.pathname.length);
  } else {
    throw new Error("Rejected an upstream URL outside the configured API root");
  }
  if (supplied.username || supplied.password || supplied.hash) throw new Error("Invalid upstream link");
  return { url: `${base}${suffix}${supplied.search}`, source: `${canonical}${suffix}${supplied.search}` };
}

export function retryDelay(value: string | null, attempt: number, now = Date.now()): number {
  if (value && /^\d+$/.test(value)) return Number(value) * 1000;
  if (value && Number.isFinite(Date.parse(value))) return Math.max(0, Date.parse(value) - now);
  return 250 * 2 ** attempt;
}
export function freshness(headers: Headers, now = Date.now()): number {
  const cc = headers.get("cache-control") || "";
  if (/\b(no-store|no-cache)\b/i.test(cc)) return 0;
  const maxAge = cc.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
  if (!maxAge) return 0;
  const date = Date.parse(headers.get("date") || "");
  const age = Math.max(Number(headers.get("age") || 0) * 1000, Number.isFinite(date) ? now - date : 0);
  return Math.max(0, Number(maxAge) * 1000 - age);
}
async function boundedBytes(response: Response, max = MAX_BYTES): Promise<Uint8Array> {
  const message = `API response exceeds ${max / 1024 / 1024} MiB limit; narrow the query`;
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new Error(message);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("API returned no response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) throw new Error(message);
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return data;
  } finally {
    await reader.cancel();
  }
}
async function request(
  url: string,
  source: string,
  service: Service,
  format: "json" | "text" | "bytes",
  payload?: string,
): Promise<Document> {
  const key = `${format}:${url}${payload ? `\n${payload}` : ""}`;
  if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    const old = cache.get(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: Record<string, string> = {
        Accept:
          format === "bytes"
            ? "application/octet-stream, application/gzip"
            : format === "json"
              ? "application/geo+json, application/json"
              : "text/plain, application/xml, application/ssml+xml, application/vnd.wmo.iwxxm+xml, text/html",
        "User-Agent": process.env.NWS_USER_AGENT || "vgi-nws/0.4.0 (https://query.farm)",
      };
      if (old?.etag) headers["If-None-Match"] = old.etag;
      if (old?.modified) headers["If-Modified-Since"] = old.modified;
      let response: Response;
      try {
        if (service === "aviation") {
          const slot = Math.max(Date.now(), aviationNext);
          aviationNext = slot + 650;
          await Bun.sleep(Math.max(0, slot - Date.now()));
        }
        if (payload) headers["Content-Type"] = "application/json";
        response = await fetch(url, {
          headers,
          method: payload ? "POST" : "GET",
          body: payload,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        if (attempt === 2) throw new Error(`${payload ? "POST" : "GET"} ${source} failed: ${String(error)}`);
        await Bun.sleep(retryDelay(null, attempt));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const delay = retryDelay(response.headers.get("retry-after"), attempt);
        await response.body?.cancel();
        if (attempt === 2 || delay > 30_000)
          throw new Error(`${payload ? "POST" : "GET"} ${source}: HTTP ${response.status}; retry after ${delay} ms`);
        await Bun.sleep(delay);
        continue;
      }
      if (!response.ok && response.status !== 304) {
        await response.body?.cancel();
        throw new Error(`${payload ? "POST" : "GET"} ${source}: HTTP ${response.status} ${response.statusText}`);
      }
      const fetched = Date.now();
      if (response.status === 304 && !old) throw new Error(`Unexpected HTTP 304 from ${source}`);
      const empty = response.status === 204 && service === "aviation";
      const bytes =
        response.status === 304 || empty
          ? new Uint8Array()
          : await boundedBytes(response, service === "mrms" && format === "bytes" ? 32 * 1024 * 1024 : MAX_BYTES);
      const text = format === "bytes" ? "" : new TextDecoder().decode(bytes);
      const doc: Document = {
        body:
          response.status === 304
            ? old?.doc.body
            : format === "bytes"
              ? bytes
              : format === "text"
                ? text
                : empty
                  ? []
                  : JSON.parse(text),
        source_url: source,
        fetched_at: fetched,
      };
      const failure = ["gis", "raster", "tropical", "event"].includes(service) ? gisFailure(doc.body) : null;
      if (failure) {
        cache.delete(key);
        if (!failure.retryable || attempt === 2) throw new Error(failure.message);
        const delay = retryDelay(response.headers.get("retry-after"), attempt);
        if (delay > 30_000) throw new Error(`${failure.message}; retry after ${delay} ms`);
        await Bun.sleep(delay);
        continue;
      }
      if (/\bno-store\b/i.test(response.headers.get("cache-control") || "")) cache.delete(key);
      else {
        cache.delete(key);
        cache.set(key, {
          doc,
          expires: fetched + freshness(response.headers, fetched),
          etag: response.headers.get("etag") || (response.status === 304 ? old?.etag : null) || null,
          modified: response.headers.get("last-modified") || (response.status === 304 ? old?.modified : null) || null,
          size: (format === "bytes" ? bytes.length : text.length * 2) || old?.size || 0,
        });
        let cacheBytes = [...cache.values()].reduce((sum, item) => sum + item.size, 0);
        while (cache.size > 128 || cacheBytes > 16 * 1024 * 1024) {
          const first = cache.keys().next().value;
          if (!first) break;
          cacheBytes -= cache.get(first)?.size || 0;
          cache.delete(first);
        }
      }
      return doc;
    }
    throw new Error("HTTP attempts exhausted");
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
export async function getJson(service: Service, path: string): Promise<Document> {
  return getDocument(service, path, "json");
}
export async function getText(service: Service, path: string): Promise<Document> {
  return getDocument(service, path, "text");
}
export async function getBytes(service: Service, path: string): Promise<Document> {
  return getDocument(service, path, "bytes");
}
/** Used only by the documented NWPS river-at-a-glance read endpoint. */
export async function postJson(service: Service, path: string, body: unknown): Promise<Document> {
  const payload = JSON.stringify(body);
  if (!payload || payload.length > 16000) throw new Error("API request body exceeds 16000 characters");
  return getDocument(service, path, "json", payload);
}
async function getDocument(
  service: Service,
  path: string,
  format: "json" | "text" | "bytes",
  payload?: string,
): Promise<Document> {
  const { url, source } = resolveUrl(service, path);
  const key = `${format}:${url}${payload ? `\n${payload}` : ""}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.doc;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const promise = request(url, source, service, format, payload);
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}
