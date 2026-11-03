"""The report document: what authored code may contain, and how it is served.

Authored markup is never re-serialized. Validation and region edits work on spans of
the ORIGINAL text, so everything they do not need to touch stays byte-for-byte what
the author (or the AI) wrote — which is what lets an edit of one region leave every
other region exactly as it was.

Serving: the document runs in an iframe sandboxed WITHOUT allow-same-origin, under a
CSP whose only script source is a per-response nonce and whose connect-src is 'none'.
The runtime (runtime.js) is the first nonce'd script; it alone talks to the host.
"""
from __future__ import annotations

import hashlib
import html as _html
import json
import re
import secrets
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Tuple

RUNTIME_VERSION = "1.0.0"
_RUNTIME_JS = Path(__file__).with_name("runtime.js").read_text(encoding="utf-8")

MAX_HTML = 400_000
MAX_CSS = 200_000
MAX_JS = 300_000

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
         "param", "keygen", "command"}
# Removed together with everything inside them.
_DROP_BLOCK = {"script", "iframe", "frame", "frameset", "object", "applet", "portal"}
# Removed (no content of their own).
_DROP_VOID = {"base", "meta", "link", "embed"}
# The tag goes, its children stay.
_UNWRAP = {"form"}
_URL_ATTRS = {"href", "xlink:href", "action", "formaction", "poster", "background", "ping", "srcset"}


@dataclass
class _Tag:
    kind: str  # start | end | startend
    name: str
    attrs: List[Tuple[str, Optional[str]]]
    start: int
    end: int


class _Scanner(HTMLParser):
    """Collects tags with their exact offsets in the source."""

    def __init__(self, text: str):
        super().__init__(convert_charrefs=False)
        self._text = text
        self._lines = [0]
        for i, ch in enumerate(text):
            if ch == "\n":
                self._lines.append(i + 1)
        self.tags: List[_Tag] = []

    def _pos(self) -> int:
        line, col = self.getpos()
        return self._lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self._pos()
        raw = self.get_starttag_text() or ""
        self.tags.append(_Tag("start", tag, attrs, start, start + len(raw)))

    def handle_startendtag(self, tag, attrs):
        start = self._pos()
        raw = self.get_starttag_text() or ""
        self.tags.append(_Tag("startend", tag, attrs, start, start + len(raw)))

    def handle_endtag(self, tag):
        start = self._pos()
        close = self._text.find(">", start)
        self.tags.append(_Tag("end", tag, [], start, (close + 1) if close >= 0 else len(self._text)))


def _scan(text: str) -> List[_Tag]:
    s = _Scanner(text)
    try:
        s.feed(text)
        s.close()
    except Exception:  # noqa: BLE001 - malformed markup: what was scanned is what we have
        pass
    return s.tags


def _matching_end(tags: List[_Tag], i: int) -> int:
    """Index of the end tag closing tags[i] (a 'start'); -1 when it is never closed."""
    name = tags[i].name
    depth = 0
    for j in range(i + 1, len(tags)):
        t = tags[j]
        if t.name != name:
            continue
        if t.kind == "start":
            depth += 1
        elif t.kind == "end":
            if depth == 0:
                return j
            depth -= 1
    return -1


def _rebuild_start(tag: _Tag, attrs: List[Tuple[str, Optional[str]]]) -> str:
    parts = [tag.name]
    for k, v in attrs:
        parts.append(k if v is None else f'{k}="{_html.escape(v, quote=True)}"')
    return "<" + " ".join(parts) + (" />" if tag.kind == "startend" else ">")


