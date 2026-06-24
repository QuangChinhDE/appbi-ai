#!/usr/bin/env bash
# Run once per clone to activate the shared git hooks (pre-push preflight).
# Hooks live in .githooks/ (tracked in the repo) instead of .git/hooks/ so every
# dev gets the same gate without copying files around.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/* scripts/ci/preflight.sh 2>/dev/null || true
echo "✓ core.hooksPath = .githooks"
echo "  Pre-push preflight is now active. Bypass an emergency push with: git push --no-verify"
echo "  Run the same checks manually any time:  bash scripts/ci/preflight.sh"
