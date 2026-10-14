"""The only way this service talks to AppBI.

* Every call runs as the real user, with that user's own delegated PAT.
* Only the `(method, path)` pairs in `ALLOWED_ROUTES` can be called. Anything else
  raises before a request leaves the process. `FORBIDDEN_ROUTES` documents (and
  a test enforces) the live-write / public / credential routes this service must
  never reach.
* A few allowed routes carry body guards: the draft-preserving shape is enforced
  here, once, rather than trusted to each tool.
* Read requests retry once on a transport failure. Writes never retry blindly: a
  write whose outcome is unknown raises `AmbiguousWrite`, and the caller
  reconciles by reading AppBI before doing anything else.
"""

from __future__ import annotations

import logging
import random
import re
import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx2

log = logging.getLogger("appbi_mcp.appbi")

_ID = r"[0-9]+"
_SEG = r"[^/?#]+"


def _route(template: str) -> re.Pattern[str]:
    pattern = re.escape(template).replace(r"\{id\}", _ID).replace(r"\{seg\}", _SEG)
    return re.compile(f"^{pattern}$")


# (method, template). `{id}` = integer id, `{seg}` = one path segment.
ALLOWED_ROUTES: tuple[tuple[str, str], ...] = (
    ("GET", "/auth/me"),
    ("GET", "/health"),
    # data sources — read only
    ("GET", "/datasources/"),
    ("GET", "/datasources/{id}"),
    ("GET", "/datasources/{id}/schema"),
    ("GET", "/datasources/{id}/tables/{seg}/{seg}"),
    # datasets — reads
    ("GET", "/datasets/"),
    ("GET", "/datasets/{id}"),
    ("GET", "/datasets/{id}/model"),
    ("GET", "/datasets/{id}/model/health"),
    ("GET", "/datasets/{id}/publish-status"),
    ("GET", "/datasets/{id}/refresh-runs"),
    ("GET", "/datasets/{id}/dictionary"),
    ("GET", "/datasets/datasources/{id}/tables"),
    ("GET", "/datasets/datasources/{id}/tables/columns"),
    ("POST", "/datasets/{id}/tables/{id}/profile"),
    ("POST", "/datasets/{id}/model/joins/suggestion"),
    ("POST", "/datasets/{id}/model/views/{id}/measures/dry-run"),
    ("POST", "/datasets/{id}/model/views/{id}/measures/preview"),
    # datasets — draft writes
    ("POST", "/datasets/"),
    ("POST", "/datasets/{id}/tables"),
    ("POST", "/datasets/{id}/generate-model"),
    ("POST", "/datasets/{id}/model/joins"),
    ("PUT", "/datasets/{id}/model/views/{id}"),
    # datasets — publish (approval-gated by the caller)
    ("POST", "/datasets/{id}/publish"),
    # charts
    ("GET", "/charts/"),
    ("GET", "/charts/{id}"),
    ("GET", "/charts/{id}/data"),
    ("POST", "/charts/dry-run-create"),
    ("POST", "/charts/"),
    # dashboards — reads, draft writes, publish
    ("GET", "/dashboards/"),
    ("GET", "/dashboards/{id}"),
    ("POST", "/dashboards/"),
    ("POST", "/dashboards/{id}/charts"),
    ("POST", "/dashboards/{id}/widgets"),
    ("PUT", "/dashboards/{id}/draft-filters"),
    ("POST", "/dashboards/{id}/publish"),
    # HTML report import (W4) -- form-encoded; new draft dashboards only (guards below)
    ("GET", "/datasets/{id}/import-skill"),
    ("POST", "/dashboards/import-html/analyze"),
    ("POST", "/dashboards/import-html/validate-plans"),
    ("POST", "/dashboards/import-html/dry-run-build"),
    ("POST", "/dashboards/import-html/build"),
)

