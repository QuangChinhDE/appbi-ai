# -*- coding: utf-8 -*-
"""The node registry survives its first use from many threads at once.

REPRODUCED (500 after a restart). Sync endpoints run in a thread pool, and the
builder's first screen asks for the flow and the node palette in parallel. Both
reached `nodes._load()` with an empty registry, both registered every spec, and
the second raised "node type 'agent' registered twice" — `GET /agent-flows/nodes`
answered 500 on the first page load after the backend restarted.

INVARIANT: `_load()` fills the registry exactly once, and no thread ever sees it
half-filled.
"""
from __future__ import annotations

import threading

from app.services.agent_flows.runtime import nodes


def test_many_threads_loading_the_registry_at_once_all_succeed(monkeypatch):
    monkeypatch.setattr(nodes, "_REGISTRY", {})
    errors: list[BaseException] = []
    seen: list[int] = []
    start = threading.Barrier(16)

    def first_use():
        try:
            start.wait()
            spec = nodes.spec_for("agent")
            # A half-published registry would answer None for a real type.
            assert spec is not None
            seen.append(len(nodes._REGISTRY))
        except BaseException as exc:  # noqa: BLE001 — collected, asserted below
            errors.append(exc)

    threads = [threading.Thread(target=first_use) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], errors
    assert len(set(seen)) == 1, f"threads saw different registry sizes: {sorted(set(seen))}"
    assert {"agent", "coordinate"} <= set(nodes._REGISTRY)


def test_a_duplicate_type_is_still_refused():
    """The lock must not have turned the duplicate check into a silent overwrite."""
    import pytest

    existing = nodes.spec_for("agent")
    with pytest.raises(ValueError, match="registered twice"):
        nodes.register(existing)
