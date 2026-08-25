"""The sanitizer is the only thing standing between an imported HTML document
and the browser of everyone the report is shared with.

These cases are the ones that actually got through an earlier draft, so each is
an attack that worked once rather than a hypothetical: script CONTENT surviving
tag removal, handlers written as arrow functions, `javascript:` behind
whitespace, CSS `expression()`, and truncation that cut a document mid-tag and
left the page's own markup unbalanced.

The two "keep" cases matter as much as the strips: a sanitizer that eats SVG
camelCase attributes or `url(#gradient)` references silently destroys the charts
it was meant to protect, and nobody reports that as a security bug.
"""
import re

import pytest

from app.services.html_fragment_sanitizer import (
    FRAGMENT_MAX_CHARS,
    sanitize_html_fragment,
)


@pytest.mark.parametrize(
    "raw, must_not_contain",
    [
        ("<div>ok</div><script>alert(1)</script>", "alert(1)"),
        ("<div>ok</div><style>body{display:none}</style>", "display:none"),
        ("<iframe src='http://evil'></iframe>", "evil"),
        ("<object data='x.swf'></object>", "x.swf"),
        ("<div onclick='steal()'>x</div>", "steal"),
        ("<a href='javascript:alert(1)'>x</a>", "javascript:"),
        ("<a href='  java\tscript:alert(1)'>x</a>", "alert(1)"),
        ("<div style='width:expression(alert(1))'>x</div>", "expression"),
        ("<link rel=stylesheet href='http://evil/x.css'>", "evil"),
        ("<meta http-equiv=refresh content='0;url=http://evil'>", "evil"),
        ("<base href='http://evil/'>", "evil"),
    ],
)
def test_dangerous_content_never_survives(raw, must_not_contain):
    cleaned, _ = sanitize_html_fragment(raw)
    assert must_not_contain.lower() not in cleaned.lower()


def test_script_body_goes_with_the_tag():
    # Stripping only the <script> tags leaves the payload as page text, which
    # reads as harmless right up until something re-parses it.
    cleaned, _ = sanitize_html_fragment("<p>a</p><script>var x = 1;</script><p>b</p>")
    assert "var x" not in cleaned
    assert "<p>a</p>" in cleaned and "<p>b</p>" in cleaned


def test_svg_camelcase_attributes_are_preserved():
    raw = '<svg viewBox="0 0 10 10"><linearGradient id="g"/><path d="M0 0" stroke-width="2"/></svg>'
    cleaned, _ = sanitize_html_fragment(raw)
    assert "viewBox" in cleaned          # not folded to viewbox
    assert "linearGradient" in cleaned
    assert 'stroke-width="2"' in cleaned


def test_url_reference_to_a_local_def_survives():
    raw = '<svg><rect fill="url(#grad-1)"/></svg>'
    cleaned, _ = sanitize_html_fragment(raw)
    assert "url(#" in cleaned


def test_uppercase_tags_are_folded_not_dropped():
    cleaned, _ = sanitize_html_fragment("<DIV><SPAN>hi</SPAN></DIV>")
    assert "hi" in cleaned
    assert "<div" in cleaned and "<span" in cleaned


def test_unclosed_tags_come_back_balanced():
    cleaned, _ = sanitize_html_fragment("<div><span>text")
    assert cleaned.count("<div") == cleaned.count("</div")
    assert cleaned.count("<span") == cleaned.count("</span")


def test_stray_closing_tags_are_dropped():
    cleaned, _ = sanitize_html_fragment("text</div></span>")
    assert "</div>" not in cleaned and "</span>" not in cleaned
    assert "text" in cleaned


def test_void_elements_are_not_given_closers():
    cleaned, _ = sanitize_html_fragment('<p>a<br><img src="x.png">b</p>')
    assert "</br>" not in cleaned and "</img>" not in cleaned


def test_truncation_still_returns_balanced_markup():
    raw = "<div>" + ("x" * (FRAGMENT_MAX_CHARS + 500)) + "</div>"
    cleaned, warnings = sanitize_html_fragment(raw)
    assert len(cleaned) <= FRAGMENT_MAX_CHARS + 64  # room for the closers it re-adds
    assert cleaned.count("<div") == cleaned.count("</div")
    assert any("truncat" in w.lower() for w in warnings)


def test_a_clean_fragment_passes_through_without_warnings():
    raw = '<div class="card"><h3>Revenue</h3><p>16.0M</p></div>'
    cleaned, warnings = sanitize_html_fragment(raw)
    assert "Revenue" in cleaned and "16.0M" in cleaned
    assert warnings == []


# The property that actually matters is not "the word `alert` is gone" -- an
# attacker's payload surviving as visible TEXT is ugly, not dangerous. What must
# never happen is a handler or a script URL coming back out INSIDE a tag, and
# the interesting inputs are the ones that try to end the tag early so the rest
# is re-parsed as fresh markup.
_HANDLER_IN_TAG = re.compile(r"<[a-zA-Z][^>]*\son[a-z]+\s*=", re.IGNORECASE)
_SCRIPT_URL_IN_TAG = re.compile(
    r"<[a-zA-Z][^>]*(href|src|xlink:href)\s*=\s*[\"']?\s*j\s*a\s*v\s*a", re.IGNORECASE
)


@pytest.mark.parametrize(
    "raw",
    [
        "<div onclick=a>b onerror=alert(1)>x</div>",     # unquoted value ends the tag early
        "<div onclick=() => steal()>x</div>",            # arrow fn, the `>` closes the tag
        "<img src=x onerror=alert(1)>",
        "<div title=a>b><img src=q onerror=alert(1)></div>",
        "<svg><animate onbegin=alert(1) attributeName=x></svg>",
        "<div><![CDATA[<img src=x onerror=alert(1)>]]></div>",
        "<div>&lt;img src=x onerror=alert(1)&gt;</div>",
        "<a xlink:href='javascript:alert(1)'>x</a>",
    ],
)
def test_no_handler_or_script_url_survives_inside_a_tag(raw):
    cleaned, _ = sanitize_html_fragment(raw)
    assert not _HANDLER_IN_TAG.search(cleaned), cleaned
    assert not _SCRIPT_URL_IN_TAG.search(cleaned), cleaned
