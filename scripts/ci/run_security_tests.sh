#!/usr/bin/env bash
# Run backend authorization/security suites in the configuration CI uses:
# pinned dependencies (requirements.txt), ENVIRONMENT=test, and EVERY optional
# module mounted so no security surface is silently absent.
#   PYTHON=/path/to/pinned/python scripts/ci/run_security_tests.sh [pytest args]
set -euo pipefail
cd "$(dirname "$0")/../../backend"
PY="${PYTHON:-python}"
export DATABASE_URL="${DATABASE_URL:-sqlite:///./ci_security.db}"
export PYTHONPATH="$PWD"
export ENVIRONMENT=test
export METADATA_CATALOG_ENABLED=true GOVERN_ENABLED=true WORKBOARDS_ENABLED=true OBSERVABILITY_ENABLED=true
export PYTHONDONTWRITEBYTECODE=1
"$PY" -m pytest -q -p no:cacheprovider "$@"
