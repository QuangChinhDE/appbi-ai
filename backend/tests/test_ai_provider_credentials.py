# -*- coding: utf-8 -*-
"""Agent Flow steps run on stored AI keys — and on nothing else.

WHAT THIS REPLACED. A step's key used to come from one of five places: its own
`api_key` field (never reachable from the UI), the link's `ai_bot_key`, the
viewer's pasted header, or the server's `OPENAI_API_KEY`, and each run entrypoint
chose among them differently. A step pinned to one vendor could be handed another
vendor's key (`node.resolved_api_key() or rctx.api_key`).

INVARIANTS LOCKED HERE
  * A key is stored encrypted, or not at all; no response ever carries it.
  * Who may use a key is `get_effective_permission` — owner, share, module admin.
  * Assigning a key to a step is checked on save and attributed to the saver; an
    unchanged key is carried with its original grantor.
  * At run time a step gets exactly its own key, re-checked against its grantor.
    There is no fallback — not even when the server environment holds a key.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_brain import AgentBrainVersion
from app.models.ai_provider_credential import AiProviderCredential
from app.models.audit_log import AuditLog
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.team import Team, TeamMembership
from app.models.user import User
from app.services.agent_flows import credentials as C
from app.services.agent_flows.contract import Flow, upgrade_body


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


# The UUID columns too: without this the file only passed when another test
# module happened to register the same hook first (it errored when run alone,
# as the guardrail's required-gate runner does).
@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


CANARY = "sk-CANARY-a1b2c3d4e5f6g7h8i9j0-LEAK"
GEMINI_CANARY = "AIzaCANARYCANARYCANARYCANARY1234"


@pytest.fixture()
def fernet(monkeypatch):
    from cryptography.fernet import Fernet

    from app.core.config import settings

    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", Fernet.generate_key().decode())
    return settings


@pytest.fixture()
def db(monkeypatch, fernet):
    tables = [
        User.__table__, Team.__table__, TeamMembership.__table__,
        ResourceShare.__table__, AiProviderCredential.__table__,
        AgentBrainVersion.__table__, AuditLog.__table__,
    ]
    # Some server defaults are Postgres `'...'::jsonb` literals SQLite cannot parse.
    # The rows written here set those columns explicitly, so the defaults go.
    for table in tables:
        for col in table.columns:
            d = col.server_default
            if d is not None and "::" in str(getattr(d, "arg", "")):
                monkeypatch.setattr(col, "server_default", None)
    # ONE shared in-memory connection: the TestClient runs requests on another thread.
    engine = create_engine("sqlite://", future=True, poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=tables)
    Session = sessionmaker(bind=engine, future=True)
    s = Session()
    # `StoredCredentials._touch` opens its own session; point it at this database.
    import app.core.database as database

    monkeypatch.setattr(database, "SessionLocal", Session)
    yield s
    s.close()


def make_user(db, name, level="edit", **extra):
    u = User(
        id=uuid.uuid4(), email=f"{name}@example.com", full_name=name,
        preferred_language="vi", google_oauth_scopes=[],
        permissions={"agent_flows": level, **extra},
    )
    db.add(u)
    db.commit()
    return u


def share(db, row, owner, target, level="view"):
    db.add(ResourceShare(
        resource_type=ResourceType.AI_CREDENTIAL, resource_id=str(row.id),
        user_id=target.id, permission=SharePermission(level), shared_by=owner.id,
    ))
    db.commit()


def new_key(db, user, name="OpenAI chính", provider="openai", secret=CANARY, **kw):
    out = C.create(db, user, name=name, provider=provider, secret=secret, **kw)
    return db.get(AiProviderCredential, out["id"]), out


def step(key="answer", provider="openai", model="gpt-4o-mini", credential_id=None, by=""):
    return {"type": "agent", "key": key, "name": key, "prompt": "Trả lời.",
            "provider": provider, "model": model,
            "credential_id": credential_id, "credential_granted_by": by}


def flow_of(*nodes):
    body = upgrade_body({"nodes": list(nodes)}, key="f", name="f")
    return Flow.model_validate({**body, "key": "f", "name": "f"})


# ═══ the store ════════════════════════════════════════════════════════════════

def test_a_key_is_stored_encrypted_and_never_returned(db):
    owner = make_user(db, "owner")
    row, out = new_key(db, owner)
    assert row.secret_enc.startswith("_enc:") and CANARY not in row.secret_enc
    assert row.key_hint == CANARY[-4:]
    assert CANARY not in repr(out) and row.secret_enc not in repr(out)
    assert "secret" not in out and "secret_enc" not in out
    listed = C.list_usable(db, owner)
    assert CANARY not in repr(listed) and row.secret_enc not in repr(listed)


def test_without_an_encryption_key_nothing_is_stored(db, monkeypatch):
    from app.core.config import settings

    owner = make_user(db, "owner")
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", "")
    with pytest.raises(C.CredentialError) as exc:
        C.create(db, owner, name="k", provider="openai", secret=CANARY)
    assert exc.value.status == 409
    assert db.query(AiProviderCredential).count() == 0


def test_the_first_key_of_a_provider_is_its_default_and_only_one_default_exists(db):
    owner = make_user(db, "owner")
    a, _ = new_key(db, owner, name="A")
    b, _ = new_key(db, owner, name="B")
    g, _ = new_key(db, owner, name="G", provider="gemini", secret=GEMINI_CANARY)
    db.refresh(a), db.refresh(b)
    assert (a.is_default, b.is_default, g.is_default) == (True, False, True)
    C.update(db, owner, b.id, is_default=True)
    db.refresh(a), db.refresh(b)
    assert (a.is_default, b.is_default) == (False, True)


def test_names_are_unique_per_owner_and_providers_are_a_closed_list(db):
    owner = make_user(db, "owner")
    other = make_user(db, "other")
    new_key(db, owner, name="Trùng")
    with pytest.raises(C.CredentialError) as exc:
        new_key(db, owner, name="Trùng")
    assert exc.value.status == 400
    new_key(db, other, name="Trùng")  # another owner may use the same name
    with pytest.raises(C.CredentialError):
        C.create(db, owner, name="x", provider="mistral", secret=CANARY)


def test_a_blank_secret_keeps_the_stored_one_and_a_new_one_replaces_it(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    before = row.secret_enc
    C.update(db, owner, row.id, name="Đổi tên", secret="")
    db.refresh(row)
    assert row.secret_enc == before and row.name == "Đổi tên"
    C.update(db, owner, row.id, secret="sk-rotated-000000000000009999")
    db.refresh(row)
    assert row.secret_enc != before and row.key_hint == "9999"
    assert C._decrypt(row) == "sk-rotated-000000000000009999"


def test_delete_is_soft_names_what_loses_the_key_and_forgets_the_secret(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    nested = {"type": "coordinate", "key": "coord", "name": "Điều phối", "prompt": "p",
              "provider": "openai", "model": "gpt-4o-mini",
              "specialists": [
                  {"key": "s1", "name": "s1", "when": "khi hỏi về doanh thu theo tháng", "body": [step("inner", credential_id=row.id)]},
                  {"key": "s2", "name": "s2", "when": "khi hỏi về tài liệu nội bộ", "body": []}]}
    db.add(AgentBrainVersion(brain_key="flow1", version=1, status="draft", name="Flow 1",
                             body={"nodes": [nested]}, owner_email=owner.email))
    db.commit()
    out = C.delete(db, owner, row.id)
    assert out["affected"] == [{"brain_key": "flow1", "flow_name": "Flow 1",
                                "step_key": "inner", "step_name": "inner"}]
    db.refresh(row)
    assert row.deleted_at is not None and C._decrypt(row) == ""
    assert C.list_usable(db, owner) == []


# ═══ who may use a key ════════════════════════════════════════════════════════

def test_a_key_is_private_until_shared(db):
    owner = make_user(db, "owner")
    stranger = make_user(db, "stranger")
    row, _ = new_key(db, owner)
    assert C.list_usable(db, stranger) == []
    assert not C.can_use(db, stranger, row)
    with pytest.raises(C.CredentialError) as exc:
        C.get_for(db, stranger, row.id)
    assert exc.value.status == 403


def test_a_view_share_lets_the_recipient_use_and_test_it_but_not_change_it(db):
    owner = make_user(db, "owner")
    friend = make_user(db, "friend")
    row, _ = new_key(db, owner)
    share(db, row, owner, friend, "view")
    listed = C.list_usable(db, friend)
    assert [k["id"] for k in listed] == [row.id] and listed[0]["mine"] is False
    assert listed[0]["owner"]["email"] == owner.email
    assert C.can_use(db, friend, row)
    for call in (lambda: C.update(db, friend, row.id, name="x"),
                 lambda: C.delete(db, friend, row.id)):
        with pytest.raises(C.CredentialError) as exc:
            call()
        assert exc.value.status == 403


def test_an_edit_share_may_rename_but_only_the_owner_sets_defaults_or_deletes(db):
    owner = make_user(db, "owner")
    friend = make_user(db, "friend")
    row, _ = new_key(db, owner)
    share(db, row, owner, friend, "edit")
    C.update(db, friend, row.id, name="Tên mới")
    with pytest.raises(C.CredentialError):
        C.update(db, friend, row.id, is_default=False)
    with pytest.raises(C.CredentialError):
        C.delete(db, friend, row.id)


def test_without_the_module_a_user_sees_no_keys_even_their_own(db):
    owner = make_user(db, "owner", level="edit")
    row, _ = new_key(db, owner)
    owner.permissions = {"agent_flows": "none"}
    db.commit()
    assert C.list_usable(db, owner) == []
    assert not C.can_use(db, owner, row)


# ═══ saving a flow: assignment ════════════════════════════════════════════════

def test_a_new_key_on_a_step_is_attributed_to_the_saver(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    out = C.apply_assignments(db, owner, prior_body=None,
                              body={"nodes": [step(credential_id=row.id, by="forged@x")]})
    n = out["nodes"][0]
    assert n["credential_id"] == row.id
    assert n["credential_granted_by"] == owner.email, "a client-sent grantor must be ignored"


def test_a_key_the_saver_may_not_use_cannot_be_assigned(db):
    owner = make_user(db, "owner")
    other = make_user(db, "other")
    row, _ = new_key(db, owner)
    with pytest.raises(C.CredentialError) as exc:
        C.apply_assignments(db, other, prior_body=None,
                            body={"nodes": [step(credential_id=row.id)]})
    assert exc.value.status == 403 and "answer" in str(exc.value.detail)


def test_a_key_of_another_vendor_is_refused_at_save(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner, provider="gemini", secret=GEMINI_CANARY)
    with pytest.raises(C.CredentialError) as exc:
        C.apply_assignments(db, owner, prior_body=None,
                            body={"nodes": [step(provider="openai", credential_id=row.id)]})
    assert exc.value.status == 422 and "Gemini" in str(exc.value.detail)


def test_a_missing_or_deleted_key_is_refused_when_newly_assigned(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    C.delete(db, owner, row.id)
    for cid in (row.id, 99999):
        with pytest.raises(C.CredentialError) as exc:
            C.apply_assignments(db, owner, prior_body=None,
                                body={"nodes": [step(credential_id=cid)]})
        assert exc.value.status == 422


def test_a_co_editor_keeps_the_authors_key_when_saving_other_edits(db):
    """B cannot use A's key, but editing a prompt must not strip it or re-attribute
    it — the step stays on A's key, delegated by A."""
    author = make_user(db, "author")
    editor = make_user(db, "editor")
    row, _ = new_key(db, author)
    prior = C.apply_assignments(db, author, prior_body=None,
                                body={"nodes": [step(credential_id=row.id)]})
    edited = {"nodes": [{**prior["nodes"][0], "prompt": "Prompt mới",
                         "credential_granted_by": editor.email}]}
    out = C.apply_assignments(db, editor, prior_body=prior, body=edited)
    assert out["nodes"][0]["credential_id"] == row.id
    assert out["nodes"][0]["credential_granted_by"] == author.email


