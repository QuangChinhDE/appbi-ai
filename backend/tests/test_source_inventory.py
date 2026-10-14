"""The pre-deployment source inventory reports exactly what the connector will do.

Locks the release finding that the new closed-by-default private-network policy
silently cut 14 of 22 existing database sources off after an upgrade: the
inventory must flag every such source BEFORE the deploy, using the very policy
function the connector calls, and must not relax it.
"""
from app.services.source_inventory import evaluate
from app.core.source_network_policy import SourceNetworkPolicyError

ROWS = [
    (1, "warehouse pg", "postgresql", {"host": "10.0.0.5", "port": 5432}),
    (2, "shop mysql", "DataSourceType.MYSQL", '{"host": "10.0.0.6"}'),
    (3, "sheets", "google_sheets", {"spreadsheet_id": "x"}),
    (4, "metadata", "postgresql", {"host": "169.254.169.254", "port": "5432"}),
]


def _policy(allowed):
    def check(host, port):
        if host not in allowed:
            raise SourceNetworkPolicyError(f"Destination {host} refused")
        return host
    return check


def test_only_database_sources_are_inventoried_with_default_ports():
    out = evaluate(ROWS, check=_policy({"10.0.0.5", "10.0.0.6", "169.254.169.254"}))
    assert [(v.id, v.type, v.port) for v in out] == [(1, "postgresql", 5432), (2, "mysql", 3306), (4, "postgresql", 5432)]


def test_a_refused_source_is_blocked_with_the_policy_reason():
    out = {v.id: v for v in evaluate(ROWS, check=_policy({"10.0.0.5"}))}
    assert out[1].verdict == "ALLOWED" and out[1].address == "10.0.0.5"
    assert out[2].verdict == "BLOCKED" and "10.0.0.6" in out[2].reason
    assert out[4].verdict == "BLOCKED"


def test_probe_distinguishes_allowed_but_unreachable():
    def probe(addr, port):
        raise ConnectionRefusedError()
    out = evaluate(ROWS[:1], check=_policy({"10.0.0.5"}), probe=probe)
    assert out[0].verdict == "UNREACHABLE"


def test_real_policy_keeps_metadata_refused_even_when_private_is_allowed(monkeypatch):
    from app.core import source_network_policy as pol

    class S:  # every private range allowlisted — metadata must still be refused
        ALLOWED_PRIVATE_SOURCE_CIDRS = "10.0.0.0/8,169.254.0.0/16"
        SOURCE_ALLOW_PRIVATE_NETWORK = True
    monkeypatch.setattr(pol, "_settings", lambda: S)
    out = {v.id: v for v in evaluate(ROWS, check=pol.resolve_and_check)}
    assert out[1].verdict == "ALLOWED"
    assert out[4].verdict == "BLOCKED"
