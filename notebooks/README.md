# National Weather Service notebooks

Read the executed notebooks on GitHub, or use each **Open in Colab** button and Run All.
Each notebook is independent. Visible SQL retrieves and transforms data through the real
published NWS worker; Python presents results and checks invariants.

| Notebook | Question | Default → experiment |
|---|---|---|
| [01 · Count forecast hours, not rows](01_count_forecast_hours_not_rows.ipynb) | How do compressed intervals change a threshold-duration calculation? | Temperature cutoff 5 → 0 °C |
| [02 · A nearby station can still be stale](02_a_nearby_station_can_still_be_stale.ipynb) | Which station passes a fixed observation-age rule, and which forecast product supplies context? | Age limit 1 → 4 hours |
| [03 · An update is not an extra hazard](03_an_update_is_not_an_extra_hazard.ipynb) | How do explicit message references and product/text links change what a row count means? | Retain referenced predecessor False → True |
| [04 · Nearby gauges are not a river network](04_nearby_gauges_are_not_a_river_network.ipynb) | Which geographic candidates are connected, and which stage comparisons retain valid units/datum qualifiers? | Search radius 25 → 50 km |
| [05 · A short rating is not a complete curve](05_a_short_rating_is_not_a_complete_curve.ipynb) | What does a rating limit omit, and why are model members and their mean not additive? | Rating limit 2 → 8 |
| [06 · Overlapping products are not a common score](06_overlapping_products_are_not_a_common_score.ipynb) | How do generic features and four typed product vocabularies preserve distinct meanings? | Site inner → edge |

## Data and interpretation

**01 uses an actual historical forecast recording**, preserving the original complete
NOAA point and grid response bytes in `fixtures/`. The manifest records acquisition on
2026-11-14 UTC, public URLs, byte counts and SHA-256 hashes. It is a forecast snapshot,
not observations, a current warning, or a synthetic temperature series. The default
replays only those two requests on loopback with no remote fallback. The original
interval narrative and analytical SQL are retained; an independent standard-library
ISO-duration decoder checks the recording, and a new SQL interval-utility check
reconciles the worker reader with the same bytes.

**02–06 use explicitly synthetic NOAA-shaped teaching inputs** in `synthetic/`, created
from repository test payload shapes and hand-authored values. They do not represent
actual weather, alerts, river conditions, polygons or model forecasts. The fixed
scenario clock is 2026-01-02 12:00 UTC. `scenario_source.py` verifies fixture hashes,
serves only loopback, confines all ten worker API roots to that service and rejects
unknown requests. Its one POST route is a read-only river-summary query over the fake
RMDV2 gauge, not an account mutation. Canonical NOAA `source_url` fields emitted by the
worker identify product routes even in fixture mode; they are not proof of live access.
`fetched_at` is local retrieval time. The synthetic files and the original raw recordings
have separate manifests and are never silently substituted for one another.

The stories preserve missing values, observation/forecast distinctions, native units,
message identifiers, datum flags and product-specific categories. They do not establish
warning validity, forecast calibration, station quality, water availability or a combined
hazard probability. Comparisons between `main` and positional-JSON `compat` interfaces
verify equivalent business values from the same source, not independent confirmation.

## Portable setup

The short visible launcher is:

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'nws' (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-nws@v0.4.0');
```

The native release is downloaded for a supported platform; no Bun runtime, local worker
checkout, source build or ecCodes installation is needed for these six stories.
The pinned [shared tools v0.3.40](https://github.com/Query-farm/vgi-example-notebooks/tree/v0.3.40)
provide branding, SVG presentation, the atomic runner and companion download/hash checks.
`prepare("nws")` retrieves seven immutable public files if only the notebook is present.
The base install is compatible with supported preloaded plotting/kernel libraries;
local publication adds the optional `[runner]` extra. Initial packages, companions,
community extension and worker download require internet. A fresh Python 3.12 execution
with preloaded pandas/Matplotlib/IPython/kernel packages passed without changing their
versions. Actual hosted Colab was not tested.

From this directory:

```sh
uv sync --locked --extra runner
uv run --locked --extra runner vgi-notebooks
uv run --locked --extra runner jupyter lab
```

Choose the notebook environment's Python kernel. Shared setup creates an empty temporary
SQL-secret directory, disables persistent secrets and JupySQL default-INI autoload, and
sets UTC at connection creation for every cursor. Cleanup verifies the empty secret
inventory, closes the SQL session/service and restores scoped environment settings.
No credentials or real-account operations are required.

Run experiments into separate destinations, for example:

```sh
uv run --locked --extra runner vgi-notebooks 02_a_nearby_station_can_still_be_stale.ipynb \
  --parameters '{"MAX_AGE_HOURS":4}' --output-dir validation/age-4
uv run --locked --extra runner vgi-notebooks 06_overlapping_products_are_not_a_common_score.ipynb \
  --parameters '{"SITE":"edge"}' --output-dir validation/edge
```

The runner rejects overrides without a separate destination and preserves the last
successful default/experiment if a run fails. `artifacts/` and `validation/` are ignored.
Native SVG outputs remain embedded; content-addressed SVG assets in `charts/` provide
GitHub's verified image-link rendering. There is no per-repository runner or styling fork.
See the [shared standard](https://github.com/Query-farm/vgi-example-notebooks/blob/v0.3.40/docs/standard.md).

## Optional actual live forecast

Only 01 exposes a live mode. It clears inherited API-root overrides and queries the
public NOAA point/grid endpoints directly, with no key and no fallback. A new forecast
may change its window and values; the utility section still inspects the frozen reference
and labels that distinction. Service errors remain visible. Use a separate output:

```sh
uv run --locked --extra runner vgi-notebooks 01_count_forecast_hours_not_rows.ipynb \
  --parameters '{"DATA_MODE":"live"}' --output-dir validation/live
```

Books 02–06 intentionally have no live switch: their fixed populations and synthetic
invariants are part of the teaching scenario. Running those stories against live data
would require a new acquisition design and domain review, not renaming a mode.

## Coverage and validation

[coverage.json](coverage.json) maps meaningful visible SQL, narrative and interpreted
results to final execution receipts. Both complete actual catalogs contain **129 logical
names: 92 main + 37 compat**, including all unshown surfaces; no physical tables or views
were returned. **65/129 (50.39%)** are demonstrated across the six stories, satisfying the
larger-worker threshold. All 65 have exact **v0.4.0** execution evidence. Current public
main at `33c9bc9` has the same signatures and domain implementation, with catalog metadata
and composed-example changes; its separate interface coverage does not claim current
source execution of the analytical notebooks. The 64 uncovered names remain explicit.

All six defaults and six parameter experiments passed, with two reviewed SVG figures per
story, empty-secret/UTC checks, independent source/identity controls and atomic runner
guards. The existing source CI at `33c9bc9` passed its typecheck/unit, formatting,
metadata, image-smoke and SQL-transport jobs:
[run 43613113092](https://github.com/Query-farm/vgi-nws/actions/runs/43613113092).
No worker build or source suite was repeated for this notebook-only change. An older
nightly at `a6a2244` failed six MRMS checks because ecCodes `grib_ls` was missing; that is
separate from the green current source CI and from these non-MRMS notebooks.
