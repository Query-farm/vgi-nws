import { getJson } from "./http.ts";
import {
  type Args,
  arr,
  type Col,
  coords,
  dateRange,
  id,
  json,
  num,
  type ObjectData,
  obj,
  page,
  provenance,
  query,
  type Row,
  reader,
  type Spec,
  str,
  time,
} from "./reader.ts";

const location = { latitude: "number", longitude: "number" } as const;
const locationDocs = {
  latitude: "Latitude in decimal degrees, −90 to 90. NWS coverage is limited to its US service areas.",
  longitude: "Longitude in decimal degrees, −180 to 180; west is negative.",
};
const props = (v: ObjectData) => obj(v.properties);
const textOption = (doc: string) => ({ default: "", doc });
const pfields = (p: ObjectData, keys: string[]): Row =>
  Object.fromEntries(keys.map((k) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), str(p[k])]));
function suffix(value: unknown): string | null {
  return str(value)?.split("/").at(-1) || null;
}
async function pointDoc(a: Args) {
  return getJson("weather", `/points/${coords(a)}`);
}
async function pointLink(a: Args, key: string): Promise<string> {
  const p = props(obj((await pointDoc(a)).body));
  const link = str(p[key]);
  if (!link) throw new Error(`NWS point response does not provide ${key} for this location`);
  return link;
}
const pointColumns: Col[] = [
  ["office_id", "text", "Responsible NWS forecast office identifier."],
  ["grid_id", "text", "Forecast grid office."],
  ["grid_x", "number", "Grid X coordinate."],
  ["grid_y", "number", "Grid Y coordinate."],
  ["city", "text", "Nearest relative-location city; not a geocoded address."],
  ["state", "text", "Nearest city state."],
  ["time_zone", "text", "IANA local timezone reported by NWS."],
  ["forecast_zone", "text", "Forecast zone identifier."],
  ["county", "text", "County zone identifier."],
  ["fire_weather_zone", "text", "Fire weather zone identifier."],
  ["radar_station", "text", "Associated radar site identifier."],
  ["forecast_url", "text", "Period forecast URL."],
  ["hourly_url", "text", "Hourly forecast URL."],
  ["grid_url", "text", "Raw gridded forecast URL."],
  ["stations_url", "text", "Nearby observation stations URL."],
];
const point = reader({
  name: "point",
  inputs: location,
  inputDocs: locationDocs,
  description: "Resolve a US latitude and longitude to NWS grids, offices, zones, timezone, radar, and forecast links.",
  columns: pointColumns,
  read: async (a) => {
    const doc = await pointDoc(a);
    const p = props(obj(doc.body));
    const near = p.relativeLocation ? props(obj(p.relativeLocation)) : {};
    return {
      rows: [
        {
          office_id: str(p.cwa),
          grid_id: str(p.gridId),
          grid_x: num(p.gridX),
          grid_y: num(p.gridY),
          city: str(near.city),
          state: str(near.state),
          time_zone: str(p.timeZone),
          forecast_zone: suffix(p.forecastZone),
          county: suffix(p.county),
          fire_weather_zone: suffix(p.fireWeatherZone),
          radar_station: str(p.radarStation),
          forecast_url: str(p.forecast),
          hourly_url: str(p.forecastHourly),
          grid_url: str(p.forecastGridData),
          stations_url: str(p.observationStations),
          ...provenance(doc),
        },
      ],
    };
  },
  example: "SELECT office_id, forecast_zone, grid_x, grid_y FROM nws.main.point(38.0293, -78.4767)",
  exampleDescription: "Find the forecast office and zone serving Charlottesville, Virginia",
});

