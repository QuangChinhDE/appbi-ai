#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# merge-env.sh — Safely merge new vars from .env.example → .env
#
# What it does:
#   1. Keeps ALL existing values in .env untouched
#   2. Appends vars that exist in .env.example but NOT in .env
#   3. Removes vars from .env that no longer exist in .env.example
#   4. Shows a summary of what changed
#
# Usage:
#   bash scripts/merge-env.sh              # default: .env.example → .env
#   bash scripts/merge-env.sh .env.google.example .env   # custom source
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SOURCE="${1:-.env.example}"
TARGET="${2:-.env}"

# Navigate to repo root (parent of scripts/)
cd "$(dirname "$0")/.."

if [ ! -f "$SOURCE" ]; then
  echo "ERROR: $SOURCE not found"; exit 1
fi

# If .env doesn't exist yet, just copy from example
if [ ! -f "$TARGET" ]; then
  cp "$SOURCE" "$TARGET"
  echo "Created $TARGET from $SOURCE (first-time setup)"
  exit 0
fi

# ── Extract KEY names (ignore comments, blank lines, and commented-out vars) ──
extract_keys() {
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | cut -d= -f1 | sort -u
}

SOURCE_KEYS=$(extract_keys "$SOURCE")
TARGET_KEYS=$(extract_keys "$TARGET")

# ── Find NEW keys (in source but not in target) ──
NEW_KEYS=$(comm -23 <(echo "$SOURCE_KEYS") <(echo "$TARGET_KEYS"))

# ── Find REMOVED keys (in target but not in source) ──
REMOVED_KEYS=$(comm -13 <(echo "$SOURCE_KEYS") <(echo "$TARGET_KEYS"))

# ── Nothing to do? ──
if [ -z "$NEW_KEYS" ] && [ -z "$REMOVED_KEYS" ]; then
  echo "✓ $TARGET is already up to date with $SOURCE"
  exit 0
fi

# ── Backup ──
BACKUP="${TARGET}.bak.$(date +%Y%m%d%H%M%S)"
cp "$TARGET" "$BACKUP"
echo "Backup: $BACKUP"

# ── Add new keys ──
ADDED_COUNT=0
if [ -n "$NEW_KEYS" ]; then
  echo ""
  echo "── Adding new variables ──"
  # Add a separator in the .env
  echo "" >> "$TARGET"
  echo "# ── Merged from $SOURCE on $(date +%Y-%m-%d) ──" >> "$TARGET"

  while IFS= read -r key; do
    # Get default value from source (first occurrence)
    default_line=$(grep -m1 "^${key}=" "$SOURCE")
    default_val="${default_line#*=}"
    echo "${key}=${default_val}" >> "$TARGET"
    echo "  + ${key}=${default_val}"
    ADDED_COUNT=$((ADDED_COUNT + 1))
  done <<< "$NEW_KEYS"
fi

# ── Warn about removed keys (don't auto-delete — safer) ──
REMOVED_COUNT=0
if [ -n "$REMOVED_KEYS" ]; then
  echo ""
  echo "── Variables in $TARGET but NOT in $SOURCE (may be obsolete) ──"
  while IFS= read -r key; do
    echo "  ? ${key}"
    REMOVED_COUNT=$((REMOVED_COUNT + 1))
  done <<< "$REMOVED_KEYS"
  echo ""
  echo "These were NOT auto-removed. Delete manually if no longer needed."
fi

echo ""
echo "Summary: +${ADDED_COUNT} added, ${REMOVED_COUNT} possibly obsolete"
echo "Review $TARGET then run: docker compose up -d --build"
