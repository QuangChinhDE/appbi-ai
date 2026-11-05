"""The MCP may only call AppBI routes that exist, and never the forbidden ones.

The removed stdio MCP drifted silently (a PATCH route that never existed, query
params FastAPI dropped). This test reads the backend's route table from source,
so a rename or removal on the AppBI side fails the MCP's CI instead of a user's
tool call.
"""

from __future__ import annotations

import pytest

from appbi_mcp import appbi_client as ac

from .backend_routes import backend_routes, normalise


@pytest.fixture(scope="module")
def routes() -> set[tuple[str, str]]:
    found = backend_routes()
    # Guard against the parser silently finding nothing (that would make every
    # assertion below vacuous).
    assert len(found) > 150, f"route scan found only {len(found)} routes"
    return found


def _norm(template: str) -> str:
    return normalise(template.replace("{id}", "{x}").replace("{seg}", "{x}"))


@pytest.mark.parametrize("method,template", ac.ALLOWED_ROUTES)
def test_every_allowed_route_exists_in_backend(routes, method, template):
    assert (method, _norm(template)) in routes, f"{method} {template} is not an AppBI route"


@pytest.mark.parametrize("method,template", ac.FORBIDDEN_ROUTES)
def test_forbidden_routes_are_not_reachable(method, template):
    concrete = template.replace("{id}", "1").replace("{seg}", "x")
    assert ac.match_route(method, concrete) is None, f"{method} {template} must not be on the allowlist"


def test_delete_and_patch_are_only_draft_edits():
    # The only DELETE/PATCH the integration may send are the Manual Builder's DRAFT
    # edits (remove a tile in the caller's draft, edit a widget in the caller's draft),
    # and each is refused without draft=true, which would write the live row.
    risky = [r for r in ac.ALLOWED_ROUTES if r[0] in ("DELETE", "PATCH")]
    assert sorted(risky) == [("DELETE", "/dashboards/{id}/charts/{id}"), ("PATCH", "/dashboards/{id}/widgets/{id}")]
    for method, template in risky:
        assert ac._REQUIRED_PARAMS[(method, template)] == {"draft": "true"}


async def test_a_live_delete_or_patch_never_leaves_the_process():
    client = ac.AppbiClient("http://appbi.invalid/api/v1", "pat", "r")
    with pytest.raises(ac.GuardViolation):
        await client.request("DELETE", "/dashboards/1/charts/2")
    with pytest.raises(ac.GuardViolation):
        await client.request("PATCH", "/dashboards/1/widgets/2", params={"draft": "false"}, json={"widget_config": {}})
    assert client.calls == []


def test_forbidden_list_names_real_routes(routes):
    # A forbidden entry that does not exist protects nothing; keep the list honest.
    missing = [f"{m} {t}" for m, t in ac.FORBIDDEN_ROUTES if (m, _norm(t)) not in routes]
    assert not missing, f"forbidden routes not found in backend: {missing}"


def test_unlisted_route_is_refused_before_any_request():
    import asyncio

    client = ac.AppbiClient(base_url="http://unused.invalid/api/v1", pat="x", request_id="r")
    with pytest.raises(ac.RouteNotAllowed):
        asyncio.run(client.request("POST", "/datasources/query", json={}))
    assert client.calls == []


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/dashboards/", {"name": "x", "charts": [{"chart_id": 1}]}),
        ("POST", "/dashboards/", {"name": "x", "pages_config": [{"id": "p"}]}),
        ("POST", "/dashboards/5/charts", {"chart_id": 1, "layout": {"x": 0, "y": 0, "w": 6, "h": 4}}),
        ("POST", "/dashboards/5/charts", {"chart_id": 1, "layout": {"draftOnly": "true"}}),
        ("PUT", "/dashboards/5/draft-filters", {"filters_config": []}),
        ("PUT", "/dashboards/5/draft-filters", {"base_rev": "r#1", "remove_tile_ids": [3]}),
        ("POST", "/dashboards/5/publish", {"tile_base_v": {}, "force": True}),
        ("POST", "/dashboards/5/publish", None),
        ("POST", "/datasets/5/model/joins", {"from_view_id": 1, "to_view_id": 2, "force": True}),
        ("PUT", "/datasets/5/model/views/3", {"measures": [], "rename_map": {"a": "b"}}),
        ("PUT", "/datasets/5/model/views/3", {"dimensions": [], "measures": []}),  # no expected_view_version (F4)
        ("POST", "/datasets/", {"name": "x", "purpose": "operational"}),
        ("POST", "/datasets/5/tables", {"display_name": "x", "source_kind": "sql_query", "source_query": "select 1"}),
    ],
)
def test_body_guards_refuse_draft_bypassing_shapes(method, path, body):
    import asyncio

    client = ac.AppbiClient(base_url="http://unused.invalid/api/v1", pat="x", request_id="r")
    with pytest.raises(ac.GuardViolation):
        asyncio.run(client.request(method, path, json=body))
    assert client.calls == []