const alertColumns: Col[] = [
  ...[
    "id",
    "event",
    "headline",
    "description",
    "instruction",
    "severity",
    "certainty",
    "urgency",
    "status",
    "message_type",
    "response",
    "sender_name",
    "area_desc",
  ].map((n): Col => [n, "text", `${n.replaceAll("_", " ")} as published by NWS.`]),
  ...["sent", "effective", "onset", "expires", "ends"].map(
    (n): Col => [n, "time", `UTC alert ${n} time; NULL when unspecified.`],
  ),
  ["geometry_json", "text", "GeoJSON geometry, or NULL for zone-based alerts; NULL does not mean no affected area."],
  ["affected_zones_json", "text", "JSON array of NWS zone URLs describing the affected area."],
  ["geocode_json", "text", "JSON object containing SAME and UGC codes."],
  ["parameters_json", "text", "JSON alert parameters including VTEC and AWIPS identifiers when provided."],
  ["references_json", "text", "JSON references to earlier alert messages, including updates and cancellations."],
];
function alertRow(v: ObjectData): Row {
  const p = props(v);
  return {
    ...pfields(p, [
      "id",
      "event",
      "headline",
      "description",
      "instruction",
      "severity",
      "certainty",
      "urgency",
      "status",
      "messageType",
      "response",
      "senderName",
      "areaDesc",
    ]),
    ...Object.fromEntries(["sent", "effective", "onset", "expires", "ends"].map((k) => [k, time(p[k])])),
    geometry_json: json(v.geometry),
    affected_zones_json: json(p.affectedZones),
    geocode_json: json(p.geocode),
    parameters_json: json(p.parameters),
    references_json: json(p.references),
  };
}
const alertOptions = {
  event: textOption("Exact event name, such as Freeze Warning; empty means all event types."),
  active: {
    default: true,
    doc: "Read currently active alerts; false uses the recent /alerts archive (approximately seven days).",
  },
  start_time: textOption("RFC3339 start time with timezone; only allowed with active := false."),
  end_time: textOption("RFC3339 end time with timezone; only allowed with active := false."),
};
function alertPath(a: Args, point?: string): string {
  dateRange(a);
  if (a.active && (a.start_time || a.end_time)) throw new Error("Time filters require active := false");
  if (a.area && a.zone) throw new Error("Use area or zone, not both");
  if (a.area && !/^[A-Z]{2}(,[A-Z]{2})*$/.test(String(a.area)))
    throw new Error("area must contain uppercase two-letter NWS area codes");
  if (a.zone && !/^[A-Z]{2}[CZ]\d{3}$/.test(String(a.zone)))
    throw new Error("zone must be an NWS zone ID such as VAZ037");
  return query(a.active ? "/alerts/active" : "/alerts", {
    area: a.area,
    zone: a.zone,
    point,
    event: a.event,
    start: a.start_time,
    end: a.end_time,
    limit: a.active ? undefined : 500,
  });
}
const alerts = reader({
  name: "alerts",
  description:
    "Stream active or recent NWS alerts, including zone-based warnings, original text, VTEC parameters, and update references.",
  options: {
    ...alertOptions,
    area: textOption("Comma-separated uppercase NWS area codes, such as VA or VA,MD; mutually exclusive with zone."),
    zone: textOption("Forecast or county zone ID such as VAZ037; mutually exclusive with area."),
  },
  columns: alertColumns,
  read: (a, cursor) => page("weather", cursor || alertPath(a), alertRow, "features"),
  example: "SELECT event, severity, headline, expires FROM nws.main.alerts(area := 'VA') ORDER BY sent DESC",
  exampleDescription: "Review active weather hazards in Virginia",
});
const alertsAt = reader({
  name: "alerts_at",
  description:
    "Find active or recent alerts affecting a point using NWS's point filter, which includes alerts defined by zones without polygons.",
  inputs: location,
  inputDocs: locationDocs,
  options: alertOptions,
  columns: alertColumns,
  read: (a, cursor) => page("weather", cursor || alertPath(a, coords(a)), alertRow, "features"),
  example: "SELECT event, headline FROM nws.main.alerts_at(38.0293, -78.4767)",
  exampleDescription: "Get warnings affecting a garden in Charlottesville",
});
const alert = reader({
  name: "alert",
  inputs: { alert_id: "text" },
  description:
    "Retrieve one NWS alert message by its full identifier, including its original text and referenced messages.",
  columns: alertColumns,
  read: (a) => page("weather", `/alerts/${id(a.alert_id, /^[A-Za-z0-9:._-]+$/)}`, alertRow),
  example:
    "SELECT d.event, d.headline, d.description FROM nws.main.alerts(area := 'VA') a, LATERAL nws.main.alert(a.id) d LIMIT 5",
  exampleDescription: "Read full details for current Virginia alert identifiers",
});
const alertTypes = reader({
  name: "alert_types",
  category: "reference",
  description: "List event names supported by the NWS alerts API for use in the event filter.",
  columns: [["event", "text", "Exact alert event name accepted by the API."]],
  read: async () => {
    const d = await getJson("weather", "/alerts/types");
    return { rows: arr(obj(d.body).eventTypes).map((v) => ({ event: str(v), ...provenance(d) })) };
  },
  example: "SELECT event FROM nws.main.alert_types() WHERE event ILIKE '%freeze%' ORDER BY event",
  exampleDescription: "Discover freeze-related alert event names",
});

