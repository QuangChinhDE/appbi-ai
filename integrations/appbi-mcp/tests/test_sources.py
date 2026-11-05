"""Source Human Handoff: credentials stay in AppBI; resume finds the source by AppBI's facts."""

from __future__ import annotations

from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import match_route
from appbi_mcp.context import Principal
from appbi_mcp.operations import PlanStore
from appbi_mcp.state import StateStore
from appbi_mcp.tools import sources as so
from appbi_mcp.tools.runtime import Env


class Fake:
    def __init__(self) -> None:
        self.sources: list[dict[str, Any]] = [{"id": 1, "name": "Old", "type": "postgresql", "owner_id": "u1",
                                               "created_at": "2000-01-01T00:00:00Z", "config_version": 1, "user_permission": "full"}]

    async def get(self, path: str, **_: Any) -> Any:
        assert match_route("GET", path)
        if path == "/datasources/":
            return self.sources
        return next(s for s in self.sources if s["id"] == int(path.rsplit("/", 1)[1]))

    async def post(self, path: str, body: Any = None, **_: Any) -> Any:
        assert match_route("POST", path) and body is None  # the test request carries nothing
        return {"success": True, "message": "ok"}


@pytest.fixture
def env(tmp_path):
    store = StateStore(str(tmp_path / "s"), Fernet.generate_key())

    class App:
        class settings:
            appbi_public_url = "http://appbi"
            public_url = "http://mcp"
    App.store = store  # type: ignore[attr-defined]
    return Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.author"], "r"), appbi=Fake(), plans=PlanStore(store))  # type: ignore[arg-type]


async def test_new_source_handoff_resumes_only_on_a_source_the_user_created_after_it(env):
    h = await so.start_source_handoff(env, "new", "postgresql", "Shop")
    assert h["status"] == "handoff_required" and h["handoff_url"].startswith("http://appbi/datasources/new?handoff=1")
    assert "password" not in str(h).lower() or "credentials" in h["message"]
    assert (await so.check_source_handoff(env, h["handoff_id"]))["status"] == "pending"
    from datetime import datetime, timezone
    env.appbi.sources.append({"id": 2, "name": "Shop", "type": "postgresql", "owner_id": "someone-else",
                              "created_at": datetime.now(timezone.utc).isoformat(), "config_version": 1})
    assert (await so.check_source_handoff(env, h["handoff_id"]))["status"] == "pending"  # not the user's
    env.appbi.sources.append({"id": 3, "name": "Shop", "type": "postgresql", "owner_id": "u1",
                              "created_at": datetime.now(timezone.utc).isoformat(), "config_version": 1})
    done = await so.check_source_handoff(env, h["handoff_id"])
    assert done["status"] == "completed" and done["source"]["id"] == 3
    assert (await so.test_data_source(env, 3))["status"] == "ok"


async def test_reconnect_completes_when_appbi_shows_a_new_config_version(env):
    h = await so.start_source_handoff(env, "reconnect", data_source_id=1)
    assert h["handoff_url"].endswith("/datasources/1/edit?handoff=1")
    assert (await so.check_source_handoff(env, h["handoff_id"]))["status"] == "pending"
    env.appbi.sources[0]["config_version"] = 2
    assert (await so.check_source_handoff(env, h["handoff_id"]))["status"] == "completed"


async def test_another_users_handoff_is_not_found(env):
    h = await so.start_source_handoff(env, "new")
    env.principal.user_id = "u2"
    assert (await so.check_source_handoff(env, h["handoff_id"]))["status"] == "not_found"
