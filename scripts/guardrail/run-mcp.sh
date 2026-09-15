#!/usr/bin/env bash
# AppBI Engineering Guardrail MCP launcher (bash).
# Read-only analyzer — no .env / PAT needed. Optionally export APPBI_REPO_ROOT if
# the AppBI repo is not two directories above this script.
set -euo pipefail
cd "$(dirname "$0")"

: "${APPBI_REPO_ROOT:=$(cd ../.. && pwd)}"
export APPBI_REPO_ROOT

VENV_DIR=".venv"
PYTHON_BIN="${VENV_DIR}/bin/python"

if [[ ! -x "${PYTHON_BIN}" ]]; then
    BOOTSTRAP=""
    for c in python3 python python3.12 python3.11 python3.10; do
        if command -v "$c" >/dev/null 2>&1; then BOOTSTRAP="$c"; break; fi
    done
    [[ -z "$BOOTSTRAP" ]] && { echo "Python 3.10+ not found." >&2; exit 1; }
    "$BOOTSTRAP" -m venv "$VENV_DIR"
    "$PYTHON_BIN" -m pip install --upgrade pip >/dev/null
    "$PYTHON_BIN" -m pip install -r requirements.txt
fi

exec "$PYTHON_BIN" appbi_guardrail_mcp.py
