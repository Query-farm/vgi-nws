# NWS forecast-interval notebook

[01 · Count forecast hours, not compressed rows](01_count_forecast_hours_not_rows.ipynb) clips native temperature validity intervals to a 48-hour UTC window, compares interval counts with elapsed hours, and contrasts equal-row and duration-weighted means. A 5°C→0°C experiment changes only the classification threshold. The recorded forecast concerns Charlottesville, Virginia; it is not an observation, current warning or damage estimate.

## Install and run independently

Requires Python 3.13–3.14, [uv](https://docs.astral.sh/uv/), Git, **Bun 1.3+** (tested 1.3.14), and internet for initial package, Git and extension downloads. No ecCodes installation is needed for this temperature reader.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py
uv run --locked python -m ipykernel install --user --name vgi-nws-notebooks --display-name 'Python (vgi-nws notebooks)'
```

Select that kernel and Restart Kernel → Run All. The runner supplies a fresh temporary kernel and sets this directory as cwd. Copying this entire directory is sufficient; no local worker checkout or root environment is discovered.

The visible literal ATTACH runs `bun run github_worker.ts Query-farm/vgi-nws c672f94632fca2541b805ead4d7f861317fe34e8 src/worker.ts`. That immutable published Git revision retains SDK 0.50.0, RPC 0.29.7 and Arrow 21.1.1 in its frozen Bun lock. At validation, the v0.4.0 binary release was a draft, so this example does not rely on an unpublished asset or npm package. Haybarn is locked to **2.0.0rc11**.

The companion fetches and verifies the full commit, runs `bun install --frozen-lockfile`, and caches by repository, revision and Bun version under `${XDG_CACHE_HOME:-~/.cache}/vgi-notebook-workers`. A bounded lock serializes setup, a complete staging directory is atomically published, and the ready marker is verified before launch. Setup messages stay on stderr; stdout carries Arrow. Worker CLI arguments pass through. No worker source is modified. Revalidate replay, live and the experiment before upgrading the pin.

## Experiment and live retrieval

```sh
uv run --locked python execute.py --parameters '{"TEMPERATURE_THRESHOLD_C":0.0}' --output-dir validation/threshold-0
uv run --locked python execute.py --parameters '{"DATA_MODE":"live"}' --output-dir validation/live
```

Default replay uses threshold 5°C; finite values from −40 through 50°C are accepted. Classification is strictly below; equality belongs to the at-or-above group. The window is `[start, start + 48 hours)`, where start is the first whole UTC hour at or after the grid update. Replay preserves the historical window; live derives a fresh one from the latest response, not a frozen historical request. Live never falls back to recordings. Inherited API-root overrides are cleared, replay sets only the weather root to loopback, and the documented User-Agent identifies the notebook. Cleanup restores prior values.

The runner rejects overrides without a separate destination and rejects unknown names. A failed run preserves the last successful default; successful replacements are atomic. Experiment copies carry fixtures, launcher, helper, branding, documentation and locked environment. Runtime audits, charts and validation copies are ignored; default outputs remain embedded.

## Complete recorded public responses

`fixtures/point.json` and `fixtures/grid.json` are unmodified public NWS JSON responses, captured on **2026-11-14 UTC**. The manifest records the exact retrieval interval, URLs, HTTP status, byte counts (3,924 and 193,508), and SHA-256 hashes. The point resolves `38.0293,-78.4767` to `LWX/51,26`. The grid's update time is **2026-11-14 06:22:53 UTC**; this source timestamp is separate from retrieval time and forecast validity.

`replay_source.py` verifies the hashes and permits only the two exact recorded requests; unexpected requests fail without forwarding. Absolute NWS links inside the recorded point response are preserved and routed through the worker's supported trusted-root override. The real worker parses the actual JSON. The notebook checks all 179 returned temperature intervals against recorded values and independently decoded ISO time intervals.

The worker downloads the complete point and grid documents; a variable selector or SQL LIMIT does not reduce response size. One materialized temperature table supports all local queries and plots. Replay validates exactly two requests. Live HTTP attempts are not instrumented and may retry. The two responses were retrieved sequentially, not as an atomic upstream snapshot; forecast grids and mappings can change.

Official source: [NWS gridpoint FAQ](https://weather-gov.github.io/api/gridpoints) and [NWS API documentation](https://www.weather.gov/documentation/services-web-api). The FAQ describes merged equal values, native units, validity intervals, and NULL values. This is an independent example, not an official NOAA application.

## Interpretation

For the recorded snapshot, the analysis window is **2026-11-14 07:00 UTC through 2026-11-16 07:00 UTC, exclusive**. Each original interval contributes only its overlap. No hourly interpolation is introduced. Positive durations, non-overlap, Celsius units, exact fixture agreement and coverage reconciliation are checked.

The duration-weighted mean divides value-hours by known-temperature hours. Missing values keep their time but do not enter that mean. Uncovered time is separate from missing-value intervals. The ordinary row mean gives compressed intervals equal weight and answers a different question. These rules apply to temperature, not automatically to precipitation accumulations, probabilities or daily extrema. Grid temperature alone does not establish frost damage, local surface conditions or the eventual observed weather.

[Notebook standard](STANDARD.md) · [Query.Farm](https://query.farm/) · [VGI](https://query.farm/vgi/)
