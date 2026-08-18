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

import html as _html
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


# ── egress guard ─────────────────────────────────────────────────────────────
# `fetch_url` takes a URL chosen by a MODEL reading an anonymous viewer's
# question on a PUBLIC link, and hands it to httpx. The only check was that the
# string began with http:// or https://.
#
# FOUND BY TESTING, not by reading: probes at localhost, the database port and
# the cloud metadata address all came back refused, which looked like a guard and
# was not — they were rejected by the CONTENT-TYPE filter, because an API returns
# JSON. An internal page that serves HTML went straight through:
#
#     fetch_url("http://frontend:3000/login")          -> ok=True
#     fetch_url("http://appbi-ai-frontend-1:3000/")    -> ok=True
#
# On a cloud deployment the same call reaches 169.254.169.254 and returns
# instance credentials. This is the most serious defect the tool review found,
# and it was invisible to every green test result.
#
# The guard resolves the hostname and refuses any address that is loopback,
# private, link-local, reserved or multicast — resolution first, because a
# hostname that looks public can resolve inward, and that is the whole trick.
# Redirects are followed manually so every hop is checked: validating only the
# first URL is the same hole with an extra step.

_ALLOWED_SCHEMES = ("http", "https")
_MAX_REDIRECTS = 3


def _address_is_internal(host: str) -> str | None:
    """Reason this host must not be fetched, or None when it is safe."""
    import ipaddress
    import socket

    if not host:
        return "no host in url"
    bare = host.strip("[]").lower()
    if bare in ("localhost", "localhost.localdomain") or bare.endswith(".localhost"):
        return "loopback hostname"
    # A name with no dot is a container or a search-domain host — never a real
    # public site, and exactly how `appbi-db` and `frontend` were reachable.
    if "." not in bare and ":" not in bare:
        return f"single-label hostname '{bare}' (internal service name)"
    try:
        infos = socket.getaddrinfo(bare, None)
    except Exception:  # noqa: BLE001 — an unresolvable host is refused, not fetched
        return f"hostname '{bare}' does not resolve"
    for info in infos:
        raw = info[4][0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return f"resolves to a non-public address ({raw})"
    return None


def _check_url(raw: str) -> tuple[str, str | None]:
    """Normalise a URL and say why it is refused, if it is."""
    from urllib.parse import urlparse

    candidate = (raw or "").strip()
    parsed = urlparse(candidate)
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        return candidate, "url must start with http:// or https://"
    reason = _address_is_internal(parsed.hostname or "")
    if reason:
        return candidate, (
            f"refused: {reason}. This tool reads the public internet only — it "
            "must never be pointed at the deployment's own network."
        )
    return candidate, None


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
    # `refused` marks an address the egress guard rejected, as opposed to a
    # network or server failure. The caller collapses both into one error code
    # otherwise, and the two mean opposite things: a refusal is final and about
    # the URL, a fetch failure is transient and worth retrying. Told they were
    # the same, a model given an internal host retries it in a loop.
    url, refusal = _check_url(url)
    if refusal:
        return {"ok": False, "error": refusal, "url": url, "refused": True}
    try:
        # Redirects are followed BY HAND so each hop passes the same check. With
        # `follow_redirects=True` a public URL can 302 straight to an internal
        # one and only the first address is ever examined.
        resp = None
        target = url
        for _ in range(_MAX_REDIRECTS + 1):
            resp = httpx.get(
                target,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
                timeout=20.0,
                follow_redirects=False,
            )
            if resp.status_code not in (301, 302, 303, 307, 308):
                break
            nxt = resp.headers.get("location") or ""
            if not nxt:
                break
            from urllib.parse import urljoin

            target, refusal = _check_url(urljoin(target, nxt))
            if refusal:
                return {"ok": False, "error": f"redirect {refusal}", "url": url,
                        "refused": True}
        else:
            return {"ok": False, "error": "too many redirects", "url": url}
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
    # Same hand-written entity list as `_clean` had, with the same hole. This
    # one is worse: `fetch_url` is what Govern Knowledge Docs crawls web pages
    # with, so a Vietnamese page saved as a Knowledge Doc kept the mangled text
    # in the database, not just in one answer.
    body = _html.unescape(body).replace("\xa0", " ")
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
    """Strip tags and decode entities.

    Two entities were unescaped by hand, which is fine for English and breaks
    every Vietnamese page: the search backend returns titles as numeric
    references — `Một ng&#224;nh đang b&#249;ng nổ` — and the hand-written pair
    does not touch them. The model then reads the mangled form, spends tokens on
    it, and any figure quoted out of it carries the noise.

    `html.unescape` handles the full set, named and numeric, and is stdlib.
    """
    return _html.unescape(_TAG_RE.sub("", text or "")).replace("\xa0", " ").strip()[:limit]


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
