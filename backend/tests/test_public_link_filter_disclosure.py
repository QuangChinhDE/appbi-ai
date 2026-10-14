"""What a public viewer is told about the link's own filters.

A link can lock (🔒) or hide (🚫) a field. Both are applied server-side from
DashboardPublicLink.filters_config; the viewer's page never re-sends them.

Before this, the public structure response still carried the link's WHOLE
filters_config (`public_link_hidden_filters`) — hidden fields and their values
included — to anonymous viewers who had no use for it, while the reader of a
locked link was told nothing: the numbers were filtered with no indication.

Now the viewer is shown exactly the locked entries that enforce a value
(read-only, so the page can say "filtered by …"), and nothing about a hidden
entry, a 'limit' scope entry, an empty lock, or an entry its author set
`showBanner: false` on. The operator is served with the value: a link that
EXCLUDES RJ must never be announced as "filtered by RJ".
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
EXCLUDES = {"field": "seller_state", "label": "Seller state", "operator": "not_in", "value": ["SP"], "publicMode": "locked"}
QUIET = {"field": "channel", "label": "Channel", "operator": "in", "value": ["Online"], "showBanner": False}


def test_only_locked_value_entries_are_shown_and_only_their_display_fields():
    shown = link_filters_a_viewer_may_see([LOCKED, HIDDEN, HIDDEN_KILL, EMPTY_LOCK, SCOPE])
    assert shown == [{"field": "customer_state", "label": "Customer state", "value": ["RJ"], "operator": "in",
                      "semanticField": "t3.customer_state"}]


def test_an_exclusion_is_served_as_an_exclusion():
    # Without the operator the page can only say "Seller state: SP" — the
    # opposite of what the link enforces.
    assert link_filters_a_viewer_may_see([EXCLUDES]) == [
        {"field": "seller_state", "label": "Seller state", "value": ["SP"], "operator": "not_in"}]


def test_a_lock_is_served_as_the_engine_enforces_it():
    # An M2M claim stored as `in "SP"` is enforced as `in ["SP"]` — the page
    # must be able to state it (a scalar under `in` read as "no value" and the
    # page said nothing). `ne` / `<>` are the engine's `neq`.
    scalar = {"field": "customer_state", "operator": "in", "value": "SP"}
    ne = {"field": "seller_state", "operator": "<>", "value": "RJ"}
    preset = {"field": "order_date", "operator": "between", "value": ["2026-01-01", "2026-01-31"], "datePreset": "last_30_days"}
    shown = {e["field"]: e for e in link_filters_a_viewer_may_see([scalar, ne, preset])}
    assert shown["customer_state"]["operator"] == "in" and shown["customer_state"]["value"] == ["SP"]
    assert shown["seller_state"]["operator"] == "neq"
    assert shown["order_date"]["datePreset"] == "last_30_days", "a relative-date lock is served as a frozen range"


def test_what_is_served_is_what_the_engine_keeps():
    # A lock the engine drops (empty_value) must not be announced; a lock with
    # no value that the engine enforces (is_null) must be.
    dropped = [{"field": "amount", "operator": "between", "value": 5},
               {"field": "store", "operator": "in", "value": 5}]
    assert link_filters_a_viewer_may_see(dropped) == [], "a lock the engine drops is announced"
    [null_lock] = link_filters_a_viewer_may_see([{"field": "closed_at", "operator": "is_null", "value": None}])
    assert null_lock["operator"] == "is_null", "an enforced is_null lock is silent"


def test_an_entry_the_author_keeps_off_the_banner_is_not_served():
    assert link_filters_a_viewer_may_see([QUIET, LOCKED])[0]["field"] == "customer_state"
    assert "Online" not in json.dumps(link_filters_a_viewer_may_see([QUIET]))


def test_a_hidden_field_or_value_never_appears_in_what_is_served():
    served = json.dumps(link_filters_a_viewer_may_see([HIDDEN, HIDDEN_KILL, SCOPE, EMPTY_LOCK]))
    for secret in ("tenant_id", "acme-42", "Tenant", "segment", "RC01", "store"):
        assert secret not in served, f"{secret!r} leaked to a public viewer"


def test_the_public_endpoint_serves_the_rule_not_the_raw_link_config():
    src = (Path(__file__).resolve().parents[1] / "app" / "api" / "public.py").read_text(encoding="utf-8")
    assert "dash.public_link_locked_filters = link_filters_a_viewer_may_see(link_hidden_filters)" in src
    assert "dash.public_link_hidden_filters = []" in src
    assert "dash.public_link_hidden_filters = list(link_hidden_filters" not in src, "the raw link config is served again"
