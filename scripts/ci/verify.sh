#!/usr/bin/env bash
# Thin wrapper around scripts/ci/verify.py — kept so `bash scripts/ci/verify.sh task`
# (documented in README, scripts/ci/README.md and the Claude rules) still works.
#
# The logic lives in the Python entrypoint because the task-complete gate must not
# depend on a shell: on Windows/VS Code without Git Bash there is no `bash`, and the
# Stop hook's old response to that was to exit 0 — reporting a verified completion
# having verified nothing. Python is already a hard requirement of this repo.
#
#   bash   scripts/ci/verify.sh  fast|task
#   python scripts/ci/verify.py  fast|task     <- identical, no shell needed
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$(command -v python3 || command -v python || true)"

if [ -z "$PY" ]; then
  echo "verify: no python on PATH — verification did NOT run." >&2
  echo "        This is not a pass. Install python or run the checks by hand." >&2
  exit 1
fi

exec "$PY" "$ROOT/scripts/ci/verify.py" "$@"
