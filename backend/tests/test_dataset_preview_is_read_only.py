"""Preview never rewrites the shared table caches once they exist.

Every Preview call (any viewer, any page, any filter) overwrote
``columns_cache`` with types guessed from that page's first 20 rows (all
``string`` when a filter matched nothing) and ``sample_cache`` with that page,
then resynced the semantic model. Page 8 became the sample LOOKUP formulas,
Table Stats and AI descriptions read. Preview now only SEEDS an empty cache from
the unfiltered first page.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.api.datasets import _preview_may_seed_cache

SEEDED = SimpleNamespace(columns_cache={"columns": [{"name": "amount", "type": "number"}]},
                         sample_cache=[{"amount": 1}])
EMPTY = SimpleNamespace(columns_cache=None, sample_cache=None)


@pytest.mark.parametrize("offset,filtered", [(0, False), (500, False), (0, True), (500, True)])
def test_a_seeded_table_is_never_rewritten(offset, filtered):
    assert _preview_may_seed_cache(SEEDED, offset=offset, filtered=filtered) is False


def test_an_empty_table_is_seeded_only_from_the_unfiltered_first_page():
    assert _preview_may_seed_cache(EMPTY, offset=0, filtered=False) is True
    assert _preview_may_seed_cache(EMPTY, offset=500, filtered=False) is False
    assert _preview_may_seed_cache(EMPTY, offset=0, filtered=True) is False


def test_the_preview_route_gates_its_writes():
    import inspect

    from app.api import datasets

    src = inspect.getsource(datasets.preview_dataset_table)
    gate = src.index("_preview_may_seed_cache(")
    assert gate < src.index("update_table_cache(") and gate < src.index("_sync_dataset_model_safely(")
