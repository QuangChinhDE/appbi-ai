"""Source hardening Phase B — Google OAuth sources (F7).

Locks: the consent popup's `google_pending_id` survives BigQuery validation and
is claimed by the create chokepoint (the pending row consumed in the SAME
transaction, the handle never persisted); a failed save restores the pending
consent; the BigQuery client cache is keyed by the identity of the GOOGLE
credential (account + refresh-token fingerprint), never the AppBI user and
never the token — so one AppBI user with two Google accounts gets two clients;
reconnecting changes the key and the old client is evicted.
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

from source_phase_b_support import OWNER, make_db, no_network


@pytest.fixture()
def S(monkeypatch):
    return make_db(monkeypatch)


def _pending(S, user_id=OWNER, email="a@example.com", refresh="rt-A"):
    from app.core.crypto import encrypt_value
    from app.models.models import GoogleOAuthPending
    pid = uuid.uuid4()
    with S() as s:
        s.add(GoogleOAuthPending(id=pid, user_id=user_id, email=email, scopes=["bq"],
                                 credentials=encrypt_value(json.dumps(
                                     {"refresh_token": refresh, "client_id": "cid", "token": "at"}))))
        s.commit()
    return str(pid)


def _pending_count(S):
    from app.models.models import GoogleOAuthPending
    with S() as s:
        return s.query(GoogleOAuthPending).count()


ACTOR = SimpleNamespace(id=OWNER, permissions={"data_sources": "edit"}, google_oauth_scopes=[],
                        google_oauth_email=None, google_oauth_credentials=None, email="owner@example.com")


def test_bigquery_oauth_create_claims_the_pending_handle(S, monkeypatch):
    from app.core.crypto import decrypt_config
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    no_network(monkeypatch)
    pid = _pending(S)
    req = DataSourceCreate(name="bq", type="bigquery",
                           config={"project_id": "p", "auth_mode": "google_oauth", "google_pending_id": pid})
    assert req.config["google_pending_id"] == pid  # survives request validation
    with S() as s:
        ds = DataSourceCRUDService.create(s, req, owner_id=OWNER, actor=ACTOR, test_connection=True)
        cfg = decrypt_config(dict(ds.config))
        raw = dict(ds.config)
    assert "google_pending_id" not in cfg
    assert json.loads(cfg["google_oauth_credentials"])["refresh_token"] == "rt-A"
    assert cfg["google_oauth_email"] == "a@example.com"
    assert raw["google_oauth_credentials"].startswith("_enc:")  # encrypted at rest
    assert _pending_count(S) == 0


def test_failed_save_after_claim_restores_the_pending_consent(S, monkeypatch):
    from app.models.models import DataSource
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    no_network(monkeypatch, ok=False)
    pid = _pending(S)
    req = DataSourceCreate(name="bq", type="bigquery",
                           config={"project_id": "p", "auth_mode": "google_oauth", "google_pending_id": pid})
    with S() as s, pytest.raises(SourceConfigError):
        DataSourceCRUDService.create(s, req, owner_id=OWNER, actor=ACTOR, test_connection=True)
    assert _pending_count(S) == 1, "the consent must not be lost when the save fails"
    with S() as s:
        assert s.query(DataSource).count() == 0


def test_expired_or_foreign_pending_handle_is_refused(S):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    foreign = _pending(S, user_id=uuid.uuid4())
    req = DataSourceCreate(name="bq", type="bigquery",
                           config={"project_id": "p", "auth_mode": "google_oauth", "google_pending_id": foreign})
    with S() as s, pytest.raises(SourceConfigError) as exc:
        DataSourceCRUDService.create(s, req, owner_id=OWNER, actor=ACTOR)
    assert exc.value.code == "google_connection_expired"
    assert _pending_count(S) == 1


def test_a_request_cannot_inject_its_own_google_token(S):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    req = DataSourceCreate(name="bq", type="bigquery", config={
        "project_id": "p", "auth_mode": "google_oauth",
        "google_oauth_credentials": json.dumps({"refresh_token": "injected"})})
    with S() as s, pytest.raises(SourceConfigError):
        DataSourceCRUDService.create(s, req, owner_id=OWNER, actor=ACTOR)


# ── client cache identity ────────────────────────────────────────────────────

def _oauth_cfg(email, refresh, project="shared-project", user=str(OWNER)):
    from app.core.crypto import encrypt_config
    return encrypt_config({
        "project_id": project, "auth_mode": "google_oauth", "google_oauth_email": email,
        "google_oauth_user_id": user,
        "google_oauth_credentials": json.dumps({"refresh_token": refresh, "client_id": "cid"}),
    })


def test_same_appbi_user_two_google_identities_get_distinct_keys_without_secrets(S):
    import app.services.datasource_service as dsm
    a = dsm._bigquery_client_cache_key(_oauth_cfg("a@example.com", "rt-A-secret-token"))
    b = dsm._bigquery_client_cache_key(_oauth_cfg("b@example.com", "rt-B-secret-token"))
    assert a and b and a != b
    assert str(OWNER) not in a, "the AppBI user is not the credential identity"
    for key in (a, b):
        assert "rt-A-secret-token" not in key and "rt-B-secret-token" not in key


def test_reconnect_changes_the_key(S):
    import app.services.datasource_service as dsm
    k1 = dsm._bigquery_client_cache_key(_oauth_cfg("a@example.com", "rt-1"))
    k2 = dsm._bigquery_client_cache_key(_oauth_cfg("a@example.com", "rt-2"))
    assert k1 != k2


def test_two_sources_two_identities_never_share_a_client(S, monkeypatch):
    import app.services.datasource_service as dsm
    built = []

    class _Client:
        def __init__(self, credentials=None, project=None):
            self.credentials = credentials
            built.append(self)

        def close(self):
            pass

    monkeypatch.setattr(dsm.bigquery, "Client", _Client)
    from app.core.crypto import decrypt_config
    monkeypatch.setattr(dsm, "_build_gcp_credentials", lambda cfg: json.loads(
        decrypt_config(cfg)["google_oauth_credentials"])["refresh_token"])
    dsm._BQ_CLIENT_CACHE.clear()
    cfg_a, cfg_b = _oauth_cfg("a@example.com", "rt-A"), _oauth_cfg("b@example.com", "rt-B")
    ca = dsm._build_bigquery_client(cfg_a)
    cb = dsm._build_bigquery_client(cfg_b)
    assert ca is not cb and ca.credentials == "rt-A" and cb.credentials == "rt-B"
    assert dsm._build_bigquery_client(cfg_a) is ca  # same identity reuses its own client
    dsm._BQ_CLIENT_CACHE.clear()


def test_reconnect_through_the_service_evicts_the_old_client(S, monkeypatch):
    import app.services.datasource_service as dsm
    from app.schemas import DataSourceCreate, DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    dsm._BQ_CLIENT_CACHE.clear()
    with S() as s:
        ds = DataSourceCRUDService.create(s, DataSourceCreate(name="bq", type="bigquery", config={
            "project_id": "p", "auth_mode": "google_oauth", "google_oauth_email": "a@example.com",
            "google_oauth_credentials": json.dumps({"refresh_token": "rt-old"})}), owner_id=OWNER)
        old_key = dsm._bigquery_client_cache_key(dict(ds.config))

        class _C:
            closed = False

            def close(self):
                self.closed = True
        old_client = _C()
        dsm._BQ_CLIENT_CACHE[old_key] = (10**12, old_client)
        pid = _pending(S, refresh="rt-new")
        DataSourceCRUDService.update(s, ds.id, DataSourceUpdate(config={
            "project_id": "p", "auth_mode": "google_oauth", "google_pending_id": pid}), actor=ACTOR)
        new_key = dsm._bigquery_client_cache_key(dict(ds.config))
    assert new_key != old_key
    assert old_key not in dsm._BQ_CLIENT_CACHE and old_client.closed
    dsm._BQ_CLIENT_CACHE.clear()