const stationColumns: Col[] = [
  ["station_id", "text", "Station identifier used by observation functions."],
  ["name", "text", "Station name."],
  ["latitude", "number", "Latitude in decimal degrees."],
  ["longitude", "number", "Longitude in decimal degrees."],
  ["elevation_m", "number", "Station elevation in metres."],
  ["time_zone", "text", "Station timezone."],
  ["forecast_zone", "text", "Forecast zone URL."],
  ["county", "text", "County zone URL."],
];
function stationRow(v: ObjectData): Row {
  const p = props(v);
  const xy = v.geometry ? arr(obj(v.geometry).coordinates) : [];
  return {
    station_id: str(p.stationIdentifier),
    name: str(p.name),
    latitude: num(xy[1]),
    longitude: num(xy[0]),
    elevation_m: measure(p.elevation, "m"),
    time_zone: str(p.timeZone),
    forecast_zone: str(p.forecast),
    county: str(p.county),
  };
}
const stationsAt = reader({
  name: "stations_at",
  description:
    "List observation stations associated with a point's forecast grid; these are not guaranteed to be ordered by distance or availability.",
  inputs: location,
  inputDocs: locationDocs,
  columns: stationColumns,
  read: async (a, cursor) =>
    page("weather", cursor || (await pointLink(a, "observationStations")), stationRow, "features"),
  example: "SELECT station_id, name, elevation_m FROM nws.main.stations_at(38.0293, -78.4767) ORDER BY station_id",
  exampleDescription: "Discover weather observation stations for a location",
});
const station = reader({
  name: "station",
  inputs: { station_id: "text" },
  description: "Look up an NWS observation station's name, location, elevation, and zone links.",
  columns: stationColumns,
  read: (a) => page("weather", `/stations/${id(a.station_id)}`, stationRow),
  example: "SELECT station_id, name, elevation_m FROM nws.main.station('KCHO')",
  exampleDescription: "Inspect Charlottesville airport observation station",
});

