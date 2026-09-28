"""What a public viewer is told about the link's own filters.

A link can lock (🔒) or hide (🚫) a field. Both are applied server-side from
DashboardPublicLink.filters_config; the viewer's page never re-sends them.

Before this, the public structure response still carried the link's WHOLE
filters_config (`public_link_hidden_filters`) — hidden fields and their values
included — to anonymous viewers who had no use for it, while the reader of a
locked link was told nothing: the numbers were filtered with no indication.

Now the viewer is shown exactly the locked entries that enforce a value
(read-only, so the page can say "filtered by …"), and nothing about a hidden
entry, a 'limit' scope entry, or an empty lock.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.services.filter_layered_merge import link_filters_a_viewer_may_see

LOCKED = {"field": "customer_state", "semanticField": "t3.customer_state", "label": "Customer state",
          "operator": "in", "value": ["RJ"], "publicMode": "locked", "datasetId": 1}
HIDDEN = {"field": "tenant_id", "operator": "in", "value": ["acme-42"], "hidden": True, "label": "Tenant"}
HIDDEN_KILL = {"field": "segment", "hidden": True}
EMPTY_LOCK = {"field": "region", "operator": "in", "value": []}
SCOPE = {"field": "store", "operator": "in", "value": ["RC01", "RC02"], "limit": True}


def test_only_locked_value_entries_are_shown_and_only_their_display_fields():
    shown = link_filters_a_viewer_may_see([LOCKED, HIDDEN, HIDDEN_KILL, EMPTY_LOCK, SCOPE])
    assert shown == [{"field": "customer_state", "label": "Customer state", "value": ["RJ"], "semanticField": "t3.customer_state"}]


def test_a_hidden_field_or_value_never_appears_in_what_is_served():
    served = json.dumps(link_filters_a_viewer_may_see([HIDDEN, HIDDEN_KILL, SCOPE, EMPTY_LOCK]))
    for secret in ("tenant_id", "acme-42", "Tenant", "segment", "RC01", "store"):
        assert secret not in served, f"{secret!r} leaked to a public viewer"


def test_the_public_endpoint_serves_the_rule_not_the_raw_link_config():
    src = (Path(__file__).resolve().parents[1] / "app" / "api" / "public.py").read_text(encoding="utf-8")
    assert "dash.public_link_locked_filters = link_filters_a_viewer_may_see(link_hidden_filters)" in src
    assert "dash.public_link_hidden_filters = []" in src
    assert "dash.public_link_hidden_filters = list(link_hidden_filters" not in src, "the raw link config is served again"
