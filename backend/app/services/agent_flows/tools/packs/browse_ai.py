"""Ask a search engine's own AI a detailed question, in a headless browser.

WHAT THIS IS
------------
The operator's request, and the reasoning behind it is sound: a search engine
already runs a model over the results and writes a summary. Reading that summary
costs no tokens of ours, and a well-specified question makes it answer the thing
we actually wanted. The expensive half of "get outside context" is the
synthesis, and somebody else has already paid for it.

I argued against this and was overruled, so it is built — but built with the
objections turned into properties of the code rather than left as opinions:

  THE TARGET IS CONFIGURED, NOT ASSUMED
      `BROWSE_AI_ENDPOINT` decides which surface is opened. Nothing here names
      Google. Scraping a particular provider is a decision about that provider's
      terms, which belongs to whoever runs the deployment and signed nothing on
      my behalf. Unset, the tool is off.

  THE SUMMARY IS NEVER A FIGURE
      Everything it returns is labelled a third-party claim, unverified, with
      whatever citation links the page carried. The entire tool review has been
      about numbers declaring what they stand on; a synthesis with no method and
      no date is the one kind of number that cannot. So the result says so, in
      the field a model reads, every time.

  THE QUESTION IS THE PRODUCT
      The operator's own insight, and the part with real value. A vague query
      gets a vague summary. `question` is required to be specific, and the tool
      refuses one that is too short or too generic to have a useful answer —
      because the failure mode of this whole approach is a confident paragraph
      about nothing.

  IT IS OFF UNLESS THREE THINGS ARE TRUE
      the `external` pack's per-link web gate, a deployment endpoint, and
      Playwright actually installed. Any one missing and the tool refuses with a
      reason rather than half-working.

WHAT IT CANNOT BE USED FOR
--------------------------
A figure in an answer. `web_search` returns sources with URLs and is the right
tool when a number has to be defended. This one returns somebody's paragraph,
and the result says that plainly so a model quotes it as an opinion with a name
on it, never as a measurement.
"""
from __future__ import annotations

import os
import re
from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.dashboard_ai_bot.tool_context import ToolContext

#: Where to send the question. A URL template with `{q}` for the encoded
#: question. Empty means the tool is off — there is deliberately no default,
#: because a default here would be a decision about somebody else's terms of
#: service made by whoever wrote this file.
ENDPOINT_ENV = "BROWSE_AI_ENDPOINT"

#: CSS selectors, most specific first, for the element holding the summary. Also
#: configurable: the DOM of somebody else's product is undocumented and changes
#: without notice, so this must be fixable without a deploy.
SELECTOR_ENV = "BROWSE_AI_SELECTOR"

#: How long to wait for the summary to render. These surfaces stream.
TIMEOUT_ENV = "BROWSE_AI_TIMEOUT_MS"
DEFAULT_TIMEOUT_MS = 15_000

#: Show the browser window instead of running it hidden. Off by default — a
#: server has no display and this must never be on in a deployment.
#:
#: It exists because the one thing this tool cannot report is what the page
#: LOOKED like. When a selector stops matching, the result is `no_data`, and
#: `no_data` is the same answer for "the panel wasn't there", "the DOM changed"
#: and "we were served a block page". Those need different fixes and the only way
#: to tell them apart is to watch it happen.
HEADFUL_ENV = "BROWSE_AI_HEADFUL"

#: Milliseconds of delay between browser actions, so a person can follow them.
#: Only meaningful together with the above.
SLOWMO_ENV = "BROWSE_AI_SLOWMO_MS"

#: Directory to save a full-page PNG of whatever was landed on. Off by default.
#: Unlike the switch above this one works on a headless server, which is where it
#: matters: when a selector stops matching in production nobody can look at the
#: screen, and the picture is the difference between "fix the selector" and
#: "we are being served a block page and no selector will help".
SHOT_DIR_ENV = "BROWSE_AI_SCREENSHOT_DIR"

#: A question shorter than this cannot be specific enough to be worth asking.
MIN_QUESTION_CHARS = 25

#: Question shapes that will return a paragraph about nothing. Refused with an
#: explanation rather than run, because the cost of this tool is not the tokens
#: — it is a vague answer being quoted as market context.
_TOO_VAGUE = re.compile(
    r"^\s*(what is|who is|define|explain|tell me about|là gì|thế nào)\b",
    re.IGNORECASE)

