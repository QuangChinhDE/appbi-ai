"""Fetch a web page's text for a Govern Knowledge Doc with source_type ==
'web'. Thin wrapper around the AI bot's existing `web_search.fetch_url` (httpx
+ regex HTML cleanup) rather than a re-implementation — kept in this separate
module so Govern doesn't import `dashboard_ai_bot` package internals directly,
and so the larger `max_chars` needed for a full document capture never
affects the bot's own research-snippet call sites.
"""
from __future__ import annotations

_FULL_PAGE_MAX_CHARS = 20_000
# Snapshot cap — a crawled page is kept so the reader can see the ORIGINAL
# layout; anything past this is almost certainly embedded media/base64 noise.
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024


def fetch_web_page(url: str) -> dict:
    """Returns {ok, title, text, html, error}. `html` is the raw page source,
    kept as a viewable snapshot (rendered ONLY inside a script-less sandboxed
    iframe — never as trusted markup). Never raises."""
    from app.services.dashboard_ai_bot.web_search import fetch_url

    result = fetch_url(url, max_chars=_FULL_PAGE_MAX_CHARS, include_html=True)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "Failed to fetch the page."}
    text = (result.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "Page has no readable text content."}
    html = result.get("html") or ""
    html_bytes = html.encode("utf-8", errors="ignore")[:MAX_SNAPSHOT_BYTES]
    return {
        "ok": True,
        "title": result.get("title") or "",
        "text": text,
        "html": html_bytes,
        "final_url": result.get("url") or url,
    }
