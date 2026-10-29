"""Minimal server-rendered pages (errors, approvals). No scripts, no external assets."""

from __future__ import annotations

from html import escape

from starlette.responses import HTMLResponse

_CSS = """
:root{--bg:#f7f8fa;--card:#fff;--fg:#1d2433;--muted:#5b6475;--line:#e3e6ec;--accent:#2f5bea;--danger:#b42318;--ok:#067647}
@media (prefers-color-scheme: dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e7eaf0;--muted:#9aa3b5;--line:#2a303c;--accent:#7c9cff;--danger:#ff8a80;--ok:#6fdc8c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 8px}h2{font-size:15px;margin:20px 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
code{font-size:13px}
.actions{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.err{color:var(--danger)}.ok{color:var(--ok)}
"""

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    # Not "no-referrer": under it a browser sends `Origin: null` even on this page's own
    # form POST, and the approval's same-origin check then refuses every real click.
    # "same-origin" keeps the referrer off cross-site requests and sends the true Origin.
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
}


def page(title: str, body_html: str, *, status: int = 200) -> HTMLResponse:
    html = (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{escape(title)}</title><style>{_CSS}</style></head>"
        f"<body><main><div class=card>{body_html}</div></main></body></html>"
    )
    return HTMLResponse(html, status_code=status, headers=SECURITY_HEADERS)


def message(title: str, text: str, *, status: int = 200, tone: str = "") -> HTMLResponse:
    cls = f" class={tone}" if tone else ""
    return page(title, f"<h1{cls}>{escape(title)}</h1><p>{escape(text)}</p>", status=status)
