/**
 * Examples and agent tasks that combine several of the worker's functions in one query.
 *
 * Each example is keyed by the function that drives the query (its rows feed the others),
 * so the catalog can publish it on that function and in the schema-level list.
 */

export interface Example {
  description: string;
  sql: string;
}

const FLOOD_HEADROOM: Example = {
  description:
    "Compare the RMDV2 forecast crest with the gauge's flood thresholds: the highest category reached (NULL when below action stage), the next category above the crest, and the feet of headroom left",
  sql: "WITH crest AS (SELECT gauge_id, primary_unit, max(primary_value) AS peak_stage FROM nws.main.stageflow('RMDV2', product := 'forecast') GROUP BY gauge_id, primary_unit) SELECT c.gauge_id, c.peak_stage, c.primary_unit AS unit, max_by(t.category, t.stage) FILTER (WHERE t.stage <= c.peak_stage) AS category_reached, min_by(t.category, t.stage) FILTER (WHERE t.stage > c.peak_stage) AS next_category, min(t.stage) FILTER (WHERE t.stage > c.peak_stage) - c.peak_stage AS headroom FROM crest c JOIN nws.main.flood_thresholds('RMDV2') t ON t.gauge_id = c.gauge_id AND t.stage_unit = c.primary_unit GROUP BY c.gauge_id, c.peak_stage, c.primary_unit ORDER BY c.gauge_id",
};

const NEAREST_CONDITIONS: Example = {
  description:
    "Read the latest observation from the three stations nearest Charlottesville, ranking the point's observation stations by approximate distance in kilometres",
  sql: "SELECT s.station_id, s.name, round(111.2 * sqrt((s.latitude - 38.0293) ^ 2 + ((s.longitude + 78.4767) * cos(radians(38.0293))) ^ 2), 1) AS distance_km, o.observed_at, o.temperature_c, o.wind_speed_m_s FROM nws.main.stations_at(38.0293, -78.4767) s, LATERAL nws.main.latest_observation(s.station_id) o ORDER BY distance_km, s.station_id LIMIT 3",
};

const POINT_OFFICE_ZONE: Example = {
  description:
    "Resolve Charlottesville to the name and website of its forecast office and the name of its forecast zone",
  sql: "SELECT p.office_id, f.name AS office_name, f.website, p.forecast_zone, z.name AS zone_name FROM nws.main.point(38.0293, -78.4767) p, LATERAL nws.main.office(p.office_id) f, LATERAL nws.main.zone('forecast', p.forecast_zone) z ORDER BY p.office_id",
};

/** Composed examples by the name of the main-schema function that drives each query. */
export const COMPOSED_EXAMPLES: Record<string, Example[]> = {
  stageflow: [FLOOD_HEADROOM],
  stations_at: [NEAREST_CONDITIONS],
  point: [POINT_OFFICE_ZONE],
};

/** Agent tasks that need two functions; private graders live in vgi-agent-tests.yaml. */
export const COMPOSED_TASKS: { name: string; prompt: string }[] = [
  {
    name: "composed_minor_flood_headroom",
    prompt:
      "Using the nws worker, how many feet below its minor flood stage is the most recent observed stage at river gauge RMDV2? Save the answer as a table named minor_headroom with one row and one DOUBLE column ft_below_minor (minor flood stage minus the latest observed stage, in the gauge's stage units).",
  },
  {
    name: "composed_major_historic_crests",
    prompt:
      "Using the nws worker, how many of the published historic crests at river gauge RMDV2 reached or exceeded the gauge's current major flood stage? Compare the published crest stages directly with the threshold. Save the answer as a table named major_crests with one row and one BIGINT column crest_count.",
  },
];
