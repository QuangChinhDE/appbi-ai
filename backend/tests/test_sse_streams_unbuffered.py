"""Server-Sent Events leave the backend event by event, uncompressed.

Acceptance on the real stack (2026-10-27): every event of a chat turn - `accepted`,
the progress lines, `final` - reached the browser in the same instant, at the end
of the turn, both through the edge and directly on :8000 (`content-encoding: gzip`).
Starlette 0.35's GZipMiddleware compresses a streamed `text/event-stream` and keeps
small writes inside the gzip compressor until the stream closes. So the page never
learnt the turn id while the turn ran: Stop had nothing to cancel, and no progress
was shown. The public dashboard AI streams through the same middleware.

The checks drive the REAL app's middleware stack (in a subprocess, like the
architecture contract) with a probe route added before the first request.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]

_PROBE = r'''
import asyncio, json, sys
from fastapi.responses import JSONResponse, StreamingResponse
from app.main import app

async def events():
    for i in range(3):
        yield f"data: {json.dumps({'i': i, 'pad': 'x' * 600})}\n\n"
        await asyncio.sleep(0)

app.add_api_route("/__probe/sse", lambda: StreamingResponse(events(), media_type="text/event-stream"))
app.add_api_route("/__probe/json", lambda: JSONResponse({"rows": ["y" * 50] * 100}))

async def call(path):
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
             "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
             "headers": [(b"host", b"testserver"), (b"accept-encoding", b"gzip, deflate"),
                         (b"accept", b"text/event-stream")],
             "client": ("127.0.0.1", 5000), "server": ("testserver", 80)}
    sent, requested, never = [], [], asyncio.Event()
    async def receive():
        # the request once, then an open connection (no disconnect) like a real client
        if not requested:
            requested.append(1)
            return {"type": "http.request", "body": b"", "more_body": False}
        await never.wait()
    async def send(message):
        sent.append(message)
    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
    bodies = [m.get("body", b"") for m in sent if m["type"] == "http.response.body" and m.get("body")]
    return {"status": start["status"], "encoding": headers.get("content-encoding"),
            "bodies": [b[:5].decode("latin-1") for b in bodies]}

out = {p: asyncio.run(call(p)) for p in ("/__probe/sse", "/__probe/json")}
sys.stdout.write("RESULT" + json.dumps(out))
'''


@pytest.fixture(scope="module")
def probe() -> dict:
    env = {**os.environ, "PYTHONPATH": str(BACKEND), "ENVIRONMENT": "test",
           "DATABASE_URL": os.environ.get("DATABASE_URL") or "sqlite:///./sse_check.db"}
    out = subprocess.run([sys.executable, "-c", _PROBE], cwd=BACKEND, env=env, capture_output=True,
                         text=True, encoding="utf-8", timeout=300)
    assert out.returncode == 0, out.stderr[-3000:]
    return json.loads(out.stdout[out.stdout.index("RESULT") + len("RESULT"):])


def test_an_event_stream_is_sent_event_by_event_and_never_compressed(probe):
    sse = probe["/__probe/sse"]
    assert sse["status"] == 200
    assert sse["encoding"] is None, "a compressed event stream is held in the compressor until it ends"
    assert sse["bodies"] == ["data:"] * 3, f"each event must leave on its own, readable: {sse['bodies']}"


def test_a_large_ordinary_response_is_still_compressed(probe):
    # the fix narrows compression for event streams only; chart payloads keep gzip
    assert probe["/__probe/json"]["encoding"] == "gzip"
