"""Reduce untrusted source HTML to safe, static markup.

Its own module because two layers need it and neither may import the other:
the HTML importer sanitizes while analyzing, and the dashboard persistence
layer sanitizes again on the way in. The second pass is the one that matters --
an analyze response round-trips through the browser before it is posted back,
so anything that trusted the first pass would be storing whatever the client
chose to send.
"""

import hashlib
import re
from typing import Any, Dict, List, Set, Tuple

#: Tags that carry layout or visual richness and are safe to keep as static
#: markup. Everything else is dropped: this markup comes from an uploaded file,
#: so the allow-list is what stands between an import and stored XSS.
_FRAGMENT_ALLOWED_TAGS = {
    "div", "span", "p", "section", "article", "header", "footer", "main", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "b", "strong", "i", "em", "u", "small", "sub", "sup", "mark", "code", "pre",
    "br", "hr", "figure", "figcaption", "blockquote", "img", "svg", "path",
    "circle", "rect", "line", "polyline", "polygon", "g", "text", "tspan", "defs",
    "linearGradient", "radialGradient", "stop",
}

#: Attributes kept per tag. `style` is kept because it is most of what makes a
#: vibe-coded block look designed; it is scrubbed below rather than trusted.
_FRAGMENT_ALLOWED_ATTRS = {
    "class", "style", "colspan", "rowspan", "align", "width", "height",
    "viewBox", "d", "fill", "stroke", "stroke-width", "cx", "cy", "r", "x", "y",
    "x1", "y1", "x2", "y2", "points", "transform", "offset", "stop-color",
    "stop-opacity", "fill-opacity", "text-anchor", "font-size", "font-weight",
    "rx", "ry", "gradientUnits", "alt", "src", "id",
}

#: HTML folds tag and attribute names to lower case; SVG does not. `viewBox`
#: and `linearGradient` stop working the moment they are lowered, so match on
#: the lowered name and emit the allow-list's canonical spelling.
_FRAGMENT_TAG_CANON = {t.lower(): t for t in _FRAGMENT_ALLOWED_TAGS}
_FRAGMENT_ATTR_CANON = {a.lower(): a for a in _FRAGMENT_ALLOWED_ATTRS}

#: Elements with no closing tag, so the balancer never waits for one.
_FRAGMENT_VOID_TAGS = {"br", "hr", "img"}

# Element AND content. Stripping only the tags left `alert(1)` sitting in the
# report as visible text; the backreference ties the closing tag to the opening
# one so everything nested in between is consumed with it.
_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?</\1\s*>",
    re.IGNORECASE,
)
# The same elements self-closing or unclosed, plus the void ones that never
# have a closing tag at all.
_VOID_DANGEROUS_RE = re.compile(
    r"<(script|style|iframe|object|embed|link|meta|base)\b[^>]*/?>",
    re.IGNORECASE,
)
# The attribute segment must be able to swallow a quoted value that contains
# ">" -- `onclick="s=>evil()"` otherwise ends the tag at the arrow and the tail
# of the handler lands in the report as visible text.
_TAG_RE = re.compile(r"""<(/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(/?)>""")
_ATTR_RE = re.compile(r"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)")
#: `fill="url(#grad)"` is how an inline SVG reaches its own gradient. Ids are
#: kept for that reason and namespaced per fragment, because two imported
#: blocks -- or a block and the dashboard itself -- would otherwise fight over
#: the same id and the second one would silently paint with the first's fill.
_URL_REF_RE = re.compile(r"url\s*\(\s*#([A-Za-z][\w:.-]*)\s*\)")
_URL_SCHEME_RE = re.compile(r"^\s*(javascript|vbscript|data:text/html)", re.IGNORECASE)
_CSS_DANGER_RE = re.compile(r"(expression\s*\(|url\s*\(\s*['\"]?\s*javascript|@import|behaviou?r\s*:)", re.IGNORECASE)

FRAGMENT_MAX_CHARS = 20000


