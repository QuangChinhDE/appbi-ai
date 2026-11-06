"""OAuth for the Public Read MCP: the author provider's machinery, a different grant.

Reused unchanged from `oauth.provider.AppbiOAuthProvider`: client registration (DCR /
CIMD, redirect allowlist), single-use PKCE codes with replay revocation, rotating
refresh tokens with reuse detection, hashed access tokens bound to the resource.

Different here:
- one scope, `appbi.public.read`;
- authorize hands the browser to the PAIRING page, not to AppBI sign-in: the customer
  types the code their open report shows, which binds this Claude to that ONE viewer
  session (no AppBI account, no PAT);
- a grant's subject is `viewer:<session id>` and it lives no longer than that session.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode

from mcp.server.auth.provider import AuthorizationParams, AuthorizeError, RegistrationError
from mcp.shared.auth import OAuthClientInformationFull

from ..oauth.provider import TXN_TTL, AppbiClient, AppbiOAuthProvider
from ..state import canonical_json, new_id, new_secret, sha256_hex
from .settings import PUBLIC_SCOPE

OFFLINE = "offline_access"


class PublicOAuthProvider(AppbiOAuthProvider):
    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self._check_redirects([str(u) for u in client_info.redirect_uris or []])
        requested = (client_info.scope or "").split()
        unknown = [s for s in requested if s not in (PUBLIC_SCOPE, OFFLINE)]
        if unknown:
            raise RegistrationError("invalid_client_metadata", "unknown scope: " + " ".join(unknown))
        data = client_info.model_dump(mode="json")
        data["scope"] = f"{PUBLIC_SCOPE} {OFFLINE}"
        if "refresh_token" not in (data.get("grant_types") or []):
            data["grant_types"] = list(data.get("grant_types") or []) + ["refresh_token"]
        client = AppbiClient.model_validate(data)
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO clients(client_id, kind, info_json, created_at) VALUES (?, 'dcr', ?, ?)",
                (client.client_id, client.model_dump_json(), time.time()),
            )

    async def _get_cimd_client(self, url: str) -> OAuthClientInformationFull | None:
        """Claude Code and claude.ai identify by a client metadata URL (CIMD). The author
        provider registers such a client with the AUTHOR scopes; here a client may only ever
        hold the public scope (found in the first real Claude Code run: invalid_scope)."""
        client = await super()._get_cimd_client(url)
        if client is not None:
            client.scope = f"{PUBLIC_SCOPE} {OFFLINE}"
        return client

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if not self.resource_matches(params.resource):
            raise AuthorizeError("invalid_target", "resource must be this MCP server's URL: " + self.settings.resource_url)
        txn_id = new_id("ptx")
        binding = new_secret()
        now = time.time()
        payload = {
            "client_id": client.client_id,
            "client_name": client.client_name or "",
            "redirect_uri": str(params.redirect_uri),
            "redirect_explicit": params.redirect_uri_provided_explicitly,
            "state": params.state,
            "scopes": [PUBLIC_SCOPE],
            "code_challenge": params.code_challenge,
            "resource": self.settings.resource_url,
        }
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO auth_txns(id, mode, client_id, params_json, binding_hash, status, created_at, expires_at) "
                "VALUES (?, 'pair', ?, ?, ?, 'pending', ?, ?)",
                (txn_id, client.client_id, canonical_json(payload), sha256_hex(binding), now, now + TXN_TTL),
            )
        return f"{self.settings.issuer}/pair?" + urlencode({"txn": txn_id, "b": binding})

    def create_viewer_grant(self, *, session_id: str, client_id: str, expires_at: float) -> dict[str, Any]:
        now = time.time()
        grant_id = new_id("pgr")
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO grants(id, user_id, user_email, client_id, scopes, appbi_scopes, pat_enc, pat_expires_at, "
                "created_at, expires_at) VALUES (?, ?, '', ?, ?, '{}', ?, NULL, ?, ?)",
                (grant_id, f"viewer:{session_id}", client_id, PUBLIC_SCOPE, self.store.encrypt(""), now,
                 min(expires_at, now + self.settings.grant_max_ttl)),
            )
        return self.active_grant(grant_id) or {}

    def revoke_session_grants(self, session_id: str, reason: str) -> None:
        for row in self.store.query("SELECT id FROM grants WHERE user_id = ? AND revoked_at IS NULL", (f"viewer:{session_id}",)):
            self.revoke_grant(row["id"], reason)

    def grant_pat(self, grant_id: str) -> str | None:  # pragma: no cover - never a PAT here
        return None