/** Convert only known physical units; missing values stay NULL and unknown units fail explicitly. */
export function measure(value: unknown, target: string): number | null {
  if (value == null) return null;
  const q = obj(value);
  const n = num(q.value);
  if (n === null) return null;
  const unit = String(q.unitCode || "").replace(/^wmoUnit:/, "");
  if (unit === target) return n;
  if (target === "degC" && unit === "degF") return ((n - 32) * 5) / 9;
  if (target === "degC" && unit === "K") return n - 273.15;
  if (target === "m_s-1" && unit === "km_h-1") return n / 3.6;
  if (target === "m_s-1" && unit === "kt") return (n * 1852) / 3600;
  throw new Error(`Unsupported unit conversion ${unit} to ${target}`);
}
const quantities: [string, string, string, string][] = [
  ["temperature_c", "temperature", "degC", "Air temperature in Celsius."],
  ["dewpoint_c", "dewpoint", "degC", "Dewpoint in Celsius."],
  ["relative_humidity_pct", "relativeHumidity", "percent", "Relative humidity in percent."],
  ["wind_direction_deg", "windDirection", "degree_(angle)", "Wind direction in degrees."],
  ["wind_speed_m_s", "windSpeed", "m_s-1", "Wind speed in metres per second."],
  ["wind_gust_m_s", "windGust", "m_s-1", "Wind gust in metres per second."],
  ["pressure_pa", "barometricPressure", "Pa", "Barometric pressure in pascals."],
  ["visibility_m", "visibility", "m", "Visibility in metres."],
  ["precipitation_1h_mm", "precipitationLastHour", "mm", "Precipitation over the last hour in millimetres."],
];
const observationColumns: Col[] = [
  ["station", "text", "Station URL."],
  ["observed_at", "time", "UTC observation timestamp; data may be delayed and quality-controlled."],
  ["description", "text", "Text description of observed weather."],
  ...quantities.map(([n, , , d]): Col => [n, "number", `${d} NULL means unavailable, never zero.`]),
  ["raw_message", "text", "Original observation message when provided."],
  ["measurements_json", "text", "Original quantitative values with unit codes and qualityControl flags."],
  ["cloud_layers_json", "text", "Original cloud layers with height units."],
];
function observationRow(v: ObjectData): Row {
  const p = props(v);
  return {
    station: str(p.station),
    observed_at: time(p.timestamp),
    description: str(p.textDescription),
    ...Object.fromEntries(quantities.map(([n, key, unit]) => [n, measure(p[key], unit)])),
    raw_message: str(p.rawMessage),
    measurements_json: json(Object.fromEntries(quantities.map(([, key]) => [key, p[key] ?? null]))),
    cloud_layers_json: json(p.cloudLayers),
  };
}
const observations = reader({
  name: "observations",
  constraints: { page_size: { ge: 1, le: 500 } },
  inputs: { station_id: "text" },
  description:
    "Stream recent station observations (typically seven days), normalizing common quantities to SI units while retaining quality flags and original measurements.",
  options: {
    start_time: textOption("Inclusive RFC3339 start with timezone, within the service's recent observation window."),
    end_time: textOption("RFC3339 end with timezone."),
    page_size: { default: 500, doc: "Requested observations per page, from 1 to 500." },
  },
  columns: observationColumns,
  read: (a, cursor) => {
    dateRange(a);
    if (!Number.isInteger(a.page_size) || Number(a.page_size) < 1 || Number(a.page_size) > 500)
      throw new Error("page_size must be an integer between 1 and 500");
    return page(
      "weather",
      cursor ||
        query(`/stations/${id(a.station_id)}/observations`, {
          start: a.start_time,
          end: a.end_time,
          limit: a.page_size,
        }),
      observationRow,
      "features",
    );
  },
  example: "SELECT min(temperature_c) AS minimum_c, max(temperature_c) AS maximum_c FROM nws.main.observations('KCHO')",
  exampleDescription: "Summarize recent temperatures from a station",
});
const latestObservation = reader({
  name: "latest_observation",
  inputs: { station_id: "text" },
  description:
    "Read the most recent NWS station observation; missing measurements remain NULL and observation time is separate from retrieval time.",
  columns: observationColumns,
  read: (a) => page("weather", `/stations/${id(a.station_id)}/observations/latest`, observationRow),
  example: "SELECT observed_at, temperature_c, wind_speed_m_s FROM nws.main.latest_observation('KCHO')",
  exampleDescription: "Inspect the latest temperature and wind observation",
});

