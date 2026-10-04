"""A client cannot choose the address its rate limits are keyed on.

Before: uvicorn ran with `--forwarded-allow-ips="*"`, which takes the LEFTMOST
X-Forwarded-For entry as the client. nginx appends the address it saw, so the
leftmost entry is the one the client wrote. Rotating it gave every request a
new identity and defeated every per-IP limit — the public-link password limit
(10/min) included.

After: app/core/trusted_proxy.TrustedProxyMiddleware honours forwarded headers
only from a trusted peer and takes the entry TRUSTED_PROXY_HOPS from the right.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI, Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from slowapi import _rate_limit_exceeded_handler

from app.core.trusted_proxy import TrustedProxyMiddleware

NGINX_PEER = "172.18.0.1"  # host nginx through the Docker gateway


@pytest.fixture()
def mw():
    return TrustedProxyMiddleware(app=None, trusted_cidrs="127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16", hops=1)


def test_the_client_written_part_of_xff_is_ignored(mw):
    # The client sent "6.6.6.6"; nginx appended the address it really saw.
    assert mw.resolve(NGINX_PEER, "6.6.6.6, 203.0.113.7") == "203.0.113.7"
    assert mw.resolve(NGINX_PEER, "1.1.1.1, 2.2.2.2, 203.0.113.7") == "203.0.113.7"


def test_a_lan_client_is_still_itself(mw):
    assert mw.resolve(NGINX_PEER, "6.6.6.6, 10.0.0.5") == "10.0.0.5"


def test_an_untrusted_peer_cannot_use_forwarded_headers(mw):
    assert mw.resolve("198.51.100.9", "6.6.6.6") == "198.51.100.9"


def test_no_header_or_garbage_falls_back_to_the_peer(mw):
    assert mw.resolve(NGINX_PEER, None) == NGINX_PEER
    assert mw.resolve(NGINX_PEER, "") == NGINX_PEER
    assert mw.resolve(NGINX_PEER, "not-an-ip") == NGINX_PEER
    assert mw.resolve("testclient", "6.6.6.6") == "testclient"


def test_two_hops_when_a_load_balancer_sits_in_front_of_nginx():
    m = TrustedProxyMiddleware(app=None, trusted_cidrs="172.16.0.0/12", hops=2)
    # client-written, then LB's view of the client, then nginx's view (the LB)
    assert m.resolve(NGINX_PEER, "6.6.6.6, 203.0.113.7, 10.1.2.3") == "203.0.113.7"
    assert m.resolve(NGINX_PEER, "203.0.113.7") == NGINX_PEER  # fewer entries than hops


def _app():
    limiter = Limiter(key_func=get_remote_address)
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.post("/auth")
    @limiter.limit("10/minute")
    def auth(request: Request):
        return {"seen": request.client.host}

    @app.get("/whoami")
    def whoami(request: Request):
        return {"client": request.client.host, "scheme": request.url.scheme}

    app.add_middleware(TrustedProxyMiddleware, trusted_cidrs="172.16.0.0/12", hops=1)
    return app


async def _post_many(app, n, xff_for_i, peer=NGINX_PEER):
    transport = httpx.ASGITransport(app=app, client=(peer, 40000))
    async with httpx.AsyncClient(transport=transport, base_url="http://backend") as c:
        return [
            (await c.post("/auth", headers={"X-Forwarded-For": xff_for_i(i)})).status_code
            for i in range(n)
        ]


def test_rotating_a_spoofed_xff_does_not_escape_the_rate_limit():
    codes = asyncio.run(_post_many(_app(), 12, lambda i: f"6.6.6.{i}, 203.0.113.7"))
    assert codes[:10] == [200] * 10
    assert codes[10:] == [429, 429], codes


def test_two_real_viewers_behind_nginx_keep_separate_buckets():
    app = _app()
    a = asyncio.run(_post_many(app, 10, lambda i: "203.0.113.7"))
    b = asyncio.run(_post_many(app, 10, lambda i: "203.0.113.8"))
    assert a == [200] * 10 and b == [200] * 10


def test_forwarded_proto_is_honoured_from_a_trusted_peer_only():
    async def go(peer):
        transport = httpx.ASGITransport(app=_app(), client=(peer, 1))
        async with httpx.AsyncClient(transport=transport, base_url="http://backend") as c:
            r = await c.get("/whoami", headers={"X-Forwarded-Proto": "https", "X-Forwarded-For": "6.6.6.6, 203.0.113.7"})
            return r.json()
    assert asyncio.run(go(NGINX_PEER)) == {"client": "203.0.113.7", "scheme": "https"}
    assert asyncio.run(go("198.51.100.9")) == {"client": "198.51.100.9", "scheme": "http"}


def test_the_backend_no_longer_trusts_every_forwarder():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    entry = (root / "entrypoint.sh").read_text(encoding="utf-8")
    launch = entry[entry.index("exec uvicorn"):]
    assert '--forwarded-allow-ips="*"' not in launch
    assert "--no-proxy-headers" in launch
    main = (root / "app" / "main.py").read_text(encoding="utf-8")
    assert "app.add_middleware(TrustedProxyMiddleware)" in main