def test_an_export_carries_no_key_reference(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    body = C.apply_assignments(db, owner, prior_body=None,
                               body={"nodes": [step(credential_id=row.id)]})
    out = C.strip_assignments(body)
    assert out["nodes"][0]["credential_id"] is None
    assert "credential_granted_by" not in out["nodes"][0]


# ═══ running: the one resolver, no fallback ═══════════════════════════════════

def assigned_flow(db, user, row, **kw):
    body = C.apply_assignments(db, user, prior_body=None,
                               body={"nodes": [step(credential_id=row.id, **kw)]})
    return flow_of(*body["nodes"])


def test_a_step_runs_on_exactly_its_own_key_and_model(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    f = assigned_flow(db, owner, row, model="gpt-4o")
    got = C.StoredCredentials(db).for_node(f.nodes[0])
    assert (got.provider, got.model, got.api_key, got.credential_id) == (
        "openai", "gpt-4o", CANARY, row.id)
    db.refresh(row)
    assert row.last_used_at is not None


def test_no_key_means_no_run_even_when_the_server_holds_one(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-server-environment-key-000", raising=False)
    monkeypatch.setattr(settings, "PUBLIC_BOT_USE_DEPLOYMENT_KEY", True, raising=False)
    f = flow_of(step())
    with pytest.raises(C.CredentialUnavailable) as exc:
        C.StoredCredentials(db).for_node(f.nodes[0])
    assert exc.value.reason == "none" and "answer" in str(exc.value)
    assert "sk-server" not in str(exc.value)


def test_a_deleted_key_fails_by_name(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner, name="Key sắp xoá")
    f = assigned_flow(db, owner, row)
    C.delete(db, owner, row.id)
    with pytest.raises(C.CredentialUnavailable) as exc:
        C.StoredCredentials(db).for_node(f.nodes[0])
    assert exc.value.reason == "deleted" and "Key sắp xoá" in str(exc.value)


def test_unsharing_a_key_stops_it_being_spent_through_someone_elses_flow(db):
    owner = make_user(db, "owner")
    friend = make_user(db, "friend")
    row, _ = new_key(db, owner)
    share(db, row, owner, friend, "view")
    f = assigned_flow(db, friend, row)
    assert C.StoredCredentials(db).for_node(f.nodes[0]).api_key == CANARY
    db.query(ResourceShare).delete()
    db.commit()
    with pytest.raises(C.CredentialUnavailable) as exc:
        C.StoredCredentials(db).for_node(f.nodes[0])
    assert exc.value.reason == "not_shared"


def test_a_key_that_no_longer_decrypts_fails_rather_than_sending_ciphertext(db, monkeypatch):
    from cryptography.fernet import Fernet

    from app.core.config import settings

    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    f = assigned_flow(db, owner, row)
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", Fernet.generate_key().decode())
    with pytest.raises(C.CredentialUnavailable) as exc:
        C.StoredCredentials(db).for_node(f.nodes[0])
    assert exc.value.reason == "undecryptable"


def test_problems_walk_every_model_step_in_the_tree(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    good = C.apply_assignments(db, owner, prior_body=None,
                               body={"nodes": [step("ok", credential_id=row.id)]})["nodes"][0]
    coord = {"type": "coordinate", "key": "coord", "name": "coord", "prompt": "p",
             "specialists": [
                 {"key": "s1", "name": "s1", "when": "khi hỏi về doanh thu theo tháng", "body": [step("inner")]},
                 {"key": "s2", "name": "s2", "when": "khi hỏi về tài liệu nội bộ", "body": [good]}]}
    f = flow_of(coord)
    keys = {p["step_key"] for p in C.StoredCredentials(db).problems(f)}
    assert keys == {"coord", "inner"}


def test_the_executor_names_the_keyless_step_and_calls_no_model(db, monkeypatch):
    """No retry and no provider call for a key that is not there: the error names
    the step, and nothing is spent finding out."""
    from app.services.agent_flows.envelope import FlowInput
    from app.services.agent_flows.runtime import executor
    from app.services.agent_flows.runtime.handlers import agent as A

    calls = []

    async def fake(**kw):
        calls.append(kw)
        if False:
            yield None

    monkeypatch.setattr(A, "_stream", fake)
    node = {**step(), "retry": {"max_attempts": 3, "backoff_seconds": 0}}
    f = flow_of(node)
    env = {"request": {"id": "r1", "at": "2026-09-30T00:00:00Z"},
           "question": {"raw": "Doanh thu?", "normalized": "Doanh thu?"},
           "report": {"dashboard_id": 0}, "binding": {"id": 0}}

    class _Ctx:
        allowed_chart_ids: set = set()
        chart_meta: dict = {}

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=f, ctx=_Ctx(),
                                          credentials=C.StoredCredentials(db)):
            if ev.type == "result":
                out = ev.extra["envelope"]
        return out

    out = asyncio.new_event_loop().run_until_complete(go())
    assert calls == [], "a keyless step must not reach the provider"
    trace = {t["key"]: t for t in out["trace"]["steps"]}
    assert trace["answer"]["status"] == "error"
    assert "chưa có AI key" in trace["answer"]["error"]


# ═══ nothing secret leaves ════════════════════════════════════════════════════

def test_vendor_errors_are_sanitised_before_they_are_stored(db):
    assert CANARY not in C.sanitize_error(f"401 bad key {CANARY}", secret=CANARY)
    assert "AIza" not in C.sanitize_error(f"https://x/v1?key={GEMINI_CANARY}&alt=sse")
    assert "sk-ant-" not in C.sanitize_error("invalid x-api-key sk-ant-api03-abcdefghijkl")
    assert len(C.sanitize_error("x" * 500)) <= 200


def test_the_audit_trail_records_the_key_but_not_the_secret(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    C.update(db, owner, row.id, secret="sk-rotated-SECOND-CANARY-0001")
    C.delete(db, owner, row.id)
    rows = db.query(AuditLog).filter(AuditLog.resource_type == "ai_credential").all()
    assert len(rows) == 3
    text = repr([(r.action, r.details) for r in rows])
    assert CANARY not in text and "SECOND-CANARY" not in text and "_enc:" not in text


def test_a_flow_body_never_holds_a_secret(db):
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    body = C.apply_assignments(db, owner, prior_body=None,
                               body={"nodes": [step(credential_id=row.id)]})
    stored = flow_of(*body["nodes"]).to_dict()
    assert CANARY not in repr(stored) and row.secret_enc not in repr(stored)


# ═══ the router ═══════════════════════════════════════════════════════════════

@pytest.fixture()
def client(db):
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app

    state = {"user": None}
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: state["user"]
    try:
        yield TestClient(app), state
    finally:
        app.dependency_overrides.clear()


def test_every_credential_endpoint_is_gated_by_the_module(db, client):
    c, state = client
    owner = make_user(db, "owner")
    row, _ = new_key(db, owner)
    state["user"] = make_user(db, "nobody", level="none")
    base = "/api/v1/agent-flows/credentials"
    for method, path, body in (
        ("get", base, None),
        ("post", base, {"name": "x", "provider": "openai", "secret": CANARY}),
        ("patch", f"{base}/{row.id}", {"name": "y"}),
        ("delete", f"{base}/{row.id}", None),
        ("get", f"{base}/{row.id}/usage", None),
        ("post", f"{base}/{row.id}/test", None),
    ):
        r = getattr(c, method)(path, **({"json": body} if body is not None else {}))
        assert r.status_code == 403, (method, path, r.status_code)

    state["user"] = make_user(db, "viewer", level="view")
    assert c.get(base).status_code == 200
    assert c.post(base, json={"name": "x", "provider": "openai", "secret": CANARY}).status_code == 403


def test_the_api_creates_lists_and_never_echoes_the_secret(db, client):
    c, state = client
    state["user"] = make_user(db, "author")
    r = c.post("/api/v1/agent-flows/credentials",
               json={"name": "Của tôi", "provider": "openai", "secret": CANARY})
    assert r.status_code == 201, r.text
    assert CANARY not in r.text and "_enc:" not in r.text
    assert r.json()["key_hint"] == CANARY[-4:] and r.json()["is_default"] is True
    listed = c.get("/api/v1/agent-flows/credentials")
    assert listed.status_code == 200 and CANARY not in listed.text and "_enc:" not in listed.text
    assert [k["name"] for k in listed.json()["credentials"]] == ["Của tôi"]


def test_the_models_catalogue_offers_three_vendors_and_no_inherit(db, client):
    c, state = client
    state["user"] = make_user(db, "author")
    groups = c.get("/api/v1/agent-flows/models").json()["providers"]
    assert [g["provider"] for g in groups] == ["openai", "anthropic", "gemini"]
    assert all(g["models"] for g in groups)
    assert "has_key" not in repr(groups) and "inherit" not in repr(groups)


def test_a_key_is_shared_through_the_generic_share_endpoints(db, client, monkeypatch):
    """Only the owner may share; the recipient then sees and may use the key.

    The share row itself is written by `_upsert_share`, whose ON CONFLICT names a
    Postgres constraint SQLite cannot resolve; it is replaced with a plain insert.
    Everything that decides WHO may share — the registration of `ai_credential`,
    `require_share_access`, `get_effective_permission` — runs for real."""
    import app.api.shares as shares_api

    def plain_upsert(db_, resource_type, resource_id, permission, shared_by, *, user_id=None, team_id=None):
        db_.add(ResourceShare(resource_type=resource_type, resource_id=str(resource_id),
                              user_id=user_id, team_id=team_id, permission=permission,
                              shared_by=shared_by))

    monkeypatch.setattr(shares_api, "_upsert_share", plain_upsert)
    c, state = client
    owner = make_user(db, "owner")
    friend = make_user(db, "friend")
    stranger = make_user(db, "stranger")
    row, _ = new_key(db, owner)

    state["user"] = stranger
    r = c.post(f"/api/v1/shares/ai_credential/{row.id}",
               json={"user_id": str(friend.id), "permission": "view"})
    assert r.status_code == 403, r.text

    state["user"] = owner
    r = c.post(f"/api/v1/shares/ai_credential/{row.id}",
               json={"user_id": str(friend.id), "permission": "view"})
    assert r.status_code == 201, r.text
    assert CANARY not in r.text

    state["user"] = friend
    listed = c.get("/api/v1/agent-flows/credentials").json()["credentials"]
    assert [k["id"] for k in listed] == [row.id] and listed[0]["permission"] == "view"
    assert c.delete(f"/api/v1/agent-flows/credentials/{row.id}").status_code == 403
