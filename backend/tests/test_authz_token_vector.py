"""The access-domain signing key derivation is a cross-language contract.

frontend/src/middleware.ts verifies access tokens with its own HKDF derivation;
frontend/scripts/check-access-token-domain.mjs checks it against this vector.
If this value changes, both sides must change together.
"""
from app.core import tokens


def test_access_key_vector_matches_the_frontend_contract():
    assert tokens._key(tokens.ACCESS, "authz-token-vector-root") == "3gFG9bdeVV1L10fqsbmYKpgN5n8nN8nFQ-Y-K-Gr6-8="


def test_domains_have_different_keys():
    keys = {tokens._key(d, "same-root") for d in tokens.DOMAINS}
    assert len(keys) == len(tokens.DOMAINS)
