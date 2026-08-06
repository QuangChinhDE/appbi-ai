"""Web search backend for the AI bot's domain-research tool.

Lets the Thinking bot look up *market/domain know-how* for the topic the
viewer is asking about — so the analysis isn't bound only to the admin's
system prompt. It NEVER touches the report's own data (that always comes
from ChartService); web results are external context the model must label
as such.

Backend: Tavily (https://tavily.com) — the common search API for LLM
agents, with a free tier. Configure ``TAVILY_API_KEY`` (or the generic
``WEB_SEARCH_API_KEY``) in the backend env. When no key is set the tool
degrades gracefully (returns ok=False with a clear message) instead of
raising — the agent simply continues without web context.
"""
from __future__ import annotations

import logging
import os
import re
import urllib.parse

import httpx

logger = logging.getLogger(__name__)

_TAVILY_URL = "https://api.tavily.com/search"
_DDG_URL = "https://html.duckduckgo.com/html/"
MAX_RESULTS = 5
_SNIPPET_CHARS = 600


def is_configured() -> bool:
    # Always available now — Tavily when keyed, else the no-key DDG fallback.
    return True


def _has_tavily() -> bool:
    return bool(os.getenv("TAVILY_API_KEY") or os.getenv("WEB_SEARCH_API_KEY"))


def search_web(query: str, *, max_results: int = MAX_RESULTS) -> dict:
    """Run a web search. Returns ``{ok, results|error, query, provider}``.

    Tavily when a key is configured (best quality), otherwise a no-key
    DuckDuckGo HTML fallback so the feature works out of the box. ``results``
    is a list of ``{title, url, snippet}``. Pure function, no DB; safe from a
    worker thread (sync httpx).
    """
    query = (query or "").strip()
    if not query:
        return {"ok": False, "error": "empty query"}
    n = max(1, min(int(max_results or MAX_RESULTS), 8))

    if _has_tavily():
        out = _search_tavily(query, n)
        if out.get("ok"):
            return out
        # Tavily failed (quota/transport) → fall through to the free backend.
        logger.info("web_search tavily failed (%s) → DDG fallback", out.get("error"))
    return _search_ddg(query, n)


def _search_tavily(query: str, n: int) -> dict:
    api_key = os.getenv("TAVILY_API_KEY") or os.getenv("WEB_SEARCH_API_KEY")
    try:
        resp = httpx.post(
            _TAVILY_URL,
            json={
                "api_key": api_key, "query": query, "max_results": n,
                "search_depth": "basic", "include_answer": True,
            },
            timeout=20.0,
        )
        if resp.status_code != 200:
            return {"ok": False, "error": f"tavily {resp.status_code}"}
        data = resp.json()
    except httpx.TimeoutException:
        return {"ok": False, "error": "tavily timeout"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"tavily {type(exc).__name__}"}
    results = []
    for item in (data.get("results") or [])[:n]:
        if isinstance(item, dict):
            results.append({
                "title": str(item.get("title") or "")[:200],
                "url": str(item.get("url") or "")[:500],
                "snippet": str(item.get("content") or "")[:_SNIPPET_CHARS],
            })
    return {
        "ok": True, "provider": "tavily", "query": query,
        "answer": (str(data.get("answer"))[:_SNIPPET_CHARS] if data.get("answer") else None),
        "results": results,
    }


_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_MULTINL_RE = re.compile(r"\n{3,}")


def fetch_url(url: str, *, max_chars: int = 4000, include_html: bool = False) -> dict:
    """Fetch ONE specific page and return its cleaned text.

    Unlike ``search_web`` (which *finds* pages), this *reads* a page the DA
    already trusts — an industry report, a competitor page, a stats portal.
    Returns ``{ok, url, title, text, truncated}``. Pure function, sync httpx,
    safe from a worker thread. External content — the model must label it as
    such and never treat it as the report's own data.

    ``include_html`` additionally returns the RAW page html under "html" — used
    by Govern Knowledge Docs to keep a viewable snapshot of a crawled page. It
    is never rendered as trusted markup: the FE shows it in a script-less
    sandboxed iframe.
    """
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "url must start with http:// or https://"}
    try:
        resp = httpx.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            timeout=20.0,
            follow_redirects=True,
        )
        if resp.status_code != 200:
            return {"ok": False, "error": f"fetch failed: HTTP {resp.status_code}", "url": url}
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype and "text" not in ctype and ctype:
            return {"ok": False, "error": f"unsupported content-type: {ctype}", "url": url}
        html = resp.text
    except httpx.TimeoutException:
        return {"ok": False, "error": "fetch timed out", "url": url}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"fetch transport error: {type(exc).__name__}", "url": url}

    title_m = _TITLE_RE.search(html)
    title = _clean(title_m.group(1), 200) if title_m else ""
    body = _SCRIPT_STYLE_RE.sub(" ", html)
    body = _TAG_RE.sub("\n", body)
    body = body.replace("&amp;", "&").replace("&#x27;", "'").replace("&nbsp;", " ").replace("&quot;", '"')
    body = _WS_RE.sub(" ", body)
    body = _MULTINL_RE.sub("\n\n", body).strip()
    truncated = len(body) > max_chars
    out = {
        "ok": True,
        "url": str(resp.url)[:500],
        "title": title,
        "text": body[:max_chars],
        "truncated": truncated,
    }
    if include_html:
        out["html"] = html
    return out


_DDG_LINK_RE = re.compile(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_DDG_SNIP_RE = re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: str, limit: int) -> str:
    return _TAG_RE.sub("", text or "").replace("&amp;", "&").replace("&#x27;", "'").strip()[:limit]


def _unwrap_ddg(url: str) -> str:
    # DDG sometimes wraps targets as //duckduckgo.com/l/?uddg=<encoded>
    if "uddg=" in url:
        try:
            q = urllib.parse.urlparse("https:" + url if url.startswith("//") else url)
            uddg = urllib.parse.parse_qs(q.query).get("uddg")
            if uddg:
                return urllib.parse.unquote(uddg[0])
        except Exception:
            pass
    return ("https:" + url) if url.startswith("//") else url


def _search_ddg(query: str, n: int) -> dict:
    try:
        resp = httpx.post(
            _DDG_URL,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            data={"q": query},
            timeout=20.0,
        )
        if resp.status_code != 200:
            return {"ok": False, "error": f"web search error {resp.status_code}"}
        html = resp.text
    except httpx.TimeoutException:
        return {"ok": False, "error": "web search timed out"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"web search transport error: {type(exc).__name__}"}

    links = _DDG_LINK_RE.findall(html)
    snips = _DDG_SNIP_RE.findall(html)
    results = []
    for (url, title), snip in list(zip(links, snips))[:n]:
        results.append({
            "title": _clean(title, 200),
            "url": _unwrap_ddg(url)[:500],
            "snippet": _clean(snip, _SNIPPET_CHARS),
        })
    if not results:
        return {"ok": False, "error": "no web results found"}
    return {"ok": True, "provider": "duckduckgo", "query": query, "answer": None, "results": results}
