import { type Args, coords } from "./reader.ts";

export type Bounds = [west: number, south: number, east: number, north: number];
export const EARTH_RADIUS_KM = 6371.0088;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** WGS84 bounds; west > east explicitly means crossing the antimeridian. */
export function parseBounds(value: unknown): Bounds[] {
  if (typeof value !== "string" || value.split(",").length !== 4 || value.split(",").some((s) => !s.trim()))
    throw new Error("bbox must be west,south,east,north in decimal degrees");
  const [west, south, east, north] = value.split(",").map(Number);
  if (
    west === undefined ||
    south === undefined ||
    east === undefined ||
    north === undefined ||
    ![west, south, east, north].every(Number.isFinite) ||
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90 ||
    south >= north ||
    west === east
  )
    throw new Error("Invalid bbox bounds");
  if (west < east) return [[west, south, east, north]];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ].filter((b) => b[0] !== b[2]) as Bounds[];
}
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(radians(lat2 - lat1) / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
export function radiusBounds(args: Args): Bounds[] {
  coords(args);
  const latitude = Number(args.latitude),
    longitude = Number(args.longitude),
    radius = Number(args.radius_km);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 500)
    throw new Error("radius_km must be greater than zero and at most 500");
  const angular = radius / EARTH_RADIUS_KM;
  const deltaLat = (angular * 180) / Math.PI;
  const south = Math.max(-90, latitude - deltaLat),
    north = Math.min(90, latitude + deltaLat);
  if (south === -90 || north === 90) return [[-180, south, 180, north]];
  const deltaLon = (Math.asin(Math.sin(angular) / Math.cos(radians(latitude))) * 180) / Math.PI;
  const normalize = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  return parseBounds(`${normalize(longitude - deltaLon)},${south},${normalize(longitude + deltaLon)},${north}`);
}
export interface Tile {
  bounds: Bounds;
  includeEast: boolean;
  includeNorth: boolean;
}
/** Half-open internal edges avoid double-counting gauges returned by adjacent tiles. */
export function tiles(bounds: Bounds[]): Tile[] {
  const result: Tile[] = [];
  for (const [west, south, east, north] of bounds) {
    for (let x = west; x < east; x += 20)
      for (let y = south; y < north; y += 20) {
        const right = Math.min(east, x + 20),
          top = Math.min(north, y + 20);
        result.push({ bounds: [x, y, right, top], includeEast: right === east, includeNorth: top === north });
      }
  }
  return result;
}
export function owns(tile: Tile, lat: number, lon: number): boolean {
  const [w, s, e, n] = tile.bounds;
  return (
    lon >= w &&
    lat >= s &&
    (lon < e || (tile.includeEast && lon === e)) &&
    (lat < n || (tile.includeNorth && lat === n))
  );
}
