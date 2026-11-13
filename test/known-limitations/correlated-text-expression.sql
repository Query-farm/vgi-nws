-- Reproduced with fixture data on DuckDB 2.0.0 + query_farm VGI e75482339d
-- and Haybarn 2.0.0rc11. ATTACH the worker as nws before running.
-- Direct computed text arguments unexpectedly produce 0 rows; expected 40.
-- The worker receives valid IDs and emits model rows, but the lateral join loses them.
-- The same issue occurs with the existing stageflow reader.
SELECT count(*)
FROM range(40) t(i),
LATERAL nws.main.reach_streamflow(
  CASE WHEN i % 2 = 0 THEN '23021904' ELSE NULL END
) o;

-- Supported workaround, verified in both engines: derive the ID as a column.
-- Expected and actual result: 40.
SELECT count(*)
FROM (
  SELECT CASE WHEN i % 2 = 0 THEN '23021904' ELSE NULL END AS reach_id
  FROM range(40) t(i)
) sites,
LATERAL nws.main.reach_streamflow(sites.reach_id) o;