# Never reachable. Kept as data so the contract test can assert none of these is
# matched by ALLOWED_ROUTES (spec §5.3).
FORBIDDEN_ROUTES: tuple[tuple[str, str], ...] = (
    ("PUT", "/dashboards/{id}"),
    ("PUT", "/dashboards/{id}/layout"),
    ("DELETE", "/dashboards/{id}"),
    ("DELETE", "/dashboards/{id}/charts/{id}"),
    ("PATCH", "/dashboards/{id}/widgets/{id}"),
    ("POST", "/dashboards/report-starter"),
    ("POST", "/dashboards/{id}/public-links"),
    ("PATCH", "/dashboards/{id}/public-links/{seg}"),
    ("POST", "/dashboards/{id}/discard-draft"),
    ("POST", "/auth/personal-access-tokens/"),
    ("POST", "/datasources/query"),
    ("POST", "/datasources/{id}/test"),
    ("POST", "/datasources/validate-sql"),
    ("PUT", "/charts/{id}"),
    ("DELETE", "/charts/{id}"),
    ("DELETE", "/datasets/{id}"),
    ("POST", "/datasets/{id}/model/joins/batch"),
    ("POST", "/datasets/{id}/tables/{id}/preview"),
    # Last-write-wins with no version (F4): the dictionary is sent at dataset create.
    ("PUT", "/datasets/{id}/dictionary"),
    # HTML import: batch/draft-dataset/AI-fix variants are never used (W4).
    ("POST", "/dashboards/import-html/analyze-batch"),
    ("POST", "/dashboards/import-html/build-batch"),
    ("POST", "/dashboards/import-html/prepare-draft"),
    ("POST", "/dashboards/import-html/fix-chart-plan"),
)

_COMPILED = [(m, _route(t), t) for m, t in ALLOWED_ROUTES]


def match_route(method: str, path: str) -> str | None:
    for m, rx, template in _COMPILED:
        if m == method and rx.match(path):
            return template
    return None


# ── body guards ────────────────────────────────────────────────────────────────


class GuardViolation(ValueError):
    """A request shape that would bypass AppBI's draft or conflict protection."""


def _guard_dashboard_create(body: Any) -> None:
    if not isinstance(body, dict) or body.get("charts"):
        raise GuardViolation("dashboards are created empty; tiles are added as drafts")
    for key in ("pages_config", "filters_config", "slicers_config"):
        if body.get(key):
            raise GuardViolation(f"{key} goes through the draft endpoint, not dashboard create")


def _guard_add_tile(body: Any) -> None:
    layout = body.get("layout") if isinstance(body, dict) else None
    if not isinstance(layout, dict) or layout.get("draftOnly") is not True:
        raise GuardViolation("tiles must be added with layout.draftOnly = true")


def _guard_add_slicer(body: Any) -> None:
    """Only slicer CONTROLS (a filter's on-grid control), only as the caller's draft."""
    _guard_add_tile(body)
    if body.get("widget_type") != "slicer":
        raise GuardViolation("this service only adds slicer controls as widgets")
    cfg = body.get("widget_config")
    if not isinstance(cfg, dict) or not cfg.get("slicerId") or set(cfg) - {"slicerId", "treatment", "origin"}:
        raise GuardViolation("a slicer control carries only slicerId, treatment and origin")


def _guard_draft_filters(body: Any) -> None:
    if not isinstance(body, dict) or not body.get("base_rev"):
        raise GuardViolation("draft-filters writes must carry base_rev")
    if body.get("remove_tile_ids"):
        raise GuardViolation("this service never removes tiles")


def _guard_dashboard_publish(body: Any) -> None:
    if not isinstance(body, dict) or body.get("force"):
        raise GuardViolation("publish is never forced")
    if not isinstance(body.get("tile_base_v"), dict):
        raise GuardViolation("publish must carry tile_base_v for every own tile")


def _guard_join(body: Any) -> None:
    if not isinstance(body, dict) or body.get("force") or body.get("replaces"):
        raise GuardViolation("joins are never forced or used to replace an existing join")