def _clean_attrs(tag: _Tag, warnings: List[str]) -> Optional[List[Tuple[str, Optional[str]]]]:
    """The allowed attributes, or None when nothing had to change."""
    kept, changed = [], False
    for k, v in tag.attrs:
        key = k.lower()
        val = (v or "").strip()
        if key.startswith("on"):
            changed = True
            warnings.append(f"<{tag.name} {key}=…> removed — inline event handlers cannot run; use addEventListener in the JS tab.")
            continue
        if key in _URL_ATTRS:
            if key in ("href", "xlink:href") and (val == "" or val.startswith("#")):
                kept.append((k, v))
                continue
            changed = True
            warnings.append(f"<{tag.name} {key}=\"{val[:60]}\"> removed — a report cannot link or load outside itself.")
            continue
        if key == "src":
            if val.startswith("data:image/") or val.startswith("data:font/"):
                kept.append((k, v))
                continue
            changed = True
            warnings.append(f"<{tag.name} src=\"{val[:60]}\"> removed — only inline (data:) images are allowed.")
            continue
        if key == "target":
            changed = True
            continue
        kept.append((k, v))
    return kept if changed else None


def sanitize_html(text: str) -> Tuple[str, List[str]]:
    """Authored body markup inside the report contract. Returns (markup, warnings)."""
    warnings: List[str] = []
    if not text:
        return "", warnings
    tags = _scan(text)
    edits: List[Tuple[int, int, str]] = []
    skip_until = -1
    for i, t in enumerate(tags):
        if t.start < skip_until:
            continue
        name = t.name
        if t.kind in ("start", "startend") and name in _DROP_BLOCK:
            end_idx = _matching_end(tags, i) if t.kind == "start" else -1
            stop = tags[end_idx].end if end_idx >= 0 else t.end
            edits.append((t.start, stop, ""))
            skip_until = stop
            warnings.append(
                "<script> in the HTML was removed — scripts belong in the JS tab." if name == "script"
                else f"<{name}> removed — a report cannot embed other pages or plugins.")
            continue
        if t.kind in ("start", "startend") and name in _DROP_VOID:
            edits.append((t.start, t.end, ""))
            warnings.append(f"<{name}> removed — not allowed in a report body.")
            continue
        if name in _UNWRAP:
            edits.append((t.start, t.end, ""))
            continue
        if t.kind in ("start", "startend"):
            cleaned = _clean_attrs(t, warnings)
            if cleaned is not None:
                edits.append((t.start, t.end, _rebuild_start(t, cleaned)))
    if not edits:
        return text, warnings
    out, cursor = [], 0
    for start, end, repl in sorted(edits):
        if start < cursor:
            continue
        out.append(text[cursor:start])
        out.append(repl)
        cursor = end
    out.append(text[cursor:])
    return "".join(out), _dedupe(warnings)


_CSS_WARN = [
    (re.compile(r"@import", re.I), "@import cannot load anything in a report (no external stylesheets)."),
    (re.compile(r"url\(\s*['\"]?\s*(https?:|//)", re.I), "url(http…) cannot load — use inline data: images or CSS only."),
]
_JS_WARN = [
    (re.compile(r"\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|sendBeacon|EventSource"), "Network calls are blocked — data comes through rac.bind()."),
    (re.compile(r"localStorage|sessionStorage|indexedDB|document\.cookie"), "Browser storage and cookies are not available in a report."),
    (re.compile(r"window\.(parent|top|opener)|\bparent\.|\btop\.location"), "A report cannot reach the page around it."),
    (re.compile(r"\blocation\s*(\.href)?\s*=|location\.(assign|replace)\s*\("), "A report cannot navigate away; it is closed if it tries."),
    (re.compile(r"\beval\s*\(|new\s+Function\s*\(|\bimport\s*\("), "eval / new Function / dynamic import are blocked by the report's security policy."),
    (re.compile(r"<script[^>]+src=", re.I), "External scripts do not load — use the built-in rac.viz charts or write SVG."),
]


def scan_css(css: str) -> List[str]:
    return [msg for rx, msg in _CSS_WARN if rx.search(css or "")]


def scan_js(js: str) -> List[str]:
    return [msg for rx, msg in _JS_WARN if rx.search(js or "")]


def _dedupe(items: List[str]) -> List[str]:
    seen, out = set(), []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out


@dataclass
class Validated:
    html: str
    css: str
    js: str
    warnings: List[str] = field(default_factory=list)