def sanitize_html_fragment(raw: str) -> Tuple[str, List[str]]:
    """Reduce a block of source HTML to safe, static markup.

    The point is preservation: a vibe-coded report is full of things AppBI has
    no native visual for — a progress rail, an avatar list, a gauge drawn in
    inline SVG — and dropping them was throwing away most of what made the
    source worth importing. Keeping them as inert markup preserves the layout
    and the richness; the interactions are what get degraded, and the caller
    reports that.

    Everything is an allow-list: tags, attributes, URL schemes, and the CSS
    inside `style`. Anything unrecognised is removed rather than escaped, so a
    novel attack shape fails closed. Returns `(fragment, warnings)`.
    """
    warnings: List[str] = []
    if not raw or not raw.strip():
        return "", warnings

    html = _SCRIPT_STYLE_RE.sub(" ", raw)
    html = _VOID_DANGEROUS_RE.sub(" ", html)
    if html != raw:
        warnings.append("Scripts, stylesheets and embedded frames were removed from the preserved block.")

    dropped_tags: Set[str] = set()
    dropped_attrs: Set[str] = set()

    # Stable per-fragment prefix: re-importing the same block twice produces the
    # same ids, so a saved dashboard does not churn on every re-analyze.
    uid = "f" + hashlib.md5(raw.encode("utf-8", "ignore")).hexdigest()[:8]

    def _clean_attrs(attr_text: str) -> str:
        kept: List[str] = []
        for name, value in _ATTR_RE.findall(attr_text or ""):
            lname = name.lower()
            val = value.strip("\"'")
            if lname.startswith("on"):
                dropped_attrs.add(lname)
                continue
            canonical = _FRAGMENT_ATTR_CANON.get(lname)
            if canonical is None:
                dropped_attrs.add(lname)
                continue
            if lname in {"src", "href"} and _URL_SCHEME_RE.match(val):
                dropped_attrs.add(lname)
                continue
            if lname == "style" and _CSS_DANGER_RE.search(val):
                dropped_attrs.add("style")
                continue
            if lname == "id":
                val = uid + "-" + val
            elif _URL_REF_RE.search(val):
                val = _URL_REF_RE.sub(lambda mm: "url(#" + uid + "-" + mm.group(1) + ")", val)
            kept.append(canonical + '="' + val.replace(chr(34), "&quot;") + '"')
        return (" " + " ".join(kept)) if kept else ""

    # A closing tag whose opener we removed would close one of the DASHBOARD's
    # own elements, not the fragment's. Track what this fragment actually opened
    # and honour only those.
    open_stack: List[str] = []

    def _rewrite(m: "re.Match") -> str:
        closing, tag, attrs, selfclose = m.group(1), m.group(2), m.group(3), m.group(4)
        canonical = _FRAGMENT_TAG_CANON.get(tag.lower())
        if canonical is None:
            dropped_tags.add(tag.lower())
            return ""
        if closing:
            if canonical not in open_stack:
                return ""
            out: List[str] = []
            while open_stack:
                top = open_stack.pop()
                out.append("</" + top + ">")
                if top == canonical:
                    break
            return "".join(out)
        if selfclose or canonical in _FRAGMENT_VOID_TAGS:
            return "<" + canonical + _clean_attrs(attrs) + "/>"
        open_stack.append(canonical)
        return "<" + canonical + _clean_attrs(attrs) + ">"

    cleaned = _TAG_RE.sub(_rewrite, html).strip()

    if len(cleaned) > FRAGMENT_MAX_CHARS:
        cleaned = cleaned[:FRAGMENT_MAX_CHARS]
        # Cutting mid-tag would emit `<div class="ca` as text and leave the
        # attribute soup visible, so retreat to the last complete tag.
        cut = cleaned.rfind(">")
        cleaned = cleaned[: cut + 1] if cut > 0 else ""
        warnings.append(
            "The preserved block was truncated at " + str(FRAGMENT_MAX_CHARS) + " characters."
        )

    # Balance from the FINAL string: truncation above can have removed closing
    # tags that the rewrite pass had already accounted for. An unbalanced
    # fragment does not stay inside its own tile -- the browser keeps the
    # element open and swallows every widget after it.
    still_open: List[str] = []
    for m in _TAG_RE.finditer(cleaned):
        closing, tag, _attrs, selfclose = m.group(1), m.group(2), m.group(3), m.group(4)
        if selfclose or tag in _FRAGMENT_VOID_TAGS:
            continue
        if closing:
            if tag in still_open:
                while still_open and still_open.pop() != tag:
                    pass
        else:
            still_open.append(tag)
    if still_open:
        cleaned += "".join("</" + t + ">" for t in reversed(still_open))
        warnings.append("Unclosed tags in the preserved block were closed.")

    if dropped_tags:
        warnings.append("Unsupported markup removed: " + ", ".join(sorted(dropped_tags)[:8]) + ".")
    if dropped_attrs:
        warnings.append("Unsafe attributes removed: " + ", ".join(sorted(dropped_attrs)[:8]) + ".")
    return cleaned, warnings
