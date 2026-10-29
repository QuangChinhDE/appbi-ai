"""Response compression that never holds back a Server-Sent Events stream.

Starlette 0.35's GZipMiddleware compresses a streamed ``text/event-stream`` too,
and its gzip compressor keeps small writes until the stream closes: every event
of a chat turn (``accepted``, progress, ``final``) then reaches the client at the
end, together - so the page cannot Stop a running turn or show its progress.
Newer Starlette (0.41+) leaves event streams alone; this does the same here. The
responder already passes a response through untouched when it carries its own
Content-Encoding; an event stream is treated the same way.
"""
from __future__ import annotations

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import Message, Receive, Scope, Send


class _StreamSafeGZipResponder(GZipResponder):
    async def send_with_gzip(self, message: Message) -> None:
        await super().send_with_gzip(message)
        if message["type"] == "http.response.start":
            content_type = Headers(raw=message["headers"]).get("content-type", "")
            if content_type.startswith("text/event-stream"):
                self.content_encoding_set = True  # pass every event through as it is written


class StreamSafeGZipMiddleware(GZipMiddleware):
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and "gzip" in Headers(scope=scope).get("Accept-Encoding", ""):
            responder = _StreamSafeGZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)
            await responder(scope, receive, send)
            return
        await self.app(scope, receive, send)
