"""Search several angles, open the best pages, return the passages that answer.

WHY THIS EXISTS
---------------
The catalogue already had the two primitives a web answer needs — `web_search`
finds pages, `fetch_url` reads one. What it did not have is the LOOP between
them, and that loop is most of what a browsing assistant actually does:

    ask several angles → merge and rank the results → open the promising ones
    → keep only the passages that bear on the question → hand back evidence
    that is bound to a numbered source

Left to the model, every arrow in that chain is a separate round-trip: search,
read the results, decide, fetch, read, fetch again. Five or six model calls with
the whole conversation resent each time, to do work that contains no judgement
worth paying for. Here the arrows are code and cost nothing, and the model is
asked for the one thing it is genuinely better at — writing good queries — once,
at the start.

WHAT IT REFUSES TO DO
---------------------
It does not summarise. A synthesis with no method is the thing this review has
spent its whole length removing, and `browse_ai_answer` already showed what
scraping somebody else's costs in trust. This returns QUOTED PASSAGES with the
source each came from, so every external claim in an answer can name the page it
stands on — the same discipline `[chart:N]` imposes on internal numbers.

It does not pretend a page was read when it was not. A JavaScript-rendered page
returns almost no text to a plain HTTP fetch; instead of passing that off as
"read the page", each source declares whether its passages came from the page
body or only from the search snippet.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from app.services.agent_flows.tools import result as R
from app.services.dashboard_ai_bot.tool_context import ToolContext

#: How many pages to actually open. Each is an HTTP round trip and a slice of
#: the payload; three covers agreement between independent sources without
#: turning one tool call into a crawl.
DEFAULT_READ_TOP = 3
MAX_READ_TOP = 5

#: Per-source passage budget. The point is evidence, not the page.
MAX_PASSAGES = 4
PASSAGE_CHARS = 320

#: How many of the question's own words a sentence must contain to count as
#: bearing on it. TOPICAL OVERLAP ONLY — carrying a number does not substitute.
#:
#: The first version scored overlap and a digit bonus together against a floor
#: of 2, so one generic word plus any figure cleared it, and a nonsense query
#: came back looking answered about one run in four. Prose is full of numbers;
#: a digit says nothing about whether the sentence is on topic. It stays a
#: ranking signal and stops being an entry ticket.
MIN_OVERLAP = 2

#: Below this much extracted body text, a fetch did not really read the page —
#: it hit a JS shell, a consent wall or a paywall. Measured against real pages:
#: a genuine article yields thousands of characters.
MIN_BODY_CHARS = 400

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")
_WORD = re.compile(r"[0-9A-Za-zÀ-ỹ]+", re.UNICODE)
_HAS_DIGIT = re.compile(r"\d")

#: Words that carry no topic. Kept short deliberately — an over-long stop list
#: silently drops the term that mattered.
_STOP = frozenset("""
the a an of in on for to and or is are was were be been being with by at from
as that this these those it its will can could would should how what which who
bao nhiêu là gì của và các những một cho với về khi thì mà nếu có không được
này đó đây trong ngoài trên dưới theo như vì nên hay hoặc đã sẽ đang
""".split())


def _keywords(question: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(question or "")
            if len(w) > 2 and w.lower() not in _STOP}


def _norm_url(url: str) -> str:
    """Same page under two spellings is one source."""
    try:
        p = urlparse(url)
        host = (p.netloc or "").lower().removeprefix("www.")
        path = (p.path or "/").rstrip("/") or "/"
        return f"{host}{path}"
    except Exception:  # noqa: BLE001
        return (url or "").strip().lower()


def _passages(text: str, keys: set[str], *, want_numbers: bool) -> list[str]:
    """Sentences that bear on the question, best first.

    Scored on how many of the question's own words a sentence carries, with a
    bonus for containing a figure — market questions are answered by numbers,
    and a sentence about the topic with no number rarely settles anything.
    """
    scored: list[tuple[float, str]] = []
    seen: set[str] = set()
    # A one-word question would otherwise never match anything.
    need = min(MIN_OVERLAP, len(keys)) or 1
    for raw in _SENTENCE_SPLIT.split(text or ""):
        s = " ".join(raw.split())
        if not (40 <= len(s) <= 600):
            continue
        words = {w.lower() for w in _WORD.findall(s)}
        overlap = len(words & keys)
        if overlap < need:
            continue
        score = float(overlap)
        if want_numbers and _HAS_DIGIT.search(s):
            score += 2.0
        key = s[:60].lower()
        if key in seen:
            continue
        seen.add(key)
        scored.append((score, s))
    scored.sort(key=lambda p: -p[0])
    return [s[:PASSAGE_CHARS] for _, s in scored[:MAX_PASSAGES]]


#: A date printed on the page. Only formats unambiguous enough to be worth
#: reporting — a bare "05/06" could be either order and is left alone.
_DATE_PATTERNS = (
    re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b"),
    re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b"),
    re.compile(r"\b(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})[,\s]+(20\d{2})\b", re.I),
)


def _published(text: str) -> str | None:
    head = (text or "")[:1500]
    for pat in _DATE_PATTERNS:
        m = pat.search(head)
        if m:
            return m.group(0)
    return None


def tool_research_web(ctx: ToolContext, args: dict) -> dict:
    """Run several searches, open the best sources, return bound evidence."""
    question = args.get("question")
    queries = args.get("queries")
    if not isinstance(question, str) or not question.strip():
        return R.err("question (str) is required — what the evidence must answer",
                     code="bad_argument")
    if isinstance(queries, str):
        queries = [queries]
    if not isinstance(queries, list) or not queries:
        return R.err(
            "queries (list of 2-4 search strings) is required. Write SEVERAL "
            "angles on the question, not one — different phrasings surface "
            "different sources, and agreement between them is the only signal "
            "here that a figure is real.",
            code="bad_argument",
        )
    queries = [str(q).strip() for q in queries if str(q).strip()][:4]
    if not queries:
        return R.err("queries contained no usable strings", code="bad_argument")

    try:
        read_top = int(args.get("read_top") or DEFAULT_READ_TOP)
    except (TypeError, ValueError):
        read_top = DEFAULT_READ_TOP
    read_top = max(1, min(read_top, MAX_READ_TOP))

    from app.services.dashboard_ai_bot.web_search import fetch_url, search_web

    # ── 1. several angles ────────────────────────────────────────────────
    candidates: dict[str, dict[str, Any]] = {}
    providers: set[str] = set()
    failed: list[str] = []
    for q in queries:
        res = search_web(q, max_results=5)
        if not res.get("ok"):
            failed.append(f"{q}: {res.get('error')}")
            continue
        providers.add(str(res.get("provider") or "?"))
        for rank, hit in enumerate(res.get("results") or []):
            url = str(hit.get("url") or "")
            if not url:
                continue
            key = _norm_url(url)
            entry = candidates.setdefault(key, {
                "url": url, "title": str(hit.get("title") or ""),
                "snippet": str(hit.get("snippet") or ""),
                "found_by": [], "best_rank": rank,
            })
            if q not in entry["found_by"]:
                entry["found_by"].append(q)
            entry["best_rank"] = min(entry["best_rank"], rank)
            if len(hit.get("snippet") or "") > len(entry["snippet"]):
                entry["snippet"] = str(hit.get("snippet"))

    if not candidates:
        return R.err(
            "no search results for any of the queries. "
            + ("; ".join(failed)[:300] if failed else ""),
            code="no_data", retryable=True, detail={"queries": queries},
        )

    # ── 2. rank by AGREEMENT, then by position ───────────────────────────
    # A page two independent queries both surfaced is better evidence than one
    # a single phrasing put first. This is the only corroboration signal
    # available without judging the content, so it decides the reading order.
    ordered = sorted(
        candidates.values(),
        key=lambda c: (-len(c["found_by"]), c["best_rank"]),
    )

    # ── 3. open the best, keep only what bears on the question ───────────
    #
    # Keywords come from the QUERIES as well as the question. Taking them from
    # the question alone meant a Vietnamese question scored an English page at
    # zero overlap and returned it with no passages at all — the source was
    # relevant (Xinhua, the exact 158bn USD figure) and the extractor could not
    # see it. The model was already asked for queries in more than one language;
    # those words are part of what we are looking for.
    keys = _keywords(question) | _keywords(" ".join(queries))
    sources: list[dict[str, Any]] = []
    for n, cand in enumerate(ordered[:read_top], start=1):
        page = fetch_url(cand["url"])
        body = str(page.get("text") or "") if page.get("ok") else ""
        read_ok = len(body) >= MIN_BODY_CHARS
        text = body if read_ok else cand["snippet"]
        sources.append({
            "n": n,
            "url": cand["url"],
            "title": (str(page.get("title") or "") or cand["title"])[:180],
            "published": _published(body) if read_ok else None,
            "found_by": cand["found_by"],
            "corroborated_by_queries": len(cand["found_by"]),
            # Whether the page was really read, stated rather than implied. A
            # JS-rendered page, a consent wall or a 403 all return almost no
            # text to an HTTP fetch, and passing the snippet off as the page
            # would be the same overclaiming as calling a results list a
            # summary.
            "read_from": "page text" if read_ok else "search snippet only",
            "read_note": None if read_ok else (
                "the page body could not be read (JavaScript-rendered, blocked "
                "or empty) — these lines come from the search snippet, so they "
                "are shorter and may be cut mid-sentence"
            ),
            "passages": _passages(text, keys, want_numbers=True),
        })

    # A source with no matching passage is payload with no content. Reported as
    # a bare URL under its own key rather than left in `sources` with an empty
    # list, so the model is not handed a numbered citation that quotes nothing.
    empty = [{"url": s["url"], "title": s["title"], "read_from": s["read_from"]}
             for s in sources if not s["passages"]]
    with_passages = [s for s in sources if s["passages"]]
    for i, s in enumerate(with_passages, start=1):
        s["n"] = i
    if not with_passages:
        return R.err(
            f"opened {len(sources)} sources but none contained a passage bearing "
            "on the question. Try queries closer to the wording the sources "
            "would use, or a narrower question.",
            code="no_data",
            detail={"opened": [s["url"] for s in sources], "queries": queries},
        )

    return R.ok(
        {
            "question": question.strip(),
            "queries_run": queries,
            "provider": "+".join(sorted(providers)) or "?",
            "sources": with_passages,
            **({"opened_but_nothing_relevant": empty} if empty else {}),
            "trust_note": (
                "These are QUOTED PASSAGES from external pages, not this "
                "report's data and not a verified fact. Cite each one as "
                "[web:N] using the source's `n`, keep the report's own figures "
                "as the source of truth, and never put an external figure and "
                "an internal one in the same sentence as though they were "
                "measured the same way. Where sources disagree, say so instead "
                "of picking one. A source with `read_from` = 'search snippet "
                "only' was NOT read — treat it as a headline, not evidence."
            ),
        },
        kind="documents",
        coverage=R.Coverage(
            returned=len(with_passages), total=len(candidates),
            truncated=len(candidates) > len(with_passages),
            ordered_by="how many of the queries surfaced the source, then rank",
        ),
    )


RESEARCH_WEB_DEF = {
    "name": "research_web",
    "description": (
        "Answer an outside-the-report question with EVIDENCE: runs several "
        "searches at once, merges and ranks what they agree on, opens the best "
        "pages, and returns the passages that bear on the question with the "
        "source each came from. Use this instead of web_search + fetch_url when "
        "you need a market figure, a benchmark or an industry trend — it does "
        "the whole search-and-read loop in ONE call. Every passage is a "
        "third-party claim: cite it as [web:N] and never merge it with the "
        "report's own numbers."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "The question the evidence must answer, in full. Used to "
                    "decide which passages are relevant, so write it with the "
                    "industry, market, period and unit named."
                ),
            },
            "queries": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "2-4 DIFFERENT search phrasings of the question. Vary the "
                    "angle and the language — a local-language query and an "
                    "English one surface different sources, and a source found "
                    "by more than one query is ranked higher."
                ),
            },
            "read_top": {
                "type": "integer",
                "description": "How many pages to open, 1-5 (default 3).",
            },
        },
        "required": ["question", "queries"],
    },
}