def validate(html: str, css: str, js: str) -> Validated:
    html, css, js = html or "", css or "", js or ""
    if len(html) > MAX_HTML or len(css) > MAX_CSS or len(js) > MAX_JS:
        raise ValueError(f"Báo cáo quá lớn (giới hạn HTML {MAX_HTML // 1000}KB, CSS {MAX_CSS // 1000}KB, JS {MAX_JS // 1000}KB).")
    clean_html, warnings = sanitize_html(html)
    warnings += scan_css(css) + scan_js(js)
    ids = [r["id"] for r in list_regions(clean_html)]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        warnings.append("Duplicate data-rac-region ids: " + ", ".join(dupes) + " — region edits need unique ids.")
    return Validated(clean_html, css, js, _dedupe(warnings))


# ── Regions ───────────────────────────────────────────────────────────────────

def list_regions(text: str) -> List[Dict[str, str]]:
    out = []
    for t in _scan(text or ""):
        if t.kind in ("start", "startend"):
            attrs = dict(t.attrs)
            rid = attrs.get("data-rac-region")
            if rid:
                out.append({"id": rid, "tag": t.name, "label": attrs.get("data-rac-label") or attrs.get("aria-label") or ""})
    return out


def region_span(text: str, region_id: str) -> Optional[Tuple[int, int]]:
    tags = _scan(text or "")
    for i, t in enumerate(tags):
        if t.kind in ("start", "startend") and dict(t.attrs).get("data-rac-region") == region_id:
            if t.kind == "startend" or t.name in _VOID:
                return t.start, t.end
            j = _matching_end(tags, i)
            return (t.start, tags[j].end) if j >= 0 else (t.start, len(text))
    return None


def region_markup(text: str, region_id: str) -> Optional[str]:
    span = region_span(text, region_id)
    return text[span[0]:span[1]] if span else None


def replace_region(text: str, region_id: str, new_markup: str) -> str:
    """Swap exactly one region; every byte outside it is left as it was."""
    span = region_span(text, region_id)
    if not span:
        raise ValueError(f"Không tìm thấy vùng '{region_id}' trong báo cáo.")
    markup = (new_markup or "").strip()
    first = next((t for t in _scan(markup) if t.kind in ("start", "startend")), None)
    if first is None:
        raise ValueError("Nội dung mới của vùng không có phần tử HTML nào.")
    if dict(first.attrs).get("data-rac-region") != region_id:
        attrs = [(k, v) for k, v in first.attrs if k != "data-rac-region"] + [("data-rac-region", region_id)]
        markup = markup[:first.start] + _rebuild_start(first, attrs) + markup[first.end:]
    return text[:span[0]] + markup + text[span[1]:]


# ── Upload: a whole HTML file → the three sources ─────────────────────────────

_STYLE_RX = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)
_SCRIPT_RX = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
_JS_TYPES = {"text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript",
             "module", "text/jscript", "application/x-javascript"}
_BODY_RX = re.compile(r"<body\b[^>]*>(.*)</body\s*>", re.I | re.S)


def split_document(raw: str) -> Tuple[str, str, str, List[str]]:
    """An uploaded HTML file as (body html, css, js, warnings)."""
    raw = raw or ""
    warnings: List[str] = []
    css = "\n\n".join(m.group(1).strip() for m in _STYLE_RX.finditer(raw))
    js_parts = []
    for m in _SCRIPT_RX.finditer(raw):
        attrs, body = m.group(1), m.group(2)
        if re.search(r"\bsrc\s*=", attrs, re.I):
            src = re.search(r"src\s*=\s*['\"]?([^'\"\s>]+)", attrs, re.I)
            warnings.append(f"External script {src.group(1)[:80] if src else ''} was not imported — reports cannot load scripts from outside.")
            continue
        # A browser runs a <script> only without a type or with a JavaScript MIME type;
        # anything else (application/json, an import manifest like
        # application/appbi-dashboard, a template) is an inert DATA block. Treating it as
        # code put a JSON object into the JS file: a syntax error the editor flagged
        # and the runtime reported, on a report that runs fine as written.
        tm = re.search(r"\btype\s*=\s*['\"]?([^'\"\s>]+)", attrs, re.I)
        if tm and tm.group(1).lower() not in _JS_TYPES:
            warnings.append(f"A <script type=\"{tm.group(1)[:60]}\"> data block was not imported as JavaScript.")
            continue
        if body.strip():
            js_parts.append(body.strip())
    m = _BODY_RX.search(raw)
    body = m.group(1) if m else raw
    body = _STYLE_RX.sub("", body)
    body = _SCRIPT_RX.sub("", body)
    body = re.sub(r"<!doctype[^>]*>|</?html\b[^>]*>|<head\b.*?</head\s*>", "", body, flags=re.I | re.S)
    return body.strip(), css, "\n\n".join(js_parts), warnings