#: A line whose first token is a hostname — `hrchannels.com › uptalent`,
#: `www.uio.vn/vi/bang-…`, `https://unica.vn`. Requires a real dotted domain and
#: a delimiter after it, so ordinary prose and abbreviations ("e.g. ", "Inc. ")
#: do not match.
_HOST_LINE = re.compile(
    r"^(?:https?://)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:[/\s›?#]|$)",
    re.IGNORECASE)


def _real_url(href: str) -> str:
    """The source URL behind a search engine's tracking redirect.

    Found by looking at what the citations actually contained. Two defects, both
    invisible in the returned JSON and obvious in a screenshot:

      * DuckDuckGo's plain-HTML endpoint writes PROTOCOL-RELATIVE hrefs
        (`//duckduckgo.com/l/?uddg=…`). The selector matched `href^='http'`, so
        every link was skipped and the result carried ZERO citations — a page
        full of sources reported as having none.
      * Bing and DuckDuckGo both wrap the real destination in a redirect. Kept
        raw, a "citation" is a click-tracker that says nothing about who made
        the claim, which is the one thing a citation is for.

    Unwraps to the real destination where the target is in a query parameter.
    Never raises: a citation that cannot be decoded is returned as-is, because a
    tracker link is still better than dropping the source.
    """
    from urllib.parse import parse_qs, urlparse

    href = (href or "").strip()
    if href.startswith("//"):
        href = "https:" + href
    if not href.startswith(("http://", "https://")):
        return ""
    try:
        parsed = urlparse(href)
        params = parse_qs(parsed.query)
        # `uddg` — DuckDuckGo. `url`/`q` — common elsewhere. Plain percent-encoded.
        for key in ("uddg", "url", "q"):
            candidate = (params.get(key) or [""])[0]
            if candidate.startswith(("http://", "https://")):
                return candidate
        # `u` — Bing, base64 with an "a1" prefix and URL-safe alphabet.
        raw = (params.get("u") or [""])[0]
        if raw.startswith("a1"):
            import base64

            padded = raw[2:] + "=" * (-len(raw[2:]) % 4)
            decoded = base64.urlsafe_b64decode(padded).decode("utf-8", "ignore")
            if decoded.startswith(("http://", "https://")):
                return decoded
    except Exception:  # noqa: BLE001 — an undecodable link is still a link
        pass
    return href


def _playwright_available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def _config() -> tuple[str, list[str], int]:
    endpoint = (os.getenv(ENDPOINT_ENV) or "").strip()
    raw_selectors = (os.getenv(SELECTOR_ENV) or "").strip()
    selectors = [s.strip() for s in raw_selectors.split("|") if s.strip()]
    try:
        timeout = int(os.getenv(TIMEOUT_ENV) or DEFAULT_TIMEOUT_MS)
    except ValueError:
        timeout = DEFAULT_TIMEOUT_MS
    return endpoint, selectors, timeout


