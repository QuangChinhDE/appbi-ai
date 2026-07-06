#!/usr/bin/env bash
# One-time: mint an AppBI Personal Access Token and write it into .env.
# Uses the MCP's .venv (creates it if missing). Extra args pass through to
# bootstrap_pat.py, e.g.:  ./bootstrap-pat.sh --email you@co.vn
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_BIN=".venv/bin/python"
if [[ ! -x "${PYTHON_BIN}" ]]; then
    echo "No .venv yet — creating it and installing dependencies…"
    for candidate in python3 python python3.12 python3.11 python3.10; do
        if command -v "${candidate}" >/dev/null 2>&1; then BOOT="${candidate}"; break; fi
    done
    : "${BOOT:?Could not find Python 3.10+. Install one and re-run.}"
    "${BOOT}" -m venv .venv
    "${PYTHON_BIN}" -m pip install --upgrade pip
    "${PYTHON_BIN}" -m pip install -r requirements.txt
fi

exec "${PYTHON_BIN}" bootstrap_pat.py "$@"
