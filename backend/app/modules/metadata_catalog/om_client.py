"""
Async HTTP client for the hidden OpenMetadata server.

Only this module knows OM's URL + bot token. Everything else (publisher, api)
goes through here, so OM stays an internal implementation detail.

OM REST conventions used:
  • PUT  /api/v1/<collection>           → create-or-update (idempotent upsert)
  • GET  /api/v1/<collection>/name/<fqn>?fields=... → fetch by FQN
  • GET  /api/v1/search/query?q=...      → search index
  • PUT  /api/v1/lineage                 → add a lineage edge
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("app.metadata_catalog.om")


class OMError(RuntimeError):
    """Raised when OM returns an unexpected status. Carries status + body."""

    def __init__(self, status: int, body: Any):
        super().__init__(f"OpenMetadata returned {status}: {body}")
        self.status = status
        self.body = body


class OpenMetadataClient:
    def __init__(self, base_url: str, bot_token: str, timeout: float = 20.0):
        # base_url e.g. "http://openmetadata-server:8585/api"
        self._base = base_url.rstrip("/")
        self._token = bot_token
        self._timeout = timeout

    @property
    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base, headers=self._headers, timeout=self._timeout)

    # ── Health ────────────────────────────────────────────────────────────
    async def health(self) -> bool:
        """True if OM answers its version endpoint. Never raises."""
        try:
            async with self._client() as c:
                r = await c.get("/v1/system/version")
                return r.status_code == 200
        except Exception as exc:  # network/DNS/down — treat as unhealthy
            logger.warning("OM health check failed: %s", exc)
            return False

    # ── Generic verbs ─────────────────────────────────────────────────────
    async def put(self, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
        """create-or-update an entity. `collection` e.g. 'databaseServices'."""
        async with self._client() as c:
            r = await c.put(f"/v1/{collection}", json=payload)
        if r.status_code not in (200, 201):
            raise OMError(r.status_code, _safe_body(r))
        return r.json()

    async def get_by_fqn(self, collection: str, fqn: str, fields: str = "") -> dict[str, Any] | None:
        params = {"fields": fields} if fields else None
        async with self._client() as c:
            r = await c.get(f"/v1/{collection}/name/{fqn}", params=params)
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise OMError(r.status_code, _safe_body(r))
        return r.json()

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """GET an arbitrary OM API path (e.g. '/v1/classifications'). Raises OMError on non-200."""
        async with self._client() as c:
            r = await c.get(f"/v1{path}" if not path.startswith("/v1") else path, params=params)
        if r.status_code != 200:
            raise OMError(r.status_code, _safe_body(r))
        return r.json()

    async def search(self, query: str, index: str = "table_search_index", size: int = 20) -> dict[str, Any]:
        params = {"q": query or "*", "index": index, "from": 0, "size": size}
        async with self._client() as c:
            r = await c.get("/v1/search/query", params=params)
        if r.status_code != 200:
            raise OMError(r.status_code, _safe_body(r))
        return r.json()

    async def patch(self, collection: str, entity_id: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply a JSON Patch (RFC 6902). OM's create-or-update PUT deliberately
        PRESERVES user-curated fields (displayName/description) so ingestion can't
        clobber manual edits — so editing those fields must go through PATCH."""
        headers = {**self._headers, "Content-Type": "application/json-patch+json"}
        async with httpx.AsyncClient(base_url=self._base, headers=headers, timeout=self._timeout) as c:
            r = await c.patch(f"/v1/{collection}/{entity_id}", json=operations)
        if r.status_code not in (200, 201):
            raise OMError(r.status_code, _safe_body(r))
        return r.json()

    async def delete_by_fqn(self, collection: str, fqn: str, recursive: bool = False, hard: bool = True) -> bool:
        """Delete an entity addressed by FQN. OM deletes by id, so resolve fqn→id first.
        Returns False if the entity does not exist (idempotent delete)."""
        entity = await self.get_by_fqn(collection, fqn)
        if entity is None:
            return False
        params: dict[str, Any] = {"hardDelete": "true" if hard else "false"}
        if recursive:
            params["recursive"] = "true"
        async with self._client() as c:
            r = await c.delete(f"/v1/{collection}/{entity.get('id')}", params=params)
        if r.status_code not in (200, 204):
            raise OMError(r.status_code, _safe_body(r))
        return True

    async def add_lineage(self, edge: dict[str, Any]) -> None:
        """edge = {edge: {fromEntity:{id,type}, toEntity:{id,type}, lineageDetails:{...}}}"""
        async with self._client() as c:
            r = await c.put("/v1/lineage", json=edge)
        if r.status_code not in (200, 201):
            raise OMError(r.status_code, _safe_body(r))


def _safe_body(r: httpx.Response) -> Any:
    try:
        return r.json()
    except Exception:
        return r.text[:500]
