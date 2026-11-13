#!/usr/bin/env python3
"""Run explicit VGI SQL assertions in a disposable DuckDB or Haybarn connection.

Standard-library launcher; the engine child imports the selected engine package.
The parent enforces a deadline and owns the test's process group on POSIX.
"""
from __future__ import annotations

import argparse
import datetime as dt
import decimal
import importlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import tempfile


def read_manifest(project: Path) -> dict:
    spec = json.loads((project / "vgi-worker.json").read_text())
    if spec.get("schema_version") != 1:
        raise ValueError("schema_version must be 1")
    if not isinstance(spec.get("catalog"), str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", spec["catalog"]):
        raise ValueError("catalog must be a SQL identifier (letters, digits, underscores)")
    if not isinstance(spec.get("worker"), list) or not spec["worker"] or not all(isinstance(v, str) and v and "\0" not in v for v in spec["worker"]):
        raise ValueError("worker must be a nonempty argv array of strings")
    if not isinstance(spec.get("checks"), list) or not spec["checks"]:
        raise ValueError("checks must contain at least one SQL assertion")
    for check in spec["checks"]:
        if not isinstance(check, dict) or not isinstance(check.get("sql"), str) or not check["sql"].strip():
            raise ValueError("every check needs SQL")
        if not isinstance(check.get("rows"), list) or not all(isinstance(row, list) for row in check["rows"]):
            raise ValueError("every check needs expected rows as an array of arrays")
        if "columns" in check and (not isinstance(check["columns"], list) or not all(isinstance(v, str) for v in check["columns"])):
            raise ValueError("columns must be an array of names")
    options = spec.get("attach_options", {})
    if not isinstance(options, dict):
        raise ValueError("attach_options must be an object of option name to value")
    for name, value in options.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise ValueError(f"attach option name {name!r} must be a SQL identifier")
        if name.lower() in ("type", "location"):
            raise ValueError(f"attach option {name!r} is set by the verifier")
        if isinstance(value, dict):
            if set(value) != {"env"} or not isinstance(value["env"], str) or not value["env"]:
                raise ValueError(f"attach option {name!r}: use a literal or {{\"env\": \"VARIABLE\"}}")
        elif value is not None and not isinstance(value, (str, int, float, bool)):
            raise ValueError(f"attach option {name!r} must be a string, number, boolean or {{\"env\": ...}}")
        elif value is None:
            raise ValueError(f"attach option {name!r} must not be null; omit it instead")
    return spec


REDACTED = "<redacted>"


def attach_options(spec: dict, environ=os.environ) -> tuple[list[tuple[str, str, str]], list[str]]:
    """Render ATTACH options as (name, sql_literal, display_literal), plus the secret values.

    A value given as {"env": "VAR"} is read from the environment and treated as a
    credential: it never appears in the report. Literals are shown as written.
    """
    rendered, secrets = [], []
    for name, value in spec.get("attach_options", {}).items():
        if isinstance(value, dict):
            variable = value["env"]
            if variable not in environ or environ[variable] == "":
                raise ValueError(f"attach option {name!r} needs environment variable {variable} to be set")
            secret = environ[variable]
            secrets.append(secret)
            rendered.append((name, sql_string(secret), REDACTED))
        else:
            if isinstance(value, bool):
                literal = "true" if value else "false"
            elif isinstance(value, (int, float)):
                literal = repr(value)
            else:
                literal = sql_string(value)
            rendered.append((name, literal, literal))
    return rendered, secrets


def attach_sql(catalog: str, command: str, options: list[tuple[str, str, str]], display: bool = False) -> str:
    parts = ["TYPE vgi", f"LOCATION {sql_string(command)}"]
    parts += [f"{name} {shown if display else literal}" for name, literal, shown in options]
    return f"ATTACH {sql_string(catalog)} AS \"{catalog}\" ({', '.join(parts)});"


def scrub(value, secrets: list[str]):
    """Replace every secret value in a JSON-ready structure, e.g. if an error echoes it."""
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, REDACTED)
        return value
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: scrub(item, secrets) for key, item in value.items()}
    return value


