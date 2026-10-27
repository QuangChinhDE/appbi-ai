"""Unified AI Chat — the architecture contract as executable checks.

Contract: docs/features/unified-ai-chat/contract.md. Each test below is a way the
old dual design could quietly come back, and fails the moment it does:

  * a second answering surface for signed-in users (the Analyst routes, the
    Flow-first chat routes) is mounted again;
  * asking a question requires a Flow (a `brain_key` in the turn or conversation);
  * a user-facing Analyst module or on/off toggle reappears;
  * the Flow engine regains a runner that owns a signed-in chat turn;
  * the chat Core reads business data through anything but GQS (ChartService,
    the Flow tools, the dashboard bot);
  * an extension context can still reach ChartService;
  * something outside the chat service writes conversation turns;
  * the frontend grows an Analyst entry, flag, or a chat that needs a Flow.

Routes are read from the real app with EVERY optional module mounted, in a
subprocess so this file does not depend on which flags an earlier test imported
the app with.
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
APP = BACKEND / "app"

_ALL_FLAGS = {
    "METADATA_CATALOG_ENABLED": "true", "GOVERN_ENABLED": "true", "WORKBOARDS_ENABLED": "true",
    "OBSERVABILITY_ENABLED": "true",
    # set on purpose: a legacy flag left in an operator's .env must not bring a route back
    "ANALYST_ENABLED": "true",
}


@pytest.fixture(scope="module")
def openapi() -> dict:
    code = (
        "import json, sys\n"
        "from app.main import app\n"
        "sys.stdout.write(json.dumps(app.openapi()))\n"
    )
    env = {**os.environ, **_ALL_FLAGS, "PYTHONPATH": str(BACKEND), "ENVIRONMENT": "test",
           "DATABASE_URL": os.environ.get("DATABASE_URL") or "sqlite:///./arch_check.db"}
    out = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env=env, capture_output=True,
                         text=True, encoding="utf-8", timeout=300)
    assert out.returncode == 0, out.stderr[-3000:]
    return json.loads(out.stdout[out.stdout.index("{"):])


def _paths(spec: dict) -> dict[str, set[str]]:
    return {p: {m.upper() for m in ops} for p, ops in spec["paths"].items()}


# ── one answering surface for signed-in users ────────────────────────────────

def test_no_second_answering_surface_is_mounted(openapi):
    paths = _paths(openapi)
    legacy = sorted(p for p in paths if p.startswith(("/api/v1/analyst", "/api/v1/agent-flows/chat")))
    assert legacy == [], f"retired answering routes are mounted again: {legacy}"
    assert "POST" in paths.get("/api/v1/chat/conversations/{conversation_id}/turns", set()), \
        "the one canonical turn route is missing"


def _schema(spec: dict, ref: str) -> dict:
    return spec["components"]["schemas"][ref.rsplit("/", 1)[-1]]


def _body_schema(spec: dict, path: str, method: str = "post") -> dict:
    op = spec["paths"][path][method]
    ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    return _schema(spec, ref)


def test_asking_needs_no_flow(openapi):
    turn = _body_schema(openapi, "/api/v1/chat/conversations/{conversation_id}/turns")
    assert set(turn.get("required", [])) <= {"question", "idempotency_key"}, turn.get("required")
    assert not {"brain_key", "flow_key", "brain"} & set(turn["properties"]), "a turn names a Flow"
    conv = _body_schema(openapi, "/api/v1/chat/conversations")
    assert not conv.get("required"), f"starting a conversation requires {conv.get('required')}"


def test_no_user_facing_analyst_module_or_toggle():
    from app.core.authz.registry import MODULES
    from app.core.config import Settings

    keys = {m.key for m in MODULES}
    assert "analyst" not in keys, "a separate Analyst module is back"
    chat = next(m for m in MODULES if m.key == "chat")
    assert chat.enabled is None, "AI Chat must not depend on a feature flag (the kill switch is per turn)"
    fields = set(getattr(Settings, "model_fields", {}) or getattr(Settings, "__fields__", {}))
    assert not {"ANALYST_ENABLED", "ANALYST_PILOT_ALLOWLIST"} & fields
    for f in ("docker-compose.yml", "frontend/Dockerfile"):
        assert "ANALYST_ENABLED" not in (REPO / f).read_text(encoding="utf-8"), f"{f} still carries the Analyst toggle"


def test_the_flow_engine_owns_no_signed_in_chat_turn():
    from app.services.agent_flows import dispatch

    assert not hasattr(dispatch, "run_for_chat_thread"), "the Flow-first chat runner is back"
    users = [str(p.relative_to(BACKEND)) for p in APP.rglob("*.py")
             if "run_for_chat_thread" in p.read_text(encoding="utf-8")]
    assert users == [], users
    assert not (APP / "modules" / "agent_flows" / "chat_api.py").exists()


# ── one data authority ───────────────────────────────────────────────────────

_FORBIDDEN_IN_CORE = (
    "app.services.chart_service", "app.services.agent_flows.tools", "app.services.dashboard_ai_bot",
    "app.services.query_execution", "app.services.semantic_query",
)


def _imports(path: Path) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        if isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module)
            out.update(f"{node.module}.{a.name}" for a in node.names)
        elif isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
    return out


def _core_files() -> list[Path]:
    files = [APP / "api" / "chat.py", *sorted((APP / "services" / "chat").glob("*.py")),
             *sorted((APP / "services" / "data_core").glob("*.py"))]
    assert all(f.exists() for f in files[:2]), "the chat API / service is missing"
    return files


def test_the_chat_core_reads_data_only_through_gqs():
    bad = {}
    for f in _core_files():
        hit = sorted(i for i in _imports(f) if i.startswith(_FORBIDDEN_IN_CORE))
        if f.name == "extension.py":
            # the extension runner starts the Flow engine (executor), but never its tools
            hit = [i for i in hit if not i.startswith("app.services.agent_flows.tools.context")]
        if hit:
            bad[str(f.relative_to(BACKEND))] = hit
    assert bad == {}, f"the chat Core reaches business data outside GQS: {bad}"
    service = (APP / "services" / "data_core" / "service.py").read_text(encoding="utf-8")
    assert "GovernedQueryService" in service and 'surface="chat"' in service


def test_an_extension_context_cannot_read_chart_data(monkeypatch):
    """ADR-1: a Flow invoked from Chat runs with data reads forbidden. ChartService
    is never reached, whatever chart id or scope the Flow's tools ask for."""
    from app.services.agent_flows.tools import context as tc
    from app.services.chart_service import ChartService

    called = []
    monkeypatch.setattr(ChartService, "get_chart_data", staticmethod(lambda *a, **k: called.append(a) or {}))
    ctx = tc.ToolContext(db=None, dashboard=None, public_filters=[], actor_type=tc.CHAT_USER, actor_ref="x")
    ctx.data_reads_forbidden = True
    ctx.allowed_chart_ids = [1, 2, 3]
    with pytest.raises(tc.DataReadForbidden):
        tc._fetch_chart_data(ctx, 1)
    assert called == [], "ChartService was reached from an extension context"


