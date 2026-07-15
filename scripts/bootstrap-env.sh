#!/usr/bin/env bash
# ============================================================================
# AppBI — .env bootstrap & sync engine
#
# Idempotent. Safe to run on every boot (called by ./run.sh). Does:
#   1. Create .env from .env.example if it doesn't exist.
#   2. Add any NEW keys that appear in .env.example but are missing from .env
#      (using the example's default value) — so pulling code that adds a var
#      never leaves you with a missing-var runtime error.
#   3. Generate real secrets for placeholder values (CHANGE_ME / empty):
#        SECRET_KEY                 -> random 96-hex-char token
#        DATASOURCE_ENCRYPTION_KEY  -> Fernet key (urlsafe base64 of 32 bytes)
#        DB_PASSWORD (local-db only, fresh volume only) -> random 32-hex-char
#        ADMIN_PASSWORD             -> defaults to 123456 (+ loud warning)
#   4. NEVER overwrite a value the user already set (only placeholders/empties).
#   5. Warn about deprecated keys still present (e.g. OpenMetadata leftovers).
#
# Secret-generation SAFETY: SECRET_KEY / DATASOURCE_ENCRYPTION_KEY / DB_PASSWORD
# are only generated when the current value is a placeholder or empty. Once a
# real value exists it is left untouched — regenerating them would log users out
# (SECRET_KEY) or make already-encrypted datasource credentials undecryptable
# (DATASOURCE_ENCRYPTION_KEY) or desync the Postgres volume password (DB_PASSWORD).
# run.sh only sets APPBI_DB_FRESH=1 when the local db volume does not yet exist,
# so a placeholder DB_PASSWORD is regenerated only on a genuinely fresh database.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EX="${ENV_EXAMPLE:-.env.example}"
ENV="${ENV_FILE:-.env}"

[ -f "$EX" ] || { echo "FATAL: $EX not found in $ROOT" >&2; exit 1; }

have(){ command -v "$1" >/dev/null 2>&1; }

# ── secret generators (openssl preferred, python fallback) ──────────────────
rand_hex(){  # $1 = number of random bytes -> 2*N hex chars
  if   have openssl; then openssl rand -hex "$1"
  elif have python3; then python3 -c "import secrets,sys;print(secrets.token_hex(int(sys.argv[1])))" "$1"
  elif have python;  then python  -c "import secrets,sys;print(secrets.token_hex(int(sys.argv[1])))" "$1"
  else echo "FATAL: need 'openssl' or 'python' on PATH to generate secrets" >&2; exit 1; fi
}
gen_fernet(){  # 32 random bytes, urlsafe-base64 encoded == a valid Fernet key
  if   have openssl; then openssl rand -base64 32 | tr '+/' '-_'
  elif have python3 && python3 -c "import cryptography" 2>/dev/null; then
       python3 -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
  else echo "FATAL: need 'openssl' to generate the encryption key" >&2; exit 1; fi
}

# ── tiny .env accessors (no sed — avoids &,/,| corruption in values) ────────
env_has(){ grep -qE "^[[:space:]]*$1=" "$ENV" 2>/dev/null; }
env_get(){ grep -m1 -E "^[[:space:]]*$1=" "$ENV" 2>/dev/null | sed -E "s/^[[:space:]]*$1=//" || true; }
env_set(){  # key value  — replace the KEY= line in-place, or append it
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  if env_has "$k"; then
    awk -v k="$k" -v v="$v" '
      !done && $0 ~ "^[[:space:]]*" k "=" { print k "=" v; done=1; next } { print }
    ' "$ENV" > "$tmp"
  else
    cat "$ENV" > "$tmp"; printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  mv "$tmp" "$ENV"
}

is_placeholder(){  # empty OR CHANGE_ME* OR the compose fallback literal
  local v="$1"
  [ -z "$v" ] || [[ "$v" == CHANGE_ME* ]] || [ "$v" = "change-this-in-production" ]
}

# ── 1. create if missing ────────────────────────────────────────────────────
created=0
if [ ! -f "$ENV" ]; then
  cp "$EX" "$ENV"; created=1
  echo "  [env] created .env from .env.example"