def _guard_view_put(body: Any) -> None:
    if not isinstance(body, dict) or body.get("rename_map"):
        raise GuardViolation("this service never renames semantic fields")
    # A whole-list save without the version it read could silently replace a
    # concurrent edit (F4). AppBI refuses a stale version with 409.
    if not body.get("expected_view_version"):
        raise GuardViolation("semantic view saves must quote expected_view_version")


def _guard_dataset_create(body: Any) -> None:
    if not isinstance(body, dict) or body.get("purpose", "reporting") != "reporting":
        raise GuardViolation("datasets created here are reporting datasets")


def _guard_table_add(body: Any) -> None:
    if not isinstance(body, dict) or body.get("source_kind") != "physical_table":
        raise GuardViolation("only physical tables are added (no SQL tables)")


# ── HTML report import (W4) ─────────────────────────────────────────────────────
#
# These routes take form fields, not JSON. The MCP forwards the user's HTML TEXT to
# AppBI's sanitising importer and nothing else: no files, no browser-built summary,
# no existing dashboard, no wizard draft dataset. It never executes or fetches anything.

MAX_HTML_IMPORT_BYTES = 2 * 1024 * 1024  # AppBI's MAX_HTML_IMPORT_SIZE
IMPORT_PLAN_TAG = re.compile(r"<script[^>]+type\s*=\s*[\"']application/appbi-dashboard[\"'][^>]*>", re.IGNORECASE)
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _true(value: Any) -> bool:
    return value is True or str(value).strip().lower() == "true"


def _form_fields(form: Any, allowed: set[str], route: str) -> dict[str, Any]:
    if not isinstance(form, dict):
        raise GuardViolation(f"{route} takes form fields")
    extra = sorted(set(form) - allowed)
    if extra:
        # Covers file parts (excel_file/excel_files), html_summary_json,
        # target_dashboard_id, prepared_dataset_id, dataset_table_id, ...
        raise GuardViolation(f"{route} does not accept {', '.join(extra)}")
    for key, value in form.items():
        if not isinstance(value, (str, int, bool)):
            raise GuardViolation(f"{route}: field {key!r} must be plain text (no file parts)")
    if form.get("source_mode") != "existing_dataset" and "source_mode" in allowed:
        raise GuardViolation("HTML import only reads an existing dataset (source_mode=existing_dataset)")
    return form


def _guard_import_analyze(form: Any) -> None:
    f = _form_fields(form, {"html_content", "source_mode", "dataset_id"}, "analyze")
    if not f.get("dataset_id"):
        raise GuardViolation("analyze needs a dataset_id")
    html = f.get("html_content")
    if not isinstance(html, str) or not html.strip():
        raise GuardViolation("analyze needs html_content")
    if len(html.encode("utf-8")) > MAX_HTML_IMPORT_BYTES:
        raise GuardViolation("html_content is larger than 2 MB")
    if not IMPORT_PLAN_TAG.search(html):
        raise GuardViolation('html_content must embed an appbi-import/v1 plan in <script type="application/appbi-dashboard">')


def _guard_import_validate(form: Any) -> None:
    f = _form_fields(form, {"analysis_json", "dataset_id"}, "validate-plans")
    if not f.get("analysis_json") or not f.get("dataset_id"):
        raise GuardViolation("validate-plans needs analysis_json and dataset_id")


_BUILD_FIELDS = {"analysis_json", "source_mode", "target_mode", "dashboard_name", "dataset_id",
                 "included_block_ids_json", "strict_fields"}


def _guard_import_build_common(f: dict[str, Any], route: str) -> None:
    if not f.get("dataset_id") or not f.get("analysis_json"):
        raise GuardViolation(f"{route} needs analysis_json and a dataset_id")
    if f.get("target_mode") != "new_dashboard":
        raise GuardViolation(f"{route} only creates a new dashboard (never appends to an existing one)")
    if not str(f.get("dashboard_name") or "").strip():
        raise GuardViolation(f"{route} needs a dashboard_name")
    if not _true(f.get("strict_fields")):
        raise GuardViolation(f"{route} must run with strict_fields=true")