const forecastColumns: Col[] = [
  ["period_number", "number", "NWS period number."],
  ["name", "text", "Human-readable period name."],
  ["start_time", "time", "UTC period start."],
  ["end_time", "time", "UTC period end."],
  ["is_daytime", "bool", "Whether NWS labels this a daytime period."],
  ["temperature_c", "number", "Forecast temperature in Celsius."],
  ["precipitation_probability_pct", "number", "Probability of precipitation in percent; NULL means unavailable."],
  ["wind_speed", "text", "Original speed or range with units, for example 5 to 10 mph."],
  ["wind_direction", "text", "Compass wind direction."],
  ["short_forecast", "text", "Short narrative forecast."],
  ["detailed_forecast", "text", "Full narrative forecast."],
  ["updated_at", "time", "UTC last forecast update."],
  ["generated_at", "time", "UTC forecast generation time."],
];
function forecast(hourly: boolean) {
  return reader({
    name: hourly ? "forecast_hourly" : "forecast",
    inputs: location,
    inputDocs: locationDocs,
    description: hourly
      ? "Read the NWS hourly forecast for a point with typed period times, Celsius temperatures, precipitation probability, and wind text."
      : "Read the NWS day/night period forecast for a point, including the full narrative for each period.",
    columns: forecastColumns,
    read: async (a) => {
      const d = await getJson("weather", await pointLink(a, hourly ? "forecastHourly" : "forecast"));
      const p = props(obj(d.body));
      return {
        rows: arr(p.periods).map((v) => {
          const r = obj(v);
          const temp = num(r.temperature);
          const unit = str(r.temperatureUnit);
          if (temp !== null && !["F", "C"].includes(unit || ""))
            throw new Error("Unsupported forecast temperature unit");
          return {
            period_number: num(r.number),
            name: str(r.name),
            start_time: time(r.startTime),
            end_time: time(r.endTime),
            is_daytime: typeof r.isDaytime === "boolean" ? r.isDaytime : null,
            temperature_c: temp === null ? null : unit === "F" ? ((temp - 32) * 5) / 9 : temp,
            precipitation_probability_pct: measure(r.probabilityOfPrecipitation, "percent"),
            wind_speed: str(r.windSpeed),
            wind_direction: str(r.windDirection),
            short_forecast: str(r.shortForecast),
            detailed_forecast: str(r.detailedForecast),
            updated_at: time(p.updateTime),
            generated_at: time(p.generatedAt),
            ...provenance(d),
          };
        }),
      };
    },
    example: `SELECT start_time, temperature_c, short_forecast FROM nws.main.${hourly ? "forecast_hourly" : "forecast"}(38.0293, -78.4767) ORDER BY start_time`,
    exampleDescription: hourly ? "Inspect hourly garden temperatures" : "Review the upcoming day/night forecast",
  });
}

/** NWS validTime supports an end timestamp or a day/time ISO8601 duration; never resample intervals. */
export function interval(value: string): [number, number] {
  const parts = value.split("/");
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(parts[0] || ""))
    throw new Error("NWS interval start must have a timezone");
  const start = time(parts[0]);
  const end = parts[1];
  if (parts.length !== 2 || start === null || !end) throw new Error("Invalid NWS validTime interval");
  if (!end.startsWith("P")) {
    if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(end)) throw new Error("NWS interval end must have a timezone");
    const stop = time(end);
    if (stop === null || stop <= start) throw new Error("Invalid NWS interval end");
    return [start, stop];
  }
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(end);
  if (!m) throw new Error(`Unsupported NWS interval duration: ${end}`);
  const seconds = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
  if (seconds <= 0) throw new Error("NWS interval duration must be positive");
  return [start, start + seconds * 1000];
}
const gridSeries = reader({
  name: "grid_series",
  inputs: location,
  inputDocs: locationDocs,
  description:
    "Read raw NWS forecast grid variables as their original validity intervals. Numeric values retain native WMO units; structured weather and hazards are JSON. No hourly interpolation is applied.",
  options: {
    variable: textOption(
      "Exact grid variable name; empty reads every variable. Example: minTemperature. Availability is determined by the upstream grid.",
    ),
  },
  columns: [
    ["variable", "text", "Exact NWS grid variable name."],
    ["valid_from", "time", "UTC start of the validity interval."],
    ["valid_to", "time", "UTC exclusive end of the validity interval."],
    ["value", "number", "Numeric forecast value; NULL for missing or structured values."],
    ["unit", "text", "Native WMO unit code; do not combine unlike units."],
    ["value_json", "text", "Original value serialized as JSON, including structured weather and hazards."],
    ["updated_at", "time", "UTC grid update time."],
  ],
  read: async (a) => {
    const d = await getJson("weather", await pointLink(a, "forecastGridData"));
    const p = props(obj(d.body));
    const rows: Row[] = [];
    let found = false;
    for (const [name, value] of Object.entries(p)) {
      if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray((value as ObjectData).values) ||
        (a.variable && name !== a.variable)
      )
        continue;
      found = true;
      const layer = obj(value);
      for (const item of arr(layer.values)) {
        const v = obj(item);
        const [from, to] = interval(String(v.validTime));
        rows.push({
          variable: name,
          valid_from: from,
          valid_to: to,
          value: num(v.value),
          unit: str(layer.uom),
          value_json: json(v.value),
          updated_at: time(p.updateTime),
          ...provenance(d),
        });
      }
    }
    if (a.variable && !found) throw new Error(`Unknown grid variable: ${a.variable}`);
    return { rows };
  },
  example:
    "SELECT valid_from, valid_to, value, unit FROM nws.main.grid_series(38.0293, -78.4767, variable := 'minTemperature') ORDER BY valid_from",
  exampleDescription: "Inspect minimum temperature intervals without assuming hourly samples",
});

