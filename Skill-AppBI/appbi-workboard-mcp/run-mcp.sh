#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Default profile is `all` (the whole journey). Comma-combinable.
PROFILE="${1:-${APPBI_MCP_PROFILE:-all}}"
IFS=',' read -ra _PARTS <<< "${PROFILE}"
for _p in "${_PARTS[@]}"; do
    case "${_p}" in
        all|discover|source|dataset|model|build|deliver) ;;
        *)
            echo "Invalid profile '${_p}'. Use: all, discover, source, dataset, model, build, deliver." >&2
            exit 2
            ;;
    esac
done
export APPBI_MCP_PROFILE="${PROFILE}"

if [[ ! -f .env ]]; then
    echo "Missing .env. Copy .env.example to .env and fill APPBI_BASE_URL + APPBI_PAT first." >&2
    exit 1
fi

if grep -qE '^APPBI_PAT=\s*$' .env || grep -qi 'replace_me' .env; then
    echo "APPBI_PAT in .env is empty or still a placeholder. Edit .env first." >&2
    exit 1
fi

VENV_DIR=".venv"
PYTHON_BIN="${VENV_DIR}/bin/python"

if [[ ! -x "${PYTHON_BIN}" ]]; then
    BOOTSTRAP_PYTHON=""
    for candidate in python3 python python3.12 python3.11 python3.10; do
        if command -v "${candidate}" >/dev/null 2>&1; then
            BOOTSTRAP_PYTHON="${candidate}"
            break
        fi
    done

    if [[ -z "${BOOTSTRAP_PYTHON}" ]]; then
        echo "Could not find Python 3.10+. Install one and re-run." >&2
        exit 1
    fi

    "${BOOTSTRAP_PYTHON}" -m venv "${VENV_DIR}"
    "${PYTHON_BIN}" -m pip install --upgrade pip
    "${PYTHON_BIN}" -m pip install -r requirements.txt
fi

exec "${PYTHON_BIN}" appbi_workboard_mcp.py