def _guard_import_dry_run(form: Any) -> None:
    _guard_import_build_common(_form_fields(form, _BUILD_FIELDS, "dry-run-build"), "dry-run-build")


def _guard_import_build(form: Any) -> None:
    f = _form_fields(form, _BUILD_FIELDS | {"draft_only", "idempotency_key"}, "build")
    _guard_import_build_common(f, "build")
    if not _true(f.get("draft_only")):
        raise GuardViolation("build must run with draft_only=true")
    if not _IDEMPOTENCY_KEY.match(str(f.get("idempotency_key") or "")):
        raise GuardViolation("build must carry an idempotency_key")


# Routes whose body is form fields; every other route takes JSON.
FORM_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("POST", "/dashboards/import-html/analyze"),
    ("POST", "/dashboards/import-html/validate-plans"),
    ("POST", "/dashboards/import-html/dry-run-build"),
    ("POST", "/dashboards/import-html/build"),
})


BODY_GUARDS: dict[tuple[str, str], Callable[[Any], None]] = {
    ("POST", "/dashboards/import-html/analyze"): _guard_import_analyze,
    ("POST", "/dashboards/import-html/validate-plans"): _guard_import_validate,
    ("POST", "/dashboards/import-html/dry-run-build"): _guard_import_dry_run,
    ("POST", "/dashboards/import-html/build"): _guard_import_build,
    ("POST", "/dashboards/"): _guard_dashboard_create,
    ("POST", "/dashboards/{id}/charts"): _guard_add_tile,
    ("POST", "/dashboards/{id}/widgets"): _guard_add_slicer,
    ("PUT", "/dashboards/{id}/draft-filters"): _guard_draft_filters,
    ("POST", "/dashboards/{id}/publish"): _guard_dashboard_publish,
    ("POST", "/datasets/{id}/model/joins"): _guard_join,
    ("PUT", "/datasets/{id}/model/views/{id}"): _guard_view_put,
    ("POST", "/datasets/"): _guard_dataset_create,
    ("POST", "/datasets/{id}/tables"): _guard_table_add,
}

# Query parameters forbidden on otherwise-allowed routes.
_FORBIDDEN_PARAMS: dict[tuple[str, str], set[str]] = {
    ("PUT", "/datasets/{id}/model/views/{id}"): {"force"},
}


# ── errors ─────────────────────────────────────────────────────────────────────


@dataclass
class AppbiError(Exception):
    status: int
    kind: str                 # unauthorized | forbidden | not_found | conflict | invalid | refused | server | unavailable
    message: str
    detail: Any = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"appbi_status": self.status, "kind": self.kind, "message": self.message}
        if self.detail is not None:
            out["detail"] = self.detail
        return out


class AmbiguousWrite(Exception):
    """The write may or may not have been applied by AppBI (timeout / dropped
    connection after sending). The caller must reconcile by reading."""


class RouteNotAllowed(Exception):
    pass


def _kind_for(status: int) -> str:
    return {
        400: "invalid",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        410: "not_found",
        422: "invalid",
        428: "conflict",
        429: "rate_limited",
    }.get(status, "server" if status >= 500 else "invalid")


def _message_from(payload: Any, fallback: str) -> tuple[str, Any]:
    if isinstance(payload, dict):
        detail = payload.get("detail", payload)
        if isinstance(detail, str):
            return detail, None
        if isinstance(detail, dict):
            msg = detail.get("message") or detail.get("detail") or fallback
            return str(msg), detail
        if isinstance(detail, list):  # FastAPI validation errors
            parts = [f"{'.'.join(str(x) for x in e.get('loc', []))}: {e.get('msg')}" for e in detail if isinstance(e, dict)]
            return "; ".join(parts) or fallback, detail
    return fallback, None


