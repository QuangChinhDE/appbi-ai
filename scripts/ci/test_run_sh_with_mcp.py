"""`run.sh --with-mcp`: the local edge overlay contract (spec W5).

Executes the real `run.sh` against a stub `docker` that records every call, and asserts:

- without the flag nothing changes: no edge overlay, no MCP project;
- with the flag Core is started WITH docker-compose.edge.yml (so the frontend never
  takes the browser port back), and the MCP project is started after Core with an
  EMPTY env file (Core's .env is never read for the MCP);
- a missing MCP_PUBLIC_URL / MCP_STATE_KEY stops it before any container starts;
- a missing MCP ingress network is created with the appbi-mcp project's labels, so
  `docker compose -p appbi-mcp` adopts it instead of refusing it.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="needs bash to execute run.sh")

STUB_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"--version"*) echo "Docker version 99.0.0, build stub"; exit 0;;
  "network inspect"*) [ -n "${STUB_NET_EXISTS:-}" ] && exit 0 || exit 1;;
esac
exit 0
"""


@pytest.fixture()
def world(tmp_path: pathlib.Path):
    work = tmp_path / "work"
    work.mkdir()
    subprocess.run(["git", "init", "-q", str(work)], check=True)
    shutil.copy(REPO / "run.sh", work / "run.sh")
    (work / "scripts").mkdir()
    (work / "scripts" / "bootstrap-env.sh").write_text("exit 0\n", encoding="utf-8")
    stub = tmp_path / "stub"
    stub.mkdir()
    (stub / "docker").write_text(STUB_DOCKER, encoding="utf-8", newline="\n")
    (stub / "docker").chmod(0o755)
    return {"tmp": tmp_path, "work": work, "stub": stub}


def _run(world, *flags: str, env_extra: dict | None = None):
    log = world["tmp"] / "docker.log"
    log.unlink(missing_ok=True)
    env = dict(os.environ)
    for k in ("MCP_PUBLIC_URL", "MCP_STATE_KEY", "APPBI_PUBLIC_URL", "GIT_SHA",
              "APPBI_MCP_INGRESS_NETWORK", "STUB_NET_EXISTS"):
        env.pop(k, None)
    env["PATH"] = str(world["stub"]) + os.pathsep + env["PATH"]
    env["STUB_LOG"] = str(log)
    env.update(env_extra or {})
    out = subprocess.run([BASH, "run.sh", "--skip-validate", "--no-build", *flags],
                         cwd=world["work"], capture_output=True, text=True, env=env, timeout=120)
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return out, calls


def _ups(calls):
    return [c for c in calls if c.startswith("compose") and " up " in f"{c} "]


MCP_ENV = {"MCP_PUBLIC_URL": "http://localhost:3000", "MCP_STATE_KEY": "k"}


def test_default_is_unchanged(world):
    out, calls = _run(world)
    assert out.returncode == 0, out.stdout[-800:] + out.stderr[-800:]
    ups = _ups(calls)
    assert len(ups) == 1
    assert "docker-compose.edge.yml" not in ups[0] and "appbi-mcp" not in ups[0]
    assert not any(c.startswith("network ") for c in calls)


def test_with_mcp_applies_overlay_then_starts_mcp_without_core_env(world):
    out, calls = _run(world, "--with-mcp", env_extra={**MCP_ENV, "STUB_NET_EXISTS": "1"})
    assert out.returncode == 0, out.stdout[-800:] + out.stderr[-800:]
    ups = _ups(calls)
    assert len(ups) == 2, ups
    core, mcp = ups
    assert "-f docker-compose.yml -f docker-compose.edge.yml" in core
    assert "-p appbi-mcp" not in core
    assert "-p appbi-mcp" in mcp and "-f docker-compose.mcp.yml" in mcp
    env_file = mcp.split("--env-file ", 1)[1].split(" ", 1)[0]
    assert not env_file.endswith(".env"), f"MCP must not read Core's .env: {mcp}"
    assert not any(c.startswith("network create") for c in calls)


def test_with_mcp_refuses_without_operator_env(world):
    out, calls = _run(world, "--with-mcp", env_extra={"STUB_NET_EXISTS": "1"})
    assert out.returncode != 0
    assert "MCP_PUBLIC_URL" in out.stdout and "MCP_STATE_KEY" in out.stdout
    assert _ups(calls) == [], "nothing may start when the MCP configuration is missing"


def test_with_mcp_creates_missing_ingress_network_owned_by_mcp_project(world):
    out, calls = _run(world, "--with-mcp", env_extra=MCP_ENV)
    assert out.returncode == 0, out.stdout[-800:] + out.stderr[-800:]
    creates = [c for c in calls if c.startswith("network create")]
    assert len(creates) == 1
    c = creates[0]
    assert "com.docker.compose.project=appbi-mcp" in c
    assert "com.docker.compose.network=mcp-ingress" in c
    assert c.endswith(" appbi-mcp-ingress")
    assert calls.index(c) < calls.index(_ups(calls)[0]), "network must exist before Core starts"


def test_with_mcp_down_stops_mcp_then_core_with_overlay(world):
    out, calls = _run(world, "--with-mcp", "--down")
    assert out.returncode == 0, out.stdout[-800:] + out.stderr[-800:]
    downs = [c for c in calls if c.startswith("compose") and c.endswith(" down")]
    assert len(downs) == 2, downs
    assert "-p appbi-mcp" in downs[0]
    assert "docker-compose.edge.yml" in downs[1]