const productColumns: Col[] = [
  ["id", "text", "Unique text product identifier."],
  ["product_code", "text", "Product code such as AFD or HWO."],
  ["product_name", "text", "Human-readable product type."],
  ["issuing_office", "text", "Issuing station or office."],
  ["issued_at", "time", "UTC issuance time."],
  ["wmo_collective_id", "text", "WMO collective identifier."],
  ["product_text", "text", "Verbatim bulletin text; NULL in index results. Use product(id) to retrieve it."],
];
function productRow(p: ObjectData): Row {
  return {
    id: str(p.id),
    product_code: str(p.productCode),
    product_name: str(p.productName),
    issuing_office: str(p.issuingOffice),
    issued_at: time(p.issuanceTime),
    wmo_collective_id: str(p.wmoCollectiveId),
    product_text: str(p.productText),
  };
}
const productInputs = { product_type: "text", office_id: "text" } as const;
const productInputDocs = {
  product_type: "Uppercase product type, for example AFD (Area Forecast Discussion), HWO, or RWR.",
  office_id:
    "Three-letter office/location identifier, for example LWX or AKQ; discover valid combinations with product_locations.",
};
function productPath(a: Args) {
  return `/products/types/${id(a.product_type, /^[A-Z0-9]{3}$/)}/locations/${id(a.office_id, /^[A-Z0-9]{3,4}$/)}`;
}
const products = reader({
  name: "products",
  inputs: productInputs,
  inputDocs: productInputDocs,
  description:
    "List the recent text product index for a product type and issuing location. This is the service's available window, not a complete archive; retrieve text with product(id).",
  columns: productColumns,
  read: (a, c) => page("weather", c || productPath(a), productRow, "@graph"),
  example: "SELECT id, issued_at FROM nws.main.products('AFD', 'LWX') ORDER BY issued_at DESC",
  exampleDescription: "List recent Area Forecast Discussions for Sterling, Virginia",
});
const latestProduct = reader({
  name: "latest_product",
  inputs: productInputs,
  inputDocs: productInputDocs,
  description:
    "Retrieve the latest complete NWS text bulletin for a product type and office, such as an Area Forecast Discussion or Hazardous Weather Outlook.",
  columns: productColumns,
  read: (a) => page("weather", `${productPath(a)}/latest`, productRow),
  example: "SELECT issued_at, product_text FROM nws.main.latest_product('AFD', 'LWX')",
  exampleDescription: "Read the latest forecast discussion, including forecaster reasoning",
});
const product = reader({
  name: "product",
  inputs: { product_id: "text" },
  description:
    "Retrieve a text product by its unique identifier, retaining the original bulletin text and issuance metadata.",
  columns: productColumns,
  read: (a) => page("weather", `/products/${id(a.product_id)}`, productRow),
  example: "SELECT d.product_text FROM nws.main.products('HWO', 'LWX') p, LATERAL nws.main.product(p.id) d LIMIT 1",
  exampleDescription: "Retrieve a hazardous weather outlook from its index entry",
});
const productTypes = reader({
  name: "product_types",
  category: "reference",
  description:
    "List NWS text product codes and names for discovering discussions, outlooks, summaries, and other bulletins.",
  columns: [
    ["code", "text", "Three-character product code."],
    ["name", "text", "Product description."],
  ],
  read: () =>
    page("weather", "/products/types", (p) => ({ code: str(p.productCode), name: str(p.productName) }), "@graph"),
  example: "SELECT code, name FROM nws.main.product_types() WHERE name ILIKE '%fire%' ORDER BY code",
  exampleDescription: "Discover fire-weather bulletin types",
});
const productLocations = reader({
  name: "product_locations",
  category: "reference",
  inputs: { product_type: "text" },
  description:
    "Discover issuing locations supporting a given text product type; use these identifiers with products and latest_product.",
  columns: [
    ["office_id", "text", "Issuing location identifier."],
    ["name", "text", "Location description; may be NULL upstream."],
  ],
  read: async (a) => {
    const d = await getJson("weather", `/products/types/${id(a.product_type, /^[A-Z0-9]{3}$/)}/locations`);
    return {
      rows: Object.entries(obj(obj(d.body).locations)).map(([k, v]) => ({
        office_id: k,
        name: str(v),
        ...provenance(d),
      })),
    };
  },
  example: "SELECT office_id, name FROM nws.main.product_locations('AFD') ORDER BY office_id",
  exampleDescription: "Find offices issuing Area Forecast Discussions",
});

