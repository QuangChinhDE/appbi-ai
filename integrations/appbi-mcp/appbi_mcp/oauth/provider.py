"""OAuth 2.1 authorization-server provider for Claude ↔ AppBI MCP.

The SDK's handlers (`mcp.server.auth.handlers.*`) do request parsing, PKCE
verification, code expiry and client authentication. This provider supplies the
policy and the storage:

* clients: DCR (redirect URIs restricted to the configured allowlist) and CIMD
  (fetched only from allowlisted hosts, SSRF-guarded);
* authorization: hands the browser to the AppBI connect page; the grant is
  created by `routes.appbi_callback` once AppBI has minted the user's PAT;
* codes: single use, 60 s, bound to client, redirect URI, PKCE and resource; a
  replayed code revokes everything it issued;
* refresh tokens: rotated on every use; presenting an already-rotated token
  revokes the whole family (OAuth 2.1 reuse detection for public clients);
* access tokens: opaque, hashed at rest, bound to the canonical resource URI.
"""

from __future__ import annotations

import logging
import time
from typing import Any
from urllib.parse import urlencode, urlparse

from pydantic import AnyUrl
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
)
from mcp.shared.auth import InvalidRedirectUriError, OAuthClientInformationFull, OAuthToken

from ..config import Settings
from ..security import UnsafeUrlError, fetch_client_metadata_document
from ..state import StateStore, canonical_json, new_id, new_secret, sha256_hex
from . import scopes as sc

log = logging.getLogger("appbi_mcp.oauth")

CODE_TTL = 60
TXN_TTL = 600
CIMD_CACHE_SECONDS = 3600
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "[::1]", "::1")


def _is_loopback(uri: str) -> bool:
    p = urlparse(uri)
    return p.scheme == "http" and (p.hostname or "") in LOOPBACK_HOSTS


def _same_ignoring_loopback_port(a: str, b: str) -> bool:
    """RFC 8252 §7.3: a native client's loopback redirect may use any port."""
    pa, pb = urlparse(a), urlparse(b)
    if not (_is_loopback(a) and _is_loopback(b)):
        return False
    return (pa.scheme, pa.hostname, pa.path or "/", pa.query) == (pb.scheme, pb.hostname, pb.path or "/", pb.query)


class AppbiClient(OAuthClientInformationFull):
    """A registered client whose loopback redirects match on any port."""

    def validate_redirect_uri(self, redirect_uri: AnyUrl | None) -> AnyUrl:  # type: ignore[override]
        registered = [str(u) for u in (self.redirect_uris or [])]
        if redirect_uri is None:
            if len(registered) == 1:
                return AnyUrl(registered[0])
            raise InvalidRedirectUriError("redirect_uri must be specified unless the client has exactly one registered URI")
        candidate = str(redirect_uri)
        for reg in registered:
            if candidate == reg or _same_ignoring_loopback_port(candidate, reg):
                return redirect_uri
        raise InvalidRedirectUriError(f"Redirect URI '{candidate}' not registered for client")


class AppbiAuthorizationCode(AuthorizationCode):
    grant_id: str


class AppbiRefreshToken(RefreshToken):
    grant_id: str
    family_id: str


class AppbiAccessToken(AccessToken):
    grant_id: str