# ── one conversation store ───────────────────────────────────────────────────

def test_only_the_chat_service_writes_turns():
    writers = []
    for p in APP.rglob("*.py"):
        rel = p.relative_to(APP).as_posix()
        if rel.startswith(("services/chat/", "models/")):
            continue
        text = p.read_text(encoding="utf-8")
        if "ChatTurn(" in text or "insert(ChatTurn" in text:
            writers.append(rel)
    assert writers == [], f"conversation turns written outside services/chat: {writers}"


def test_runtime_code_uses_no_legacy_conversation_store():
    """The legacy tables stay (history is recoverable until acceptance) but nothing
    at runtime reads or writes them; the import is the migration's."""
    bad = []
    for p in APP.rglob("*.py"):
        rel = p.relative_to(APP).as_posix()
        if rel.startswith("models/"):
            continue
        imports = _imports(p)
        if {"app.models.analyst_session", "app.models.agent_flow_chat_thread"} & imports:
            bad.append(rel)
    assert bad == [], bad


# ── one chat in the product UI ───────────────────────────────────────────────

FRONTEND = REPO / "frontend" / "src"


def test_the_frontend_has_one_chat():
    sidebar = (FRONTEND / "components" / "layout" / "Sidebar.tsx").read_text(encoding="utf-8")
    assert "'/analyst'" not in sidebar and '"/analyst"' not in sidebar, "an Analyst entry is back in the sidebar"
    flags = (FRONTEND / "lib" / "feature-flags.ts").read_text(encoding="utf-8")
    assert "ANALYST" not in flags, "a user-facing Analyst flag is back"
    retired = ("@/components/analyst", "@/lib/api/analyst", "@/lib/directChat", "components/chat/ChatModule",
               "components/chat/AssistantCatalogue")
    offenders = [str(p.relative_to(FRONTEND)) for p in FRONTEND.rglob("*.ts*")
                 if any(r in p.read_text(encoding="utf-8") for r in retired)]
    assert offenders == [], f"retired chat/analyst modules are imported: {offenders}"
    for p in (FRONTEND / "components" / "chat").rglob("*.tsx"):
        assert "brainKey) return" not in p.read_text(encoding="utf-8"), f"{p.name}: sending requires a Flow"
