"""Run the MCP integration's offline test suite in its OWN virtualenv.

The service pins a dependency set (mcp 2.x, starlette 1.x, pydantic 2.14) that is
incompatible with the backend's, so it is never installed into the interpreter
that runs backend tests. This script creates/reuses `integrations/appbi-mcp/.venv`,
installs the hash-locked runtime requirements plus the test tools, and runs pytest.

Used by `scripts/ci/verify.py` (guardrail test `mcp_integration_offline`) and by
`.github/workflows/mcp-integration.yml`, so local and CI runs are the same command.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv"
TEST_TOOLS = ["pytest==8.4.2", "pytest-asyncio==1.2.0"]


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_venv() -> Path:
    py = venv_python()
    stamp = VENV / ".requirements.lock.installed"
    lock = (ROOT / "requirements.lock").read_bytes()
    if py.exists() and stamp.exists() and stamp.read_bytes() == lock:
        return py
    if not py.exists():
        venv.EnvBuilder(with_pip=True, clear=False).create(VENV)
    uv = shutil.which("uv")

    def install(*args: str) -> None:
        if uv:  # faster, and works in venvs created without pip
            subprocess.run([uv, "pip", "install", "-q", "--python", str(py), *args], check=True)
            return
        if subprocess.run([str(py), "-m", "pip", "--version"], capture_output=True).returncode != 0:
            subprocess.run([str(py), "-m", "ensurepip", "--upgrade"], check=True, capture_output=True)
        subprocess.run([str(py), "-m", "pip", "install", "-q", "--disable-pip-version-check", *args], check=True)

    install("--require-hashes", "--no-deps", "-r", str(ROOT / "requirements.lock"))
    install(*TEST_TOOLS)
    stamp.write_bytes(lock)
    return py


def main() -> int:
    if sys.version_info[:2] != (3, 12) and not os.environ.get("APPBI_MCP_ANY_PYTHON"):
        # The image runs 3.12; testing on another minor version proves less.
        print(f"note: running with Python {sys.version.split()[0]} (service targets 3.12)", file=sys.stderr)
    py = ensure_venv()
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    return subprocess.run([str(py), "-m", "pytest", "-q", *sys.argv[1:]], cwd=ROOT, env=env).returncode


if __name__ == "__main__":
    sys.exit(main())