class AppbiOAuthProvider:
    def __init__(self, settings: Settings, store: StateStore):
        self.settings = settings
        self.store = store

    # ── redirect policy ──────────────────────────────────────────────────────

    def redirect_allowed(self, uri: str) -> bool:
        if uri in self.settings.redirect_uris:
            return True
        if self.settings.allow_loopback_redirects and _is_loopback(uri):
            return True
        return False

    def _check_redirects(self, uris: list[str]) -> None:
        if not uris:
            raise RegistrationError("invalid_redirect_uri", "at least one redirect_uri is required")
        bad = [u for u in uris if not self.redirect_allowed(u)]
        if bad:
            raise RegistrationError(
                "invalid_redirect_uri",
                "redirect_uri not allowed by this server: " + ", ".join(bad),
            )

    # ── clients ──────────────────────────────────────────────────────────────

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        if client_id.startswith("https://"):
            return await self._get_cimd_client(client_id)
        row = self.store.query_one("SELECT info_json FROM clients WHERE client_id = ? AND kind = 'dcr'", (client_id,))
        return AppbiClient.model_validate_json(row["info_json"]) if row else None

    async def _get_cimd_client(self, url: str) -> OAuthClientInformationFull | None:
        row = self.store.query_one("SELECT info_json, fetched_at FROM clients WHERE client_id = ? AND kind = 'cimd'", (url,))
        if row and row["fetched_at"] and time.time() - row["fetched_at"] < CIMD_CACHE_SECONDS:
            return AppbiClient.model_validate_json(row["info_json"])
        try:
            doc = await fetch_client_metadata_document(url, self.settings.cimd_allowed_hosts)
        except (UnsafeUrlError, ValueError, OSError) as exc:
            log.warning("cimd client rejected: %s (%s)", url, exc)
            return None
        except Exception as exc:  # noqa: BLE001 — network failure means "unknown client", not a crash
            log.warning("cimd fetch failed: %s (%s)", url, type(exc).__name__)
            return None
        redirect_uris = [str(u) for u in doc.get("redirect_uris") or []]
        try:
            self._check_redirects(redirect_uris)
        except RegistrationError as exc:
            log.warning("cimd client %s rejected: %s", url, exc.error_description)
            return None
        auth_method = doc.get("token_endpoint_auth_method") or "none"
        if auth_method != "none":
            # Without a key to verify private_key_jwt this server only serves
            # CIMD clients as public clients (Claude's CIMD client is public).
            log.warning("cimd client %s rejected: token_endpoint_auth_method=%s", url, auth_method)
            return None
        client = AppbiClient.model_validate(
            {
                "client_id": url,
                "client_name": doc.get("client_name"),
                "client_uri": doc.get("client_uri"),
                "logo_uri": doc.get("logo_uri"),
                "redirect_uris": redirect_uris,
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": " ".join(sc.ALL_SCOPES + [sc.OFFLINE_ACCESS]),
            }
        )
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO clients(client_id, kind, info_json, created_at, fetched_at) VALUES (?, 'cimd', ?, ?, ?) "
                "ON CONFLICT(client_id) DO UPDATE SET info_json = excluded.info_json, fetched_at = excluded.fetched_at",
                (url, client.model_dump_json(), now, now),
            )
        return client

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self._check_redirects([str(u) for u in client_info.redirect_uris or []])
        requested = (client_info.scope or "").split()
        # `offline_access` is an AS-level scope (refresh tokens); clients such as
        # Claude add it because the AS metadata lists it. It grants nothing here.
        unknown = [s for s in requested if s not in sc.ALL_SCOPES and s != sc.OFFLINE_ACCESS]
        if unknown:
            raise RegistrationError("invalid_client_metadata", "unknown scope: " + " ".join(unknown))
        data = client_info.model_dump(mode="json")
        if not requested:
            data["scope"] = " ".join(sc.ALL_SCOPES + [sc.OFFLINE_ACCESS])
        if "refresh_token" not in (data.get("grant_types") or []):
            data["grant_types"] = list(data.get("grant_types") or []) + ["refresh_token"]
        client = AppbiClient.model_validate(data)
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO clients(client_id, kind, info_json, created_at) VALUES (?, 'dcr', ?, ?)",
                (client.client_id, client.model_dump_json(), time.time()),
            )

    # ── authorize: hand the browser to AppBI ─────────────────────────────────

    def resource_matches(self, resource: str | None) -> bool:
        if resource is None:
            return True  # bound to this server's canonical URI below
        a, b = urlparse(resource), urlparse(self.settings.resource_url)
        return (a.scheme.lower(), (a.netloc or "").lower(), a.path.rstrip("/"), a.query, a.fragment) == (
            b.scheme.lower(), b.netloc.lower(), b.path.rstrip("/"), "", "",
        )

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if not self.resource_matches(params.resource):
            raise AuthorizeError("invalid_target", "resource must be this MCP server's URL: " + self.settings.resource_url)
        requested = sc.normalize(params.scopes)
        txn_id = new_id("txn")
        binding = new_secret()
        now = time.time()
        payload = {
            "client_id": client.client_id,
            "client_name": client.client_name or "",
            "redirect_uri": str(params.redirect_uri),
            "redirect_explicit": params.redirect_uri_provided_explicitly,
            "state": params.state,
            "scopes": requested,
            "code_challenge": params.code_challenge,
            "resource": self.settings.resource_url,
        }
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO auth_txns(id, mode, client_id, params_json, binding_hash, status, created_at, expires_at) "
                "VALUES (?, 'connect', ?, ?, ?, 'pending', ?, ?)",
                (txn_id, client.client_id, canonical_json(payload), sha256_hex(binding), now, now + TXN_TTL),
            )
        # The binding secret travels once, to /connect/start in THIS browser,
        # which moves it into an httpOnly cookie and drops it from the URL.
        return f"{self.settings.issuer}/connect/start?" + urlencode({"txn": txn_id, "b": binding})

    # ── codes ────────────────────────────────────────────────────────────────

    def issue_code(self, txn: dict[str, Any], grant_id: str, granted_scopes: list[str]) -> str:
        code = new_secret("amcp_ac_")
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO auth_codes(code_hash, grant_id, client_id, scopes, code_challenge, redirect_uri, "
                "redirect_explicit, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    sha256_hex(code), grant_id, txn["client_id"], " ".join(granted_scopes), txn["code_challenge"],
                    txn["redirect_uri"], 1 if txn["redirect_explicit"] else 0, txn["resource"], time.time() + CODE_TTL,
                ),
            )
        return code

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AppbiAuthorizationCode | None:
        row = self.store.query_one("SELECT * FROM auth_codes WHERE code_hash = ?", (sha256_hex(authorization_code),))
        if not row or row["client_id"] != client.client_id:
            return None
        if row["used_at"] is not None:
            # A replayed code: revoke everything the first exchange issued.
            log.warning("authorization code replay; revoking grant %s", row["grant_id"])
            self.revoke_grant(row["grant_id"], "code_replay")
            return None
        return AppbiAuthorizationCode(
            code=authorization_code,
            scopes=row["scopes"].split(),
            expires_at=row["expires_at"],
            client_id=row["client_id"],
            code_challenge=row["code_challenge"],
            redirect_uri=AnyUrl(row["redirect_uri"]),
            redirect_uri_provided_explicitly=bool(row["redirect_explicit"]),
            resource=row["resource"],
            grant_id=row["grant_id"],
        )

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AppbiAuthorizationCode) -> OAuthToken:
        with self.store.transaction() as cur:
            cur.execute(
                "UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
                (time.time(), sha256_hex(authorization_code.code)),
            )
            if cur.rowcount != 1:
                raise TokenError("invalid_grant", "authorization code already used")
        grant = self.active_grant(authorization_code.grant_id)
        if grant is None:
            raise TokenError("invalid_grant", "the AppBI connection behind this code is no longer active")
        return self._issue_pair(grant, client.client_id, authorization_code.scopes, family_id=new_id("fam"))

    # ── tokens ───────────────────────────────────────────────────────────────

    def _issue_pair(self, grant: dict[str, Any], client_id: str, token_scopes: list[str], *, family_id: str) -> OAuthToken:
        now = time.time()
        access = new_secret("amcp_at_")
        refresh = new_secret("amcp_rt_")
        access_exp = min(now + self.settings.access_token_ttl, grant["expires_at"])
        refresh_exp = min(now + self.settings.refresh_token_ttl, grant["expires_at"])
        scope_str = " ".join(token_scopes)
        with self.store.transaction() as cur:
            for tok, kind, exp in ((access, "access", access_exp), (refresh, "refresh", refresh_exp)):
                cur.execute(
                    "INSERT INTO tokens(token_hash, kind, grant_id, family_id, client_id, scopes, resource, created_at, expires_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (sha256_hex(tok), kind, grant["id"], family_id, client_id, scope_str, self.settings.resource_url, now, exp),
                )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=max(1, int(access_exp - now)),
            refresh_token=refresh,
            scope=scope_str,
        )

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> AppbiRefreshToken | None:
        row = self.store.query_one("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'", (sha256_hex(refresh_token),))
        if not row or row["client_id"] != client.client_id or row["revoked_at"] is not None:
            return None
        if row["used_at"] is not None:
            log.warning("refresh token reuse; revoking family %s", row["family_id"])
            self._revoke_family(row["family_id"])
            return None
        if self.active_grant(row["grant_id"]) is None:
            return None
        return AppbiRefreshToken(
            token=refresh_token,
            client_id=row["client_id"],
            scopes=row["scopes"].split(),
            expires_at=int(row["expires_at"]),
            resource=row["resource"],
            grant_id=row["grant_id"],
            family_id=row["family_id"],
        )

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: AppbiRefreshToken, scopes: list[str]) -> OAuthToken:
        with self.store.transaction() as cur:
            cur.execute(
                "UPDATE tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL",
                (time.time(), sha256_hex(refresh_token.token)),
            )
            if cur.rowcount != 1:
                raise TokenError("invalid_grant", "refresh token already used")
            # The old access tokens of this family stop working at rotation.
            cur.execute(
                "UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND kind = 'access' AND revoked_at IS NULL",
                (time.time(), refresh_token.family_id),
            )
        grant = self.active_grant(refresh_token.grant_id)
        if grant is None:
            raise TokenError("invalid_grant", "the AppBI connection is no longer active")
        return self._issue_pair(grant, client.client_id, scopes, family_id=refresh_token.family_id)

    async def load_access_token(self, token: str) -> AppbiAccessToken | None:
        row = self.store.query_one(
            "SELECT t.*, g.user_id, g.user_email FROM tokens t JOIN grants g ON g.id = t.grant_id "
            "WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL "
            "AND g.revoked_at IS NULL AND g.expires_at > ?",
            (sha256_hex(token), time.time()),
        )
        if not row or row["expires_at"] <= time.time():
            return None
        return AppbiAccessToken(
            token=token,
            client_id=row["client_id"],
            scopes=row["scopes"].split(),
            expires_at=int(row["expires_at"]),
            resource=row["resource"],
            subject=row["user_id"],
            claims={"iss": self.settings.issuer, "email": row["user_email"]},
            grant_id=row["grant_id"],
        )

    async def revoke_token(self, token: AppbiAccessToken | AppbiRefreshToken) -> None:
        row = self.store.query_one("SELECT family_id FROM tokens WHERE token_hash = ?", (sha256_hex(token.token),))
        if row:
            self._revoke_family(row["family_id"])

    def _revoke_family(self, family_id: str) -> None:
        with self.store.transaction() as cur:
            cur.execute("UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL", (time.time(), family_id))

    # ── grants ───────────────────────────────────────────────────────────────

    def create_grant(
        self,
        *,
        user_id: str,
        user_email: str,
        client_id: str,
        scopes: list[str],
        appbi_scopes: dict[str, str],
        pat: str,
        pat_expires_at: float | None,
    ) -> dict[str, Any]:
        now = time.time()
        expires = now + self.settings.grant_max_ttl
        if pat_expires_at:
            expires = min(expires, pat_expires_at)
        grant_id = new_id("grt")
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO grants(id, user_id, user_email, client_id, scopes, appbi_scopes, pat_enc, pat_expires_at, "
                "created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (grant_id, user_id, user_email, client_id, " ".join(scopes), canonical_json(appbi_scopes),
                 self.store.encrypt(pat), pat_expires_at, now, expires),
            )
        return self.active_grant(grant_id) or {}

    def active_grant(self, grant_id: str) -> dict[str, Any] | None:
        row = self.store.query_one(
            "SELECT * FROM grants WHERE id = ? AND revoked_at IS NULL AND expires_at > ?", (grant_id, time.time())
        )
        return dict(row) if row else None

    def grant_pat(self, grant_id: str) -> str | None:
        grant = self.active_grant(grant_id)
        if not grant:
            return None
        return self.store.decrypt(grant["pat_enc"])

    def revoke_grant(self, grant_id: str, reason: str) -> None:
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute(
                "UPDATE grants SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL",
                (now, reason, grant_id),
            )
            cur.execute("UPDATE tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL", (now, grant_id))
        log.info("grant %s revoked (%s)", grant_id, reason)