def tool_browse_ai_answer(ctx: ToolContext, args: dict) -> dict:
    """Open the configured answer surface headlessly and read what it wrote."""
    question = args.get("question")
    if not isinstance(question, str) or not question.strip():
        return R.err("question (str) is required", code="bad_argument")
    question = question.strip()

    # The question IS the product. A summary is only as good as what it was
    # asked, and this tool has no way to tell a good paragraph from a useless
    # one after the fact — so the check has to happen before.
    if len(question) < MIN_QUESTION_CHARS:
        return R.err(
            f"question is too short ({len(question)} chars) to get a useful "
            "summary. Name the industry, the market, the period and the unit — "
            "'B2B SaaS revenue growth Vietnam 2024 companies under 50 staff', "
            "not 'B2B revenue'.",
            code="bad_argument",
        )
    if _TOO_VAGUE.match(question):
        return R.err(
            "question is too open-ended: it will return a definition, not "
            "context you can use. Ask for a figure, a range, a comparison or a "
            "trend, with the market and the period named.",
            code="bad_argument",
        )

    endpoint, selectors, timeout_ms = _config()
    if not endpoint:
        return R.err(
            f"this tool is not configured: set {ENDPOINT_ENV} to the answer "
            "surface this deployment is permitted to read, as a URL template "
            "containing {q}. It is off by default on purpose — which surface may "
            "be automated is a decision about that provider's terms, and belongs "
            "to whoever runs this deployment.",
            code="gated",
        )
    if not selectors:
        return R.err(
            f"this tool is not configured: set {SELECTOR_ENV} to one or more CSS "
            "selectors (separated by |) for the element holding the summary.",
            code="gated",
        )
    from urllib.parse import quote_plus

    target = endpoint.replace("{q}", quote_plus(question))
    # The same egress rule the rest of this pack follows: a configured endpoint
    # is still a URL, and a URL pointed inward is the defect this review found in
    # `fetch_url`. Reusing the guard rather than writing a second one.
    #
    # CHECKED BEFORE the Playwright probe, and the order is the point. With the
    # availability check first, a deployment without a browser never reached this
    # line — so a misconfigured internal endpoint was answered with "no browser"
    # and the guard went untested. A security check that only runs when
    # everything else is working is a security check nobody has seen work.
    from app.services.dashboard_ai_bot.web_search import _check_url

    _, refusal = _check_url(target)
    if refusal:
        return R.err(f"endpoint {refusal}", code="bad_argument")

    if not _playwright_available():
        return R.err(
            "headless browsing is unavailable: Playwright is not installed in "
            "this deployment. Install it and its browser, or use web_search, "
            "which returns sources with URLs and needs no browser.",
            code="gated",
        )

    summary = ""
    citations: list[dict[str, str]] = []
    page_title = ""
    landed_url = ""
    shot_path = ""
    shot_dir = (os.getenv(SHOT_DIR_ENV) or "").strip()
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            # `--no-sandbox` because the container runs as root, where
            # Chromium refuses to start otherwise; `--disable-dev-shm-usage`
            # because Docker gives /dev/shm 64MB by default and Chromium
            # crashes on a real page without it. Both were found by the
            # browser failing to launch at all, not predicted.
            headful = (os.getenv(HEADFUL_ENV) or "").strip().lower() in (
                "1", "true", "yes", "on")
            try:
                slow_mo = int(os.getenv(SLOWMO_ENV) or 0)
            except ValueError:
                slow_mo = 0
            browser = pw.chromium.launch(
                headless=not headful,
                slow_mo=slow_mo if headful else 0,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            try:
                page = browser.new_page(
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
                    ),
                    locale="vi-VN",
                )
                page.goto(target, timeout=timeout_ms, wait_until="domcontentloaded")
                for selector in selectors:
                    try:
                        page.wait_for_selector(selector, timeout=timeout_ms // len(selectors))
                        node = page.query_selector(selector)
                        if node:
                            text = (node.inner_text() or "").strip()
                            if len(text) > len(summary):
                                summary = text
                            # Whatever the panel cited, kept — a synthesis with
                            # its sources is worth something; without them it is
                            # an anonymous claim.
                            for link in node.query_selector_all("a[href]"):
                                href = _real_url(link.get_attribute("href") or "")
                                label = (link.inner_text() or "").strip()[:80]
                                if href and not any(c["url"] == href for c in citations):
                                    citations.append({"url": href, "label": label})
                            if summary:
                                break
                    except Exception:  # noqa: BLE001 — try the next selector
                        continue
                page_title = (page.title() or "")[:120]
                # WHERE WE ACTUALLY ENDED UP. Not the same as where we were
                # sent: Google answers this tool with a redirect to
                # /sorry/index. Without this field that block is invisible —
                # the result just says no summary was found, which reads as
                # "the panel wasn't there for this question" and sends
                # whoever is debugging to fix a selector that was never wrong.
                landed_url = page.url
                if shot_dir:
                    try:
                        os.makedirs(shot_dir, exist_ok=True)
                        # Named by HOST first, then title. Titled-only names
                        # collided: two search engines answering the same
                        # question produce the same first 40 characters, so the
                        # second screenshot silently overwrote the first and
                        # three surfaces left two files. A diagnostic that
                        # quietly loses evidence is worse than none.
                        from urllib.parse import urlparse as _up

                        _slug = lambda s: re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")  # noqa: E731
                        shot_path = os.path.join(
                            shot_dir,
                            f"{_slug(_up(landed_url).netloc)[:24]}"
                            f"__{_slug(page_title or 'page')[:40]}.png",
                        )
                        page.screenshot(path=shot_path, full_page=True)
                    except Exception:  # noqa: BLE001 — a picture is never worth failing over
                        shot_path = ""
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001
        return R.err(
            f"headless browse failed: {type(exc).__name__}. The page may have "
            "changed, blocked automation, or shown no summary for this question.",
            code="query_failed", retryable=True,
        )

    # Did we even land where we were sent? A search page that answers with a
    # redirect has not "shown no summary" — it has refused, and those need
    # opposite fixes. Compared on path, because the query string is expected to
    # change and the host usually does not.
    from urllib.parse import urlparse

    sent, landed = urlparse(target), urlparse(landed_url or target)
    redirected = bool(landed_url) and (
        sent.netloc != landed.netloc or sent.path != landed.path)

    if not summary:
        return R.err(
            (
                "the request was REDIRECTED away from the page that was asked "
                f"for — sent to {sent.netloc}{sent.path}, landed on "
                f"{landed.netloc}{landed.path}. That is the surface refusing "
                "automated access, not a missing summary; no selector change "
                "will fix it. Use web_search instead."
                if redirected else
                "no summary was present on the page for this question. These "
                "panels do not appear for every query — fall back to "
                "web_search, which always returns sources."
            ),
            code="no_data",
            detail={
                "selectors_tried": selectors,
                "landed_url": landed_url[:300],
                "page_title": page_title,
                "redirected": redirected,
                **({"screenshot": shot_path} if shot_path else {}),
            },
        )

    # IS THIS ACTUALLY A SYNTHESIS?
    #
    # Found by running it. Google refused the request outright — it redirects to
    # /sorry/index, "unusual traffic from your network" — so the surface this
    # tool was asked for never answered. Bing did answer, with its ORDINARY
    # RESULTS LIST, and this code labelled it `third_party_ai_summary` because
    # the label was hard-coded to whatever the selector matched.
    #
    # A results list called a synthesis is the same overclaiming the rest of the
    # catalogue spent this review removing. The tool cannot verify that a page
    # ran a model, so it must not assert that it did: it reports the SHAPE it
    # can measure, and says which one it thinks it got.
    # A line that BEGINS with a hostname, with or without a scheme. Matching only
    # `http://` missed DuckDuckGo entirely — its plain-HTML endpoint prints
    # `www.uio.vn/vi/…` with the scheme stripped — so a page of ten search
    # results was classified as prose and handed the model the weaker warning,
    # the one that does not say "these are separate links, do not merge them
    # into a claim". The mislabelling this check exists to prevent, reintroduced
    # by the check itself.
    lines = [ln.strip() for ln in summary.splitlines() if ln.strip()]
    url_lines = sum(1 for ln in lines if _HOST_LINE.match(ln) or " › " in ln)
    link_density = len(citations) / max(len(summary) / 500.0, 1.0)
    looks_like_list = (
        (url_lines >= 3 and url_lines >= len(lines) * 0.15) or link_density >= 3.0
    )

    full_len = len(summary)
    summary = summary[:4000]

    return R.ok(
        {
            "question_asked": question,
            "summary": summary,
            "citations": citations[:10],
            "page_title": page_title,
            "landed_url": landed_url[:300],
            **({"screenshot": shot_path} if shot_path else {}),
            # What was measured, not what was hoped for.
            "source_kind": (
                "scraped_search_results" if looks_like_list
                else "scraped_page_text"
            ),
            "looks_like_results_list": looks_like_list,
            # The most important field in this result. It is read by the model on
            # every call, and it is what stops a synthesis with no method being
            # quoted next to a figure this system measured itself.
            "trust_note": (
                (
                    "This is a LIST OF SEARCH RESULTS scraped from a results "
                    "page, not a synthesis — the page produced no AI summary for "
                    "this question. Treat each line as a link with a headline, "
                    "nothing more. Do not merge them into a claim, and do not "
                    "quote a figure from a snippet as though it were established."
                )
                if looks_like_list else
                (
                    "This is text scraped from a web page. Nothing here verified "
                    "it was written by a model, and nothing verified the content: "
                    "it carries no method and no date. It is NOT a measurement. "
                    "Attribute it, never state it as fact, never put it in the "
                    "same sentence as a figure from this report as though the two "
                    "are comparable, and prefer the cited links over the text."
                )
            ),
        },
        kind="documents",
        coverage=R.Coverage(
            returned=len(summary), total=full_len,
            truncated=full_len > len(summary),
            ordered_by="as the page presented it",
        ),
    )


BROWSE_AI_ANSWER_DEF = {
    "name": "browse_ai_answer",
    "description": (
        "Ask a configured web answer-surface a DETAILED question in a headless "
        "browser and read the AI summary it writes, with whatever links it cited. "
        "Use for outside market context that needs synthesis — industry growth "
        "rates, benchmark ranges, market sizing — where a list of links is not "
        "enough. The question must name the industry, market, period and unit; a "
        "vague question is refused, because a vague summary is the failure mode. "
        "The result is a third-party claim, never a measurement: attribute it and "
        "never mix it into a sentence with this report's own figures."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "The question, as specific as you can make it — industry, "
                    "market, period, unit. Build it from what the internal "
                    "documents say about this business, not from the viewer's "
                    "words alone."
                ),
            },
        },
        "required": ["question"],
    },
}
