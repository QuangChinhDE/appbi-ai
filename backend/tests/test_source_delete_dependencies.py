"""Source hardening Phase B — delete dependencies (F13).

Locks: the dependency check lives in DataSourceCRUDService.delete (callable
without HTTP) and raises SourceInUseError with structured blockers
[{kind, id, name}] for a non-draft Dataset, a Dataset whose snapshot is hosted
on the source, and a Knowledge Doc reading through it; hidden import drafts are
purged instead of blocking; ResourceShare rows go with the source; the router
maps the error to 409 {code, message, blockers} and only `full` may delete.
"""
from __future__ import annotations

import pytest

from source_phase_b_support import OTHER, OWNER, make_db, make_http, pg_config


@pytest.fixture()
def S(monkeypatch):
    return make_db(monkeypatch)


def _source(S, name="A", ds_type="postgresql", config=None):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    with S() as s:
        return DataSourceCRUDService.create(
            s, DataSourceCreate(name=name, type=ds_type, config=config or pg_config()), owner_id=OWNER).id


def _dataset(S, ds_id, name, draft=False):
    from app.models.dataset import Dataset, DatasetTable
    with S() as s:
        d = Dataset(name=name, owner_id=OWNER, is_draft=draft)
        s.add(d)
        s.flush()
        s.add(DatasetTable(dataset_id=d.id, datasource_id=ds_id, source_kind="physical_table",
                           source_table_name="public.orders", display_name="orders"))
        s.commit()
        return d.id


def _exists(S, ds_id):
    from app.models.models import DataSource
    with S() as s:
        return s.get(DataSource, ds_id) is not None


def test_non_draft_dataset_blocks_with_structured_blockers(S):
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceInUseError
    a = _source(S)
    did = _dataset(S, a, "Revenue")
    with S() as s, pytest.raises(SourceInUseError) as exc:
        DataSourceCRUDService.delete(s, a)
    assert exc.value.blockers == [{"kind": "dataset", "id": did, "name": "Revenue"}]
    assert exc.value.to_detail()["code"] == "source_in_use"
    assert _exists(S, a)


def test_hosted_snapshot_blocks(S):
    from app.models.dataset import Dataset, DatasetTableSnapshot
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceInUseError
    host = _source(S, "Host", "bigquery", {"project_id": "p", "credentials_json": '{"k": "v"}'})
    data = _source(S, "Data")
    did = _dataset(S, data, "Snapshotted")
    with S() as s:
        from app.models.dataset import DatasetTable
        tid = s.query(DatasetTable.id).filter(DatasetTable.dataset_id == did).scalar()
        s.add(DatasetTableSnapshot(dataset_id=did, dataset_table_id=tid, version=1, physical_ref="p.s.t",
                                   fingerprint="f", status="ready", is_current=True, host_datasource_id=host))
        s.commit()
    with S() as s, pytest.raises(SourceInUseError) as exc:
        DataSourceCRUDService.delete(s, host)
    assert exc.value.blockers == [{"kind": "dataset_snapshot", "id": did, "name": "Snapshotted"}]
    # A retired snapshot no longer blocks.
    with S() as s:
        snap = s.query(DatasetTableSnapshot).first()
        snap.status = "superseded"
        s.commit()
        assert s.query(Dataset).count() == 1
    with S() as s:
        assert DataSourceCRUDService.delete(s, host)


def test_knowledge_doc_blocks(S):
    from app.models.governance import GovernKnowledgeDoc
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceInUseError
    docs = _source(S, "Docs", "google_docs", {"auth_mode": "google_oauth",
                                              "google_oauth_credentials": '{"refresh_token": "r"}'})
    with S() as s:
        doc = GovernKnowledgeDoc(title="Handbook", source_type="google_doc",
                                 source_config={"datasource_id": docs, "google_doc_id": "g"})
        s.add(doc)
        s.add(GovernKnowledgeDoc(title="Other", source_type="google_doc",
                                 source_config={"datasource_id": docs + 1000}))
        s.commit()
        doc_id = doc.id
    with S() as s, pytest.raises(SourceInUseError) as exc:
        DataSourceCRUDService.delete(s, docs)
    assert exc.value.blockers == [{"kind": "knowledge_doc", "id": doc_id, "name": "Handbook"}]


def test_draft_is_purged_shares_are_removed_and_delete_succeeds(S, monkeypatch):
    import app.services.dashboard_html_import_service as html_import
    from app.models.dataset import Dataset
    # The real purge query selects the draft; its deep delete (charts, dashboards,
    # semantic rows) is out of scope here — record + delete the Dataset row only.
    purged = []
    monkeypatch.setattr(html_import, "delete_import_draft_dataset",
                        lambda db, d: (purged.append(d.id), db.query(Dataset).filter(
                            Dataset.id == d.id).delete(synchronize_session=False)))
    from app.models.resource_share import ResourceShare
    from app.services.datasource_crud_service import DataSourceCRUDService
    a = _source(S)
    _dataset(S, a, "hidden draft", draft=True)
    with S() as s:
        s.add(ResourceShare(resource_type="datasource", resource_id=str(a), user_id=OTHER,
                            permission="view", shared_by=OWNER))
        s.add(ResourceShare(resource_type="datasource", resource_id=str(a + 1000), user_id=OTHER,
                            permission="view", shared_by=OWNER))
        s.commit()
    with S() as s:
        assert DataSourceCRUDService.delete(s, a)
    assert not _exists(S, a)
    with S() as s:
        assert s.query(Dataset).count() == 0 and len(purged) == 1
        remaining = [r.resource_id for r in s.query(ResourceShare).all()]
    assert remaining == [str(a + 1000)]


def test_http_delete_maps_blockers_to_409_and_requires_full(S, monkeypatch):
    from app.models.resource_share import ResourceShare
    a = _source(S)
    did = _dataset(S, a, "Revenue")
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}, OTHER: {"data_sources": "edit"}})
    with S() as s:
        s.add(ResourceShare(resource_type="datasource", resource_id=str(a), user_id=OTHER,
                            permission="edit", shared_by=OWNER))
        s.commit()
    assert call(OTHER, "DELETE", f"/datasources/{a}").status_code == 403
    r = call(OWNER, "DELETE", f"/datasources/{a}")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "source_in_use" and detail["message"]
    assert detail["blockers"] == [{"kind": "dataset", "id": did, "name": "Revenue"}]
    assert _exists(S, a)


def test_http_delete_without_blockers_returns_204(S, monkeypatch):
    a = _source(S)
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}})
    assert call(OWNER, "DELETE", f"/datasources/{a}").status_code == 204
    assert not _exists(S, a)


def test_router_holds_no_dependency_query():
    import inspect
    import app.api.datasources as api
    src = inspect.getsource(api.delete_data_source)
    assert "Dataset" not in src.replace("Dataset, a hosted", "") and "purge_stale_import_drafts" not in src