def normalized(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time, decimal.Decimal)):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (list, tuple)):
        return [normalized(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalized(item) for key, item in value.items()}
    return value


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def run_engine(project: Path, engine: str) -> dict:
    module = importlib.import_module(engine)

    spec = read_manifest(project)
    os.chdir(project)
    command = shlex.join(spec["worker"]) if os.name != "nt" else subprocess.list2cmdline(spec["worker"])
    catalog = spec["catalog"]
    options, secrets = attach_options(spec)
    attach = attach_sql(catalog, command, options)
    result = {"status": "failed", "engine": engine, "engine_version": module.__version__, "worker": spec["worker"],
              "attach_sql": attach_sql(catalog, command, options, display=True), "checks": []}
    try:
        return scrub(_run_checks(module, engine, project, spec, catalog, attach, result), secrets)
    except Exception as exc:
        raise RuntimeError(scrub(f"{type(exc).__name__}: {exc}", secrets)) from None


def _run_checks(module, engine: str, project: Path, spec: dict, catalog: str, attach: str, result: dict) -> dict:
    # `project` stays in scope here: wrappers such as examples/agent-github-releases/verify.py
    # patch the connection-config line below and refer to it.
    # Isolate repository registration from the developer's own engine settings.
    repository_dir = tempfile.TemporaryDirectory(prefix="vgi-verifier-repositories-")
    config = {"extension_repository_directory": repository_dir.name} if engine == "duckdb" else {}
    con = module.connect(":memory:", config=config)
    try:
        if engine == "duckdb":
            con.execute("SET allow_extension_repositories = 'allowed';")
            con.execute("CREATE EXTENSION REPOSITORY query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';")
            con.execute("INSTALL vgi FROM query_farm; LOAD vgi FROM query_farm;")
        else:
            con.execute("INSTALL vgi FROM community; LOAD vgi;")
        result["extension_version"] = con.execute("SELECT extension_version FROM duckdb_extensions() WHERE extension_name='vgi'").fetchone()[0]
        result["extension_repository"] = "query_farm" if engine == "duckdb" else "community"
        result["platform"] = con.execute("PRAGMA platform").fetchone()[0]
        con.execute(attach)
        for index, check in enumerate(spec["checks"]):
            item = {"name": check.get("name", f"check-{index + 1}"), "sql": check["sql"], "status": "failed"}
            try:
                cursor = con.execute(check["sql"])
                rows = normalized(cursor.fetchall())
                columns = [column[0] for column in cursor.description]
                item.update(rows=rows, columns=columns)
                if rows != check["rows"]:
                    item["error"] = "Rows differ from expected results"
                    item["expected_rows"] = check["rows"]
                elif "columns" in check and columns != check["columns"]:
                    item["error"] = "Column names differ from expected results"
                    item["expected_columns"] = check["columns"]
                else:
                    item["status"] = "passed"
            except Exception as exc:
                item["error"] = str(exc)
            result["checks"].append(item)
        result["status"] = "passed" if all(item["status"] == "passed" for item in result["checks"]) else "failed"
        con.execute(f'DETACH "{catalog}"')
    finally:
        con.close()
        repository_dir.cleanup()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--engine", choices=["duckdb", "haybarn"], default="duckdb")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--_run", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    start = time.monotonic()
    secrets: list[str] = []
    try:
        if args.timeout <= 0:
            raise ValueError("timeout must be positive")
        project = args.project.resolve()
        spec = read_manifest(project)
        _, secrets = attach_options(spec)  # fail fast, in the parent, on a missing environment variable
        if args._run:
            result = run_engine(project, args.engine)
        else:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--project", str(project), "--engine", args.engine, "--_run"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                start_new_session=os.name != "nt",
            )
            try:
                stdout, stderr = process.communicate(timeout=args.timeout)
                if stderr:
                    print(scrub(stderr, secrets), file=sys.stderr, end="")
                try:
                    result = json.loads(stdout)
                except json.JSONDecodeError:
                    result = {"status": "failed", "error": "Engine runner did not return JSON", "exit_code": process.returncode, "output": stdout[-4000:]}
                if process.returncode and result.get("status") == "passed":
                    result.update(status="failed", error="Engine runner exited unsuccessfully", exit_code=process.returncode)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                result = {"status": "failed", "error": "Verification timed out", "timeout_seconds": args.timeout}
    except Exception as exc:
        result = {"status": "failed", "error": str(exc), "error_type": type(exc).__name__}
    result = scrub(result, secrets)
    result["elapsed_seconds"] = round(time.monotonic() - start, 3)
    encoded = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(encoded)
    print(encoded, end="")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
