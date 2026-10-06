"""The central egress policy (app/core/egress.py), at the network level.

What is asserted with REAL sockets:
* a loopback / metadata / private destination is refused before any packet is
  sent: a live TCP listener on 127.0.0.1 records zero connections;
* the connection goes to the address validated at resolution time (DNS
  rebinding cannot swap it afterwards);
* a 3xx is never followed - the redirect target receives nothing.
"""
from __future__ import annotations

import http.server
import ipaddress
import socket
import threading

import pytest

from app.core import egress


# ── address classes ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("ip", [
    "127.0.0.1", "127.1.2.3", "::1", "0.0.0.0", "::", "169.254.169.254", "169.254.0.1",
    "fd00:ec2::254", "100.100.100.200", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::", "fe80::1",
])
def test_always_forbidden(ip):
    assert egress.classify(ip) == "forbidden"


@pytest.mark.parametrize("ip", ["10.1.2.3", "172.16.0.5", "192.168.1.1", "100.64.0.1", "fc00::1",
                                "::ffff:10.0.0.1"])
def test_private(ip):
    assert egress.classify(ip) == "private"


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
def test_public(ip):
    assert egress.classify(ip) == "public"


@pytest.mark.parametrize("host", ["127.0.0.1", "2130706433", "0x7f000001", "017700000001", "localhost",
                                  "[::1]", "::ffff:127.0.0.1"])
def test_numeric_and_named_loopback_spellings_are_refused(host):
    with pytest.raises(egress.EgressDenied):
        egress.check_destination(host, 80)


def test_hostname_resolving_privately_is_refused_unless_allowlisted(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda h, p, **k: [(socket.AF_INET, 1, 6, "", ("10.9.8.7", p))])
    with pytest.raises(egress.EgressDenied):
        egress.check_destination("warehouse.corp", 5432)
    assert egress.check_destination("warehouse.corp", 5432,
                                    private_cidrs=[ipaddress.ip_network("10.9.0.0/16")]) == "10.9.8.7"
    assert egress.check_destination("warehouse.corp", 5432, allowed_hosts=["warehouse.corp"]) == "10.9.8.7"


def test_any_forbidden_address_in_the_answer_refuses(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda h, p, **k: [
        (socket.AF_INET, 1, 6, "", ("93.184.216.34", p)),
        (socket.AF_INET, 1, 6, "", ("169.254.169.254", p)),
    ])
    with pytest.raises(egress.EgressDenied):
        egress.check_destination("mixed.example", 443)


def test_allowlisted_private_cidr_never_allows_loopback_or_metadata(monkeypatch):
    monkeypatch.setenv("EGRESS_HTTP_ALLOW_CIDRS", "0.0.0.0/0,::/0")
    for url in ("http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"):
        with pytest.raises(egress.EgressDenied):
            egress.validate_http_url(url)


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "gopher://x",
                                 "http://user:pw@example.com/", "http:///nohost", "javascript:alert(1)"])
def test_bad_url_shapes(url):
    with pytest.raises(egress.EgressDenied):
        egress.validate_http_url(url)


# ── real sockets ────────────────────────────────────────────────────────────

class _Listener:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self._stop = False
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self):
        while not self._stop:
            try:
                c, _ = self.sock.accept()
                self.connections += 1
                c.close()
            except OSError:
                continue

    def close(self):
        self._stop = True
        self.t.join(1)
        self.sock.close()


@pytest.fixture()
def listener():
    lst = _Listener()
    yield lst
    lst.close()


def test_http_post_to_loopback_sends_nothing(listener):
    with pytest.raises(egress.EgressDenied):
        egress.http_post(f"http://127.0.0.1:{listener.port}/hook", json={"secret": "x"})
    assert listener.connections == 0


def test_pg_connect_to_loopback_sends_nothing(listener):
    with pytest.raises(egress.EgressDenied):
        egress.pg_connect(host="127.0.0.1", port=listener.port, user="u", password="stored-secret",
                          dbname="d", connect_timeout=2)
    assert listener.connections == 0


def test_mysql_connect_to_loopback_sends_nothing(listener):
    with pytest.raises(egress.EgressDenied):
        egress.mysql_connect(host="localhost", port=listener.port, user="u", password="stored-secret",
                             database="d", connect_timeout=2)
    assert listener.connections == 0


def test_dsn_and_socket_forms_are_refused():
    with pytest.raises(egress.EgressDenied):
        egress.pg_connect(dsn="host=127.0.0.1 password=x")
    with pytest.raises(egress.EgressDenied):
        egress.mysql_connect(unix_socket="/var/run/mysqld/mysqld.sock")


class _Redirect(http.server.BaseHTTPRequestHandler):
    target = ""

    def do_POST(self):  # noqa: N802
        self.send_response(302)
        self.send_header("Location", self.target)
        self.end_headers()

    def log_message(self, *a):
        pass


def test_redirect_is_never_followed_and_connection_is_pinned(monkeypatch, listener):
    """The policy is relaxed ONLY for 127.0.0.1 here so a local server can stand
    in for a public one; the redirect target (another local port) must receive
    nothing, and the request must go to the pinned address even if DNS would
    answer differently on a second lookup."""
    real_classify = egress.classify
    monkeypatch.setattr(egress, "classify", lambda ip: "public" if str(ip) == "127.0.0.1" else real_classify(ip))
    _Redirect.target = f"http://127.0.0.1:{listener.port}/stolen"
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Redirect)
    threading.Thread(target=srv.handle_request, daemon=True).start()
    real_gai = socket.getaddrinfo
    lookups = []

    def _gai(h, p, *a, **k):
        if h == "hook.example":
            lookups.append(h)
            if len(lookups) > 1:  # a re-resolution would be a rebinding window
                raise AssertionError("hostname resolved twice")
            return [(socket.AF_INET, 1, 6, "", ("127.0.0.1", p))]
        return real_gai(h, p, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", _gai)
    r = egress.http_post(f"http://hook.example:{srv.server_address[1]}/in", json={"a": 1}, timeout=5)
    srv.server_close()
    assert r.status_code == 302
    assert listener.connections == 0
    assert lookups == ["hook.example"]
