#!/usr/bin/env bash
# ============================================================
# Generate prod secrets for the hidden OM stack:
#   • RSA keypair (PKCS8 DER) for JWT signing → secrets/jwt/{private,public}_key.der
#   • Strong DB password + JWT key id → written into open-metadata/.env
#
# Secrets land ONLY in gitignored locations (.env, secrets/). Never printed.
# Re-running regenerates everything (rotates keys + password).
#
#   bash open-metadata/gen-secrets.sh
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

command -v openssl >/dev/null || { echo "ERROR: openssl not found on PATH"; exit 1; }

mkdir -p secrets/jwt
chmod 700 secrets secrets/jwt 2>/dev/null || true

echo "→ Generating RSA keypair (PKCS8 DER) for JWT signing…"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out secrets/jwt/private_key.pem 2>/dev/null
openssl pkcs8 -topk8 -inform PEM -outform DER -in secrets/jwt/private_key.pem -out secrets/jwt/private_key.der -nocrypt
openssl rsa -in secrets/jwt/private_key.pem -pubout -outform DER -out secrets/jwt/public_key.der 2>/dev/null
rm -f secrets/jwt/private_key.pem
chmod 600 secrets/jwt/*.der 2>/dev/null || true

DB_PW="$(openssl rand -hex 24)"
KEY_ID="$(openssl rand -hex 4)-$(openssl rand -hex 2)-$(openssl rand -hex 2)-$(openssl rand -hex 2)-$(openssl rand -hex 6)"

echo "→ Writing open-metadata/.env from .env.example…"
[ -f .env ] || cp .env.example .env

# Substitute the two secret lines in place (portable sed).
sed -i.bak \
  -e "s|^OM_DB_PASSWORD=.*|OM_DB_PASSWORD=${DB_PW}|" \
  -e "s|^OM_JWT_KEY_ID=.*|OM_JWT_KEY_ID=${KEY_ID}|" \
  .env
rm -f .env.bak

echo "✓ Done."
echo "  • secrets/jwt/private_key.der, public_key.der  (gitignored)"
echo "  • open-metadata/.env updated with OM_DB_PASSWORD + OM_JWT_KEY_ID  (gitignored)"
echo "  • Remember to set OPENMETADATA_VERSION in .env to a verified STABLE tag."