fi

# snapshot to detect whether we changed anything (for a single backup)
orig="$(mktemp)"; cp "$ENV" "$orig"

# ── 2. add keys present in .env.example but missing from .env ───────────────
added=()
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
  key="${BASH_REMATCH[1]}"
  if ! env_has "$key"; then
    printf '%s\n' "$line" >> "$ENV"      # append verbatim (keeps example default)
    added+=("$key")
  fi
done < "$EX"

# ── 3. generate secrets for placeholder values ─────────────────────────────
generated=()
if is_placeholder "$(env_get SECRET_KEY)"; then
  env_set SECRET_KEY "$(rand_hex 48)";              generated+=("SECRET_KEY")
fi
if is_placeholder "$(env_get DATASOURCE_ENCRYPTION_KEY)"; then
  env_set DATASOURCE_ENCRYPTION_KEY "$(gen_fernet)"; generated+=("DATASOURCE_ENCRYPTION_KEY")
fi
# DB_PASSWORD: only for the bundled local-db, only on a fresh volume, only if placeholder.
if [ -z "$(env_get DATABASE_URL)" ] \
   && [ "${APPBI_DB_FRESH:-0}" = "1" ] \
   && is_placeholder "$(env_get DB_PASSWORD)"; then
  env_set DB_PASSWORD "$(rand_hex 16)";             generated+=("DB_PASSWORD")
fi

# ── 4. admin password: keep a KNOWN value so the user can actually log in ───
admin_defaulted=0
if is_placeholder "$(env_get ADMIN_PASSWORD)"; then
  env_set ADMIN_PASSWORD "123456"; admin_defaulted=1
fi

# ── 4b. modules ON by default — force product-module flags to true ─────────
# Per project policy: after `run`, every product module is enabled. This
# OVERRIDES an existing false (unlike secrets, which are preserved). Datasource
# sync is intentionally NOT here — it's a data-fetch mode, not a nav module.
MODULE_FLAGS="WORKBOARDS_ENABLED NEXT_PUBLIC_WORKBOARDS_ENABLED METADATA_CATALOG_ENABLED GOVERN_ENABLED OBSERVABILITY_ENABLED"
modules_on=()
for mf in $MODULE_FLAGS; do
  if [ "$(env_get "$mf")" != "true" ]; then env_set "$mf" "true"; modules_on+=("$mf"); fi
done

# ── 5. deprecated-key warnings (removed subsystems) ─────────────────────────
deprecated=()
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
  k="${BASH_REMATCH[1]}"
  case "$k" in
    OPENMETADATA_*|OM_JWT_*|OM_*) deprecated+=("$k");;
  esac
done < "$ENV"

# ── backup only if we changed an EXISTING user file (not a fresh create) ────
if [ "$created" = "0" ] && ! cmp -s "$orig" "$ENV"; then
  bak=".env.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$orig" "$bak"
  echo "  [env] previous .env backed up -> $bak"
fi
rm -f "$orig"

# ── report ──────────────────────────────────────────────────────────────────
[ ${#added[@]}     -gt 0 ] && echo "  [env] added missing keys: ${added[*]}"
[ ${#generated[@]} -gt 0 ] && echo "  [env] generated secrets:  ${generated[*]}"
[ ${#modules_on[@]} -gt 0 ] && echo "  [env] modules forced ON:  ${modules_on[*]}"
if [ "$admin_defaulted" = "1" ]; then
  echo "  [env] WARNING: ADMIN_PASSWORD was a placeholder -> defaulted to '123456'. Change it in .env for production."
fi
if [ ${#deprecated[@]} -gt 0 ]; then
  echo "  [env] WARNING: deprecated keys still in .env (safe to remove): ${deprecated[*]}"
fi
if [ "$created" = "0" ] && [ ${#added[@]} -eq 0 ] && [ ${#generated[@]} -eq 0 ] && [ ${#modules_on[@]} -eq 0 ]; then
  echo "  [env] .env already in sync"
fi
exit 0