@dataclass
class AppbiClient:
    base_url: str
    pat: str
    request_id: str
    timeout: float = 60.0
    user_agent: str = "appbi-mcp"
    transport: httpx2.AsyncBaseTransport | None = None
    calls: list[dict[str, Any]] = field(default_factory=list)  # (method, template, status) for audit

    def _client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            base_url=self.base_url,
            timeout=httpx2.Timeout(self.timeout, connect=5.0),
            transport=self.transport,
            follow_redirects=False,
            headers={
                **({"Authorization": f"Bearer {self.pat}"} if self.pat else {}),
                "X-Request-ID": self.request_id,
                "Accept": "application/json",
                "User-Agent": self.user_agent,
            },
        )

    async def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None,
                      form: dict[str, Any] | None = None) -> Any:
        method = method.upper()
        template = match_route(method, path)
        if template is None:
            raise RouteNotAllowed(f"{method} {path} is not on the AppBI allowlist")
        is_form = (method, template) in FORM_ROUTES
        if is_form and json is not None or not is_form and form is not None:
            raise GuardViolation(f"{template} takes {'form fields' if is_form else 'a JSON body'}")
        guard = BODY_GUARDS.get((method, template))
        if guard is not None:
            guard(form if is_form else json)
        data = {k: ("true" if v is True else "false" if v is False else str(v)) for k, v in form.items()} if form is not None else None
        for bad in _FORBIDDEN_PARAMS.get((method, template), set()):
            if params and params.get(bad):
                raise GuardViolation(f"query parameter {bad!r} is not allowed on {template}")

        is_read = method == "GET"
        attempts = 2 if is_read else 1
        last_exc: Exception | None = None
        async with self._client() as client:
            for attempt in range(attempts):
                try:
                    resp = await client.request(method, path, params=params, json=json, data=data)
                except httpx2.ConnectError as exc:
                    # Nothing reached AppBI; safe to report (or retry a read).
                    last_exc = exc
                    if attempt + 1 < attempts:
                        await asyncio.sleep(0.3 + random.random() * 0.4)
                        continue
                    raise AppbiError(503, "unavailable", "AppBI is not reachable right now") from exc
                except (httpx2.TimeoutException, httpx2.RemoteProtocolError, httpx2.ReadError) as exc:
                    last_exc = exc
                    if is_read:
                        if attempt + 1 < attempts:
                            await asyncio.sleep(0.3 + random.random() * 0.4)
                            continue
                        raise AppbiError(504, "unavailable", "AppBI did not answer in time") from exc
                    raise AmbiguousWrite(f"{method} {template}: {type(exc).__name__}") from exc
                if is_read and resp.status_code in (502, 503, 504) and attempt + 1 < attempts:
                    await asyncio.sleep(0.3 + random.random() * 0.4)
                    continue
                self.calls.append({"method": method, "route": template, "status": resp.status_code})
                return self._decode(resp)
        raise AppbiError(503, "unavailable", f"AppBI call failed: {type(last_exc).__name__}")

    @staticmethod
    def _decode(resp: httpx2.Response) -> Any:
        payload: Any
        try:
            payload = resp.json() if resp.content else None
        except ValueError:
            payload = None
        if resp.status_code < 300:
            if payload is None and resp.content and resp.headers.get("content-type", "").startswith("text/"):
                return resp.text  # e.g. the dataset's import skill (text/markdown)
            return payload
        message, detail = _message_from(payload, resp.reason_phrase or f"HTTP {resp.status_code}")
        raise AppbiError(resp.status_code, _kind_for(resp.status_code), message, detail)

    async def get(self, path: str, **params: Any) -> Any:
        return await self.request("GET", path, params={k: v for k, v in params.items() if v is not None} or None)

    async def post(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self.request("POST", path, json=body, params={k: v for k, v in params.items() if v is not None} or None)

    async def post_form(self, path: str, form: dict[str, Any]) -> Any:
        return await self.request("POST", path, form=form)

    async def put(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self.request("PUT", path, json=body, params={k: v for k, v in params.items() if v is not None} or None)