# ── Serving ───────────────────────────────────────────────────────────────────

def content_hash(html: str, css: str, js: str, bindings, filters) -> str:
    h = hashlib.sha256()
    for part in (html, css, js, json.dumps(bindings, sort_keys=True, default=str), json.dumps(filters, sort_keys=True, default=str)):
        h.update((part or "").encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def new_nonce() -> str:
    return secrets.token_urlsafe(18)


def csp_header(nonce: str, frame_ancestors: str) -> str:
    return "; ".join([
        "default-src 'none'",
        f"script-src 'nonce-{nonce}'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "connect-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "child-src 'none'",
        "worker-src 'none'",
        "manifest-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        f"frame-ancestors {frame_ancestors}",
    ])


PERMISSIONS_POLICY = ("camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), "
                      "bluetooth=(), display-capture=(), clipboard-read=(), publickey-credentials-get=()")


def _no_close(text: str, tag: str) -> str:
    return re.sub(rf"</({tag})", r"<\\/\1", text or "", flags=re.I)


BASE_CSS = """
:root{--rac-font:Inter,"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;--rac-bg:#f5f6fa;--rac-surface:#fff;
--rac-text:#0f172a;--rac-muted:#64748b;--rac-border:#e5e7eb;--rac-grid:#eef1f6;--rac-accent:#4f46e5;--rac-pos:#059669;--rac-neg:#dc2626;--rac-warn:#f59e0b;
--rac-c1:#4f46e5;--rac-c2:#0ea5e9;--rac-c3:#10b981;--rac-c4:#f59e0b;--rac-c5:#ef4444;--rac-c6:#8b5cf6;--rac-c7:#14b8a6;--rac-c8:#f97316}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:var(--rac-font);color:var(--rac-text);background:var(--rac-bg);-webkit-font-smoothing:antialiased}
body:has(> aside + main){display:grid;grid-template-columns:minmax(200px,248px) minmax(0,1fr);min-height:100vh;align-items:start}
body:has(> aside + main) > aside{position:sticky;top:0;height:100vh;overflow:auto}
@media (max-width:960px){body:has(> aside + main){grid-template-columns:minmax(0,1fr)}body:has(> aside + main) > aside{position:static;height:auto}}
main{min-width:0}
.rac-svg{display:block;overflow:visible}
.rac-svg text{font-family:var(--rac-font)}
.rac-axis{font-size:11px;fill:var(--rac-muted)}
.rac-val{font-size:11px;fill:var(--rac-text);font-weight:600}
.rac-grid{stroke:var(--rac-grid);stroke-width:1}
.rac-guide{stroke:var(--rac-muted);stroke-dasharray:3 3}
.rac-state{display:flex;align-items:center;justify-content:center;min-height:90px;color:var(--rac-muted);font-size:13px;text-align:center;padding:12px}
.rac-error{color:var(--rac-neg)}
.rac-skel{height:100%;min-height:90px;border-radius:10px;background:linear-gradient(90deg,var(--rac-grid) 25%,#f8fafc 50%,var(--rac-grid) 75%);background-size:200% 100%;animation:rac-sh 1.2s infinite}
@keyframes rac-sh{to{background-position:-200% 0}}
.rac-kpi{display:flex;flex-direction:column;gap:6px}
.rac-kpi-label{font-size:13px;color:var(--rac-muted);font-weight:500}
.rac-kpi-value{font-size:28px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.rac-kpi-foot{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--rac-muted);flex-wrap:wrap}
.rac-kpi-delta{font-weight:600;padding:2px 6px;border-radius:999px;background:#eef2ff;color:var(--rac-accent)}
.rac-kpi-delta.pos{background:#ecfdf5;color:var(--rac-pos)}.rac-kpi-delta.neg{background:#fef2f2;color:var(--rac-neg)}
.rac-kpi-spark{margin-top:4px}
.rac-donut{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.rac-donut-v{font-size:18px;font-weight:700;fill:var(--rac-text)}
.rac-legend{display:flex;flex-direction:column;gap:6px;min-width:140px;flex:1}
.rac-leg{display:flex;align-items:center;gap:8px;font-size:12px}.rac-leg-l{flex:1;color:var(--rac-muted)}
.rac-tip{position:fixed;z-index:9999;pointer-events:none;background:#0f172a;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 8px 24px rgba(15,23,42,.25);max-width:280px;display:none}
.rac-tip-t{font-weight:600;margin-bottom:4px}.rac-tip-r{display:flex;align-items:center;gap:6px;white-space:nowrap}.rac-tip-r b{margin-left:auto;padding-left:12px}
.rac-tip-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.rac-table-wrap{overflow:auto;max-height:520px}
.rac-table{width:100%;border-collapse:collapse;font-size:13px}
.rac-table th{position:sticky;top:0;background:var(--rac-surface);text-align:left;font-weight:600;color:var(--rac-muted);padding:8px 10px;border-bottom:1px solid var(--rac-border);cursor:pointer;white-space:nowrap}
.rac-table td{padding:8px 10px;border-bottom:1px solid var(--rac-grid)}
.rac-table .num{text-align:right;position:relative;white-space:nowrap}
.rac-table td.num span{position:relative}
.rac-cellbar{position:absolute;right:0;top:20%;bottom:20%;background:color-mix(in srgb,var(--rac-accent) 14%,transparent);border-radius:3px}
.rac-table tr[data-rac-v]:hover td{background:#f8fafc}
.rac-more{margin-top:8px;border:1px solid var(--rac-border);background:var(--rac-surface);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
.rac-note{font-size:12px;color:var(--rac-muted)}
.rac-heat{display:grid;gap:3px;font-size:11px;align-items:center}
.rac-heat-h{color:var(--rac-muted);text-align:center}.rac-heat-r{color:var(--rac-muted);white-space:nowrap;padding-right:6px}
.rac-heat-c{height:26px;border-radius:4px}
.rac-gauge{display:flex;justify-content:center}.rac-gauge-v{font-size:22px;font-weight:700;fill:var(--rac-text)}
.rac-progress{display:flex;flex-direction:column;gap:10px}
.rac-prog-top{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}
.rac-prog-track{height:8px;background:var(--rac-grid);border-radius:999px;overflow:hidden}
.rac-prog-fill{height:100%;background:var(--rac-accent);border-radius:999px}
.rac-filter{position:relative;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:100%}
.rac-filter-date input{min-width:0;width:9.5em;max-width:40vw}
.rac-filter-btn{max-width:100%}
.rac-filter-btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--rac-border);background:var(--rac-surface);color:var(--rac-text);border-radius:10px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}
.rac-filter-l{color:var(--rac-muted);font-size:12px}.rac-filter-v{font-weight:600}.rac-caret{color:var(--rac-muted);font-size:10px}
.rac-filter-date input{border:1px solid var(--rac-border);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;background:var(--rac-surface);color:var(--rac-text)}
.rac-x{border:none;background:transparent;color:var(--rac-muted);font-size:16px;cursor:pointer;padding:0 4px}
.rac-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:50;width:260px;background:var(--rac-surface);border:1px solid var(--rac-border);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:8px}
.rac-pop input[type=search]{width:100%;border:1px solid var(--rac-border);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;margin-bottom:6px}
.rac-opts{max-height:240px;overflow:auto;display:flex;flex-direction:column}
.rac-opt{display:flex;gap:8px;align-items:center;font-size:13px;padding:5px 6px;border-radius:6px;cursor:pointer}.rac-opt:hover{background:#f1f5f9}
.rac-chip{display:inline-flex;align-items:center;gap:4px;background:#eef2ff;color:var(--rac-accent);border-radius:999px;padding:3px 4px 3px 10px;font-size:12px;margin:0 6px 6px 0}
.rac-chip button{border:none;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1}
.rac-chip-clear{border:none;background:transparent;color:var(--rac-muted);font-size:12px;cursor:pointer;text-decoration:underline}
.rac-icon{display:inline-block;vertical-align:middle;flex:none}
body.rac-select [data-rac-region]{cursor:crosshair}
body.rac-select [data-rac-region]:hover{outline:2px dashed var(--rac-accent);outline-offset:2px}
[data-rac-region].rac-selected{outline:2px solid var(--rac-accent)!important;outline-offset:2px}
.rac-flash{outline:3px solid var(--rac-accent)!important;outline-offset:3px;transition:outline-color .3s}
body.rac-prov [data-rac-value],body.rac-prov [data-rac-viz]{outline:2px solid rgba(16,185,129,.85)!important;outline-offset:2px}
body.rac-prov .rac-static{outline:2px dashed rgba(245,158,11,.95)!important;outline-offset:2px;background:rgba(245,158,11,.08)}
"""


def build_export(*, html: str, css: str, js: str, title: str, bindings: List[Dict[str, Any]],
                 snapshot: Dict[str, Any], stamp: str) -> str:
    """The report as ONE standalone HTML file: its code, the runtime and a data snapshot.

    A small host (the last script) plays the AppBI frame host locally: it hands the
    runtime a MessagePort and answers it with the DTOs minted at export time - values
    and meaning only, as a public viewer would receive them (no chart id, field ref or
    SQL). The file opens anywhere; its filters are fixed at the export (a note says so)."""
    import json as _json

    doc = build_document(html=html, css=css, js=js, title=title, nonce="export")
    snap = _json.dumps({"bindings": bindings, "data": snapshot}, ensure_ascii=False, default=str)
    host = (
        "(function(){var S=" + snap.replace("</", "<\\/") + ";var ch=new MessageChannel();"
        "function all(){S.bindings.forEach(function(b){ch.port1.postMessage({type:'data',id:b.id,dto:S.data[b.id]});});}"
        "ch.port1.onmessage=function(e){var m=e.data||{};"
        "if(m.type==='ready'||m.type==='setFilter'||m.type==='clearFilters')all();"
        "if(m.type==='values')ch.port1.postMessage({type:'values',reqId:m.reqId,values:[]});};"
        "window.postMessage({type:'rac:init',v:1,context:{filters:[],state:{},bindings:S.bindings,mode:'view',"
        "locale:'vi-VN'}},'*',[ch.port2]);})();"
    )
    # in the flow at the end of the page: a fixed badge sat on top of the report's content
    note = (f"<footer style=\"clear:both;width:100%;text-align:right;font:11px system-ui;color:#64748b;"
            f"padding:12px 16px\">AppBI · bản xuất {_html.escape(stamp)}"
            " · số liệu chụp tại thời điểm xuất</footer>")
    return doc.replace("</body></html>", f"{note}<script>{_no_close(host, 'script')}</script></body></html>")


def build_document(*, html: str, css: str, js: str, title: str, nonce: str) -> str:
    # The author's script is handed to the runtime as a function: it runs only once
    # the navigation guard is installed and has proved it works (fail closed).
    author = f"rac.__author(function(){{\n{js}\n}});" if (js or "").strip() else ""
    return (
        "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\">"
        "<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        f"<title>{_html.escape(title or 'Report')}</title>"
        f"<style>{BASE_CSS}</style>"
        f"<script nonce=\"{nonce}\">{_no_close(_RUNTIME_JS, 'script')}</script>"
        f"<style>{_no_close(css, 'style')}</style>"
        f"</head><body>{html or ''}"
        f"<script nonce=\"{nonce}\">{_no_close(author, 'script')}</script>"
        "</body></html>"
    )