const zoneColumns: Col[] = [
  ["zone_id", "text", "NWS zone identifier."],
  ["name", "text", "Zone name."],
  ["type", "text", "Zone type."],
  ["state", "text", "State abbreviation."],
  ["geometry_json", "text", "GeoJSON zone geometry; index responses may omit it."],
  ["offices_json", "text", "JSON array of responsible office IDs."],
  ["time_zones_json", "text", "JSON timezone array."],
];
function zoneRow(v: ObjectData): Row {
  const p = props(v);
  return {
    zone_id: str(p.id),
    name: str(p.name),
    type: str(p.type),
    state: str(p.state),
    geometry_json: json(v.geometry),
    offices_json: json(p.cwa),
    time_zones_json: json(p.timeZone),
  };
}
function zoneType(a: Args): string {
  const value = String(a.zone_type);
  if (!["land", "marine", "forecast", "public", "coastal", "offshore", "fire", "county"].includes(value))
    throw new Error("Invalid NWS zone type");
  return value;
}
const zone = reader({
  name: "zone",
  constraints: {
    zone_type: { choices: ["land", "marine", "forecast", "public", "coastal", "offshore", "fire", "county"] },
  },
  inputs: { zone_type: "text", zone_id: "text" },
  inputDocs: {
    zone_type: "NWS zone type: forecast, county, fire, land, marine, public, coastal, or offshore.",
    zone_id: "Zone identifier such as VAZ037 or VAC540.",
  },
  description:
    "Retrieve an NWS zone boundary as GeoJSON. Use affected_zones_json from alerts to resolve alerts whose own geometry is NULL.",
  columns: zoneColumns,
  read: (a) => page("weather", `/zones/${zoneType(a)}/${id(a.zone_id, /^[A-Z]{2}[CZ]\d{3}$/)}`, zoneRow),
  example: "SELECT name, geometry_json FROM nws.main.zone('forecast', 'VAZ037')",
  exampleDescription: "Retrieve the forecast zone boundary for Albemarle County",
});
const zones = reader({
  name: "zones",
  constraints: {
    zone_type: { choices: ["land", "marine", "forecast", "public", "coastal", "offshore", "fire", "county"] },
  },
  inputs: { zone_type: "text" },
  inputDocs: { zone_type: "NWS zone type: forecast, county, fire, land, marine, public, coastal, or offshore." },
  options: { state: textOption("Optional uppercase two-letter state filter such as VA.") },
  description:
    "List NWS zone metadata, optionally filtered by state. Index geometry may be absent; use zone(type, id) for a boundary.",
  columns: zoneColumns,
  read: (a, c) => {
    if (a.state && !/^[A-Z]{2}$/.test(String(a.state))) throw new Error("state must be an uppercase two-letter code");
    return page("weather", c || query(`/zones/${zoneType(a)}`, { area: a.state }), zoneRow, "features");
  },
  example: "SELECT zone_id, name FROM nws.main.zones('fire', state := 'VA') ORDER BY zone_id",
  exampleDescription: "Discover Virginia fire-weather zones",
});
const office = reader({
  name: "office",
  inputs: { office_id: "text" },
  description: "Retrieve NWS forecast office contact information and responsible county and forecast zone links.",
  columns: [
    ["office_id", "text", "Office identifier."],
    ["name", "text", "Office name."],
    ["phone", "text", "Public telephone number."],
    ["email", "text", "Public contact email."],
    ["website", "text", "Office website."],
    ["address_json", "text", "Postal address object."],
    ["forecast_zones_json", "text", "Responsible forecast zone links."],
    ["counties_json", "text", "Responsible county links."],
  ],
  read: (a) =>
    page("weather", `/offices/${id(a.office_id, /^[A-Z]{3}$/)}`, (p) => ({
      office_id: str(p.id),
      name: str(p.name),
      phone: str(p.telephone),
      email: str(p.email),
      website: str(p.sameAs),
      address_json: json(p.address),
      forecast_zones_json: json(p.responsibleForecastZones),
      counties_json: json(p.responsibleCounties),
    })),
  example: "SELECT name, website FROM nws.main.office('LWX')",
  exampleDescription: "Find the local forecast office website",
});
const briefingColumns: Col[] = [
  ["office_id", "text", "Issuing office."],
  ["title", "text", "Briefing or story title."],
  ["description", "text", "Published description."],
  ["start_time", "time", "UTC start of applicability."],
  ["end_time", "time", "UTC end of applicability."],
  ["updated_at", "time", "UTC update time."],
  ["download_url", "text", "Published document or image link; content is not downloaded."],
  ["alt_text", "text", "Image alternative text when supplied."],
  ["priority", "number", "Upstream display priority."],
];
function briefing(stories: boolean) {
  const name = stories ? "weather_stories" : "briefing";
  return reader({
    name,
    inputs: { office_id: "text" },
    description: stories
      ? "Read an office's weather story metadata and image download links without downloading binary assets."
      : "Read the current office briefing metadata and document link; no active briefing produces zero rows.",
    columns: briefingColumns,
    read: async (a) => {
      const d = await getJson(
        "weather",
        `/offices/${id(a.office_id, /^[A-Z]{3}$/)}/${stories ? "weatherstories" : "briefing"}`,
      );
      const b = obj(d.body);
      const values = stories ? arr(b.stories) : b.briefing == null ? [] : [b.briefing];
      return {
        rows: values.map((v) => {
          const p = obj(v);
          return {
            office_id: str(p.officeId),
            title: str(p.title),
            description: str(p.description),
            start_time: time(p.startTime),
            end_time: time(p.endTime),
            updated_at: time(p.updateTime),
            download_url: str(p.download),
            alt_text: str(p.altText),
            priority: num(p.priority),
            ...provenance(d),
          };
        }),
      };
    },
    example: `SELECT title, download_url FROM nws.main.${name}('LWX')`,
    exampleDescription: stories
      ? "Find current local weather story graphics"
      : "Find the current local weather briefing document",
  });
}
const glossary = reader({
  name: "glossary",
  category: "reference",
  description: "Search NWS meteorological glossary terms and their published definitions.",
  columns: [
    ["term", "text", "Glossary term."],
    ["definition", "text", "Original definition; may contain HTML markup."],
  ],
  read: () => page("weather", "/glossary", (p) => ({ term: str(p.term), definition: str(p.definition) }), "glossary"),
  example: "SELECT term, definition FROM nws.main.glossary() WHERE term ILIKE '%frost%'",
  exampleDescription: "Look up official frost terminology",
});
export const WEATHER_FUNCTIONS = [
  point,
  alerts,
  alertsAt,
  alert,
  alertTypes,
  stationsAt,
  station,
  observations,
  latestObservation,
  forecast(false),
  forecast(true),
  gridSeries,
  products,
  latestProduct,
  product,
  productTypes,
  productLocations,
  zone,
  zones,
  office,
  briefing(false),
  briefing(true),
  glossary,
];
// Export specifications' structural type for downstream extensions without exposing transport state.
export type { Spec };
