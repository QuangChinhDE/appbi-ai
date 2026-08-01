"""Headless-Chromium PDF render worker.

Runs as its own container (``pdf-worker`` in docker-compose) built from the
backend image plus Playwright + Chromium, so the API image stays slim and a
deployment that doesn't want server-side export simply doesn't start it.

    python -m app.scripts.pdf_worker

Loop: claim a job (``FOR UPDATE SKIP LOCKED``) → open the report's PRINT view
once per dashboard page → ``page.pdf()`` → merge the sections → store the file →
mark the job done. Progress + heartbeat are written on every step, which is both
the browser's progress bar and the lease that lets another worker take over if
this one dies.

Why print the real ``/d/<token>?print=1`` page instead of rebuilding the report
server-side: the printed document then comes from the SAME React code, the same
chart components and the same page-scope filter rules the viewer sees. There is
no second layout engine to keep in sync — the class of bug where "the PDF shows
different numbers than the screen" cannot exist.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import signal
import sys
import time
from typing import Any, Optional
from urllib.parse import quote, urlencode

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.export_job import DashboardExportJob
from app.services import pdf_export_service

logging.basicConfig(
    level=getattr(logging, str(settings.LOG_LEVEL or "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [pdf-worker] %(message)s",
)
logger = logging.getLogger("pdf_worker")

_STOP = False

# Paper geometry, in mm: (long edge, short edge). Margins leave room for the
# running header/footer templates Chromium draws.
_PAPER_MM = {"a4": (297.0, 210.0), "a3": (420.0, 297.0), "letter": (279.4, 215.9)}
_MARGIN_MM = {"top": 16.0, "bottom": 14.0, "left": 8.0, "right": 8.0}
_PX_PER_MM = 96.0 / 25.4


def _paper_mm(fmt: str, landscape: bool) -> tuple[float, float]:
    long_edge, short_edge = _PAPER_MM.get(fmt, _PAPER_MM["a4"])
    return (long_edge, short_edge) if landscape else (short_edge, long_edge)


def _page_css(width_mm: float, height_mm: float) -> str:
    """Explicit @page for THIS job.

    The app ships a global `@media print { @page { size: A4; margin: 10mm } }`
    for the workboard template printer. That rule wins over Playwright's
    `format`/`landscape` arguments, so a landscape export silently came out as
    portrait A4 with the right-hand column of tiles CLIPPED off the sheet.
    Injecting the page box we actually want (and printing with
    prefer_css_page_size=True) puts this job in charge of its own paper without
    touching the other feature's rule.
    """
    m = _MARGIN_MM
    return (
        "@page { size: %.1fmm %.1fmm; margin: %.0fmm %.0fmm %.0fmm %.0fmm; }"
        % (width_mm, height_mm, m["top"], m["right"], m["bottom"], m["left"])
    )


def _handle_signal(signum, _frame):  # noqa: ANN001
    global _STOP
    logger.info("signal %s received — finishing current job then exiting", signum)
    _STOP = True


def _header_template(title: str, page_name: str) -> str:
    """Running header. Chromium renders these templates with its own tiny CSS
    context (no page styles, no inherited font), hence the inline styling."""
    safe_title = (title or "").replace("<", "&lt;")
    safe_page = (page_name or "").replace("<", "&lt;")
    return (
        '<div style="width:100%;font-family:Segoe UI,Roboto,Helvetica,sans-serif;'
        'font-size:9px;color:#0f172a;padding:4px 10mm 0 10mm;display:flex;'
        'justify-content:space-between;align-items:baseline">'
        f'<span style="font-weight:600">{safe_title}</span>'
        f'<span style="color:#64748b">{safe_page}</span>'
        "</div>"
    )


def _footer_template(subtitle: str) -> str:
    safe = (subtitle or "").replace("<", "&lt;")
    return (
        '<div style="width:100%;font-family:Segoe UI,Roboto,Helvetica,sans-serif;'
        'font-size:8px;color:#94a3b8;padding:0 10mm 4px 10mm;display:flex;'
        'justify-content:space-between;align-items:baseline">'
        f"<span>{safe}</span>"
        '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>'
        "</div>"
    )


def _is_full_data(job: DashboardExportJob) -> bool:
    """True for the layouts that print ALL the data ('tiled' / 'single').

    Snapshot is the default, so anything unrecognised (or absent, e.g. a job
    queued by an older build) is treated as a snapshot.
    """
    return str(((job.params or {}).get("layout") or "snapshot")).lower() in ("tiled", "single", "full")


def _render_url(job: DashboardExportJob, page_id: str) -> str:
    params = job.params or {}
    query = {"print": "1"}
    if page_id:
        query["page"] = page_id
    filters = params.get("filters") or []
    if filters:
        raw = json.dumps(filters, ensure_ascii=False).encode("utf-8")
        query["filters"] = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    # The page needs to know which export this is: 'full' expands every table to
    # all its rows, 'snapshot' (default) prints what the report shows. Sending it
    # here is what stops a snapshot job from paying for a thousand-row DOM.
    query["layout"] = "full" if _is_full_data(job) else "snapshot"
    base = str(settings.PDF_RENDER_BASE_URL).rstrip("/")
    return f"{base}/d/{quote(job.link_token or '')}?{urlencode(query)}"


def _page_ids(job: DashboardExportJob) -> list[str]:
    pages = [str(p) for p in ((job.params or {}).get("pages") or []) if str(p).strip()]
    # No explicit selection → render whatever page the report opens on.
    return pages or [""]


def _seed_session(context, token: str, session_token: Optional[str]) -> None:
    """Pre-load the public session the same way the browser would.

    A password-protected link keeps its session in ``sessionStorage`` under
    ``appbi_pub_session_<token>``; without it the worker's page would land on the
    password gate and render nothing.
    """
    if not session_token:
        return
    payload = json.dumps(
        {"sessionToken": session_token, "expiresAt": int(time.time() * 1000) + 2 * 60 * 60 * 1000}
    )
    context.add_init_script(
        "try { sessionStorage.setItem("
        f"{json.dumps('appbi_pub_session_' + token)}, {json.dumps(payload)}"
        "); } catch (e) {}"
    )


def _wait_ready(page, timeout_s: int) -> bool:
    """Block until the report says it finished rendering (shared readiness
    protocol, `frontend/src/lib/render-ready.ts`). Returns False on timeout —
    the section is still printed, but the job is flagged partial."""
    try:
        page.wait_for_function(
            "() => window.__APPBI_PDF_READY__ === true",
            timeout=timeout_s * 1000,
        )
        return True
    except Exception:  # noqa: BLE001 — playwright TimeoutError and friends
        return False


# Below this factor the charts stop being readable. Snapshot exports ignore it
# (the user asked for one sheet and gets an advisory instead); the full-data
# layouts use it to decide between fitting and paginating.
_MIN_FIT = 0.5

# Chromium's own bounds for page.pdf(scale=…).
_PDF_SCALE_MIN = 0.1
_PDF_SCALE_MAX = 2.0

_MEASURE_SCRIPT = """
() => {
  const root = document.querySelector('[data-pdf-root]');
  if (!root) return 0;
  return Math.max(root.scrollHeight, root.offsetHeight, 0);
}
"""


def _content_height_px(page) -> int:
    """Rendered height of the report section, in CSS pixels."""
    try:
        return int(page.evaluate(_MEASURE_SCRIPT) or 0)
    except Exception:  # noqa: BLE001
        return 0


def _fit_scale(page, avail_h_px: int, min_fit: float) -> float:
    """How much to shrink so this dashboard page lands on ONE sheet.

    Returns 1.0 when it already fits and 0.0 when it would have to shrink below
    `min_fit` (caller then lets the section paginate normally).

    This is deliberately a *print* scale handed to ``page.pdf(scale=…)`` rather
    than a CSS transform on the DOM. The transform version — scale the root and
    widen it by 1/scale to compensate — produced exactly the artefact the DA
    reported: the tile FRAMES grew to the new width, but every Recharts
    ResponsiveContainer had already measured itself at the old width and never
    re-measured, so each chart sat as a postage stamp inside a full-width card.
    Chromium's print scale re-renders the whole page at the target size instead,
    so the layout composes at full width first and only then shrinks — charts fill
    their cards, text stays vector, and no DOM is mutated.
    """
    h = _content_height_px(page)
    if not h:
        return 1.0
    # 0.985 keeps a hair of slack: a scale that lands exactly on the sheet height
    # can still spill a sub-pixel row onto a second, blank page.
    scale = min(1.0, (avail_h_px / h) * 0.985)
    if scale >= 1.0:
        return 1.0
    if scale < min_fit:
        return 0.0
    return max(_PDF_SCALE_MIN, min(_PDF_SCALE_MAX, scale))


def _merge_pdfs(sections: list[bytes]) -> tuple[bytes, int]:
    """Concatenate the per-page sections into one document."""
    if len(sections) == 1:
        try:
            from pypdf import PdfReader

            return sections[0], len(PdfReader(io.BytesIO(sections[0])).pages)
        except Exception:  # noqa: BLE001
            return sections[0], 0
    from pypdf import PdfWriter

    writer = PdfWriter()
    for chunk in sections:
        writer.append(io.BytesIO(chunk))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue(), len(writer.pages)


def _render_job(browser, db, job: DashboardExportJob) -> None:
    params = job.params or {}
    fmt = str(params.get("format") or "a4").lower()
    orientation = str(params.get("orientation") or "landscape").lower()
    landscape = orientation != "portrait"
    paper_w_mm, paper_h_mm = _paper_mm(fmt, landscape)
    # Render at EXACTLY the printable width: the report then lays itself out for
    # the sheet, so nothing is scaled down or cropped at the right edge.
    width = int(round((paper_w_mm - _MARGIN_MM["left"] - _MARGIN_MM["right"]) * _PX_PER_MM))
    height = int(round((paper_h_mm - _MARGIN_MM["top"] - _MARGIN_MM["bottom"]) * _PX_PER_MM))
    page_css = _page_css(paper_w_mm, paper_h_mm)

    title = str(params.get("title") or "Báo cáo")
    subtitle = str(params.get("subtitle") or "")
    page_names: dict[str, str] = dict(params.get("page_names") or {})
    ids = _page_ids(job)

    context = browser.new_context(
        viewport={"width": width, "height": height},
        # Crisp text/vector output. A snapshot may re-render at width/scale (up to
        # ~3.5k px wide); 2× on top of that is a needlessly large raster buffer, so
        # the render loop steps this down when it widens the viewport.
        device_scale_factor=2,
        locale="vi-VN",
        timezone_id=str(params.get("timezone") or "Asia/Ho_Chi_Minh"),
    )
    _seed_session(context, job.link_token or "", params.get("session"))
    sections: list[bytes] = []
    warnings: list[dict[str, Any]] = []
    try:
        for index, page_id in enumerate(ids):
            if pdf_export_service.is_cancelled(db, job.id):
                logger.info("job=%s cancelled by requester", job.id)
                return
            page_name = page_names.get(page_id, "")
            pdf_export_service.heartbeat(
                db,
                job.id,
                progress=int(5 + 85 * index / max(1, len(ids))),
                message=f"Đang dựng trang {index + 1}/{len(ids)}"
                + (f" — {page_name}" if page_name else "") + "…",
            )
            page = context.new_page()
            try:
                page.goto(_render_url(job, page_id), wait_until="domcontentloaded", timeout=60000)
                if not _wait_ready(page, settings.PDF_RENDER_PAGE_TIMEOUT):
                    warnings.append({
                        "page": page_name or page_id or "(trang mặc định)",
                        "chart": "(toàn trang)",
                        "reason": "Trang chưa vẽ xong trong thời gian cho phép — có thể thiếu dữ liệu.",
                    })
                page.add_style_tag(content=page_css)
                # Snapshot means "one dashboard page on one sheet" — the user asked
                # for it, so there is no legibility bail-out; we shrink as far as
                # needed and add an advisory. The full-data layouts keep the old
                # behaviour: fit when it stays readable, otherwise paginate.
                min_fit = _PDF_SCALE_MIN if not _is_full_data(job) else _MIN_FIT
                fit = _fit_scale(page, height, min_fit)
                if fit and fit < 1:
                    # ── The subtle part ──────────────────────────────────────
                    # `page.pdf(scale=s)` does NOT photograph the current render:
                    # Chromium re-lays the page out at width/s and then shrinks the
                    # result. Anything fluid (our tile cards) therefore grows to the
                    # wider layout, while a chart SVG whose pixel width was baked in
                    # by JS at the old, narrower viewport does not — which is exactly
                    # the "chart thu bé tí mà viền vẫn rộng" the DA reported, and the
                    # same trap the earlier CSS-transform version fell into.
                    #
                    # Fix: render at the width the print layout will actually use, so
                    # every chart measures itself at its final size BEFORE we print.
                    page.set_viewport_size({
                        "width": int(round(width / fit)),
                        "height": int(round(height / fit)),
                    })
                    # Let the charts re-measure and settle at the new width.
                    page.wait_for_timeout(900)
                    # The taller/wider layout can change the content height a little
                    # (wrapped labels, legends), so re-check once and keep the more
                    # conservative scale rather than spilling onto a second sheet.
                    refit = _fit_scale(page, height, min_fit)
                    if refit and refit < fit:
                        fit = refit
                        page.set_viewport_size({
                            "width": int(round(width / fit)),
                            "height": int(round(height / fit)),
                        })
                        page.wait_for_timeout(500)
                    logger.info(
                        "job=%s page=%s printed at scale %.2f (layout %dpx) to fit one sheet",
                        job.id, page_id or "-", fit, int(round(width / fit)),
                    )
                if not _is_full_data(job) and 0 < fit < 0.62:
                    warnings.append({
                        "page": page_name or page_id or "(trang mặc định)",
                        "chart": "(toàn trang)",
                        "reason": f"Trang bị thu nhỏ còn {round(fit * 100)}% để vừa một tờ — chọn khổ A3 hoặc hướng ngang để dễ đọc hơn.",
                        # Advisory, not a hole in the data: see finish_job.
                        "severity": "info",
                    })
                sections.append(
                    page.pdf(
                        print_background=True,
                        prefer_css_page_size=True,   # honour the @page injected above
                        display_header_footer=True,
                        header_template=_header_template(title, page_name),
                        footer_template=_footer_template(subtitle),
                        # fit == 0 means "too tall to shrink legibly" → print at
                        # 1:1 and let the section paginate.
                        scale=fit if fit else 1.0,
                    )
                )
            finally:
                page.close()
    finally:
        context.close()

    if not sections:
        pdf_export_service.fail_job(db, job.id, "Không dựng được trang nào.")
        return

    pdf_export_service.heartbeat(db, job.id, progress=94, message="Đang ghép file PDF…")
    data, page_count = _merge_pdfs(sections)
    target = pdf_export_service.export_dir() / f"{job.id}.pdf"
    with open(target, "wb") as fh:
        fh.write(data)
    pdf_export_service.complete_job(
        db, job.id, file_path=str(target), page_count=page_count, warnings=warnings,
    )
    logger.info(
        "job=%s done pages=%s bytes=%s warnings=%s", job.id, page_count, len(data), len(warnings),
    )


def run() -> int:
    from playwright.sync_api import sync_playwright

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    logger.info(
        "starting — render base=%s poll=2s lease=%ss",
        settings.PDF_RENDER_BASE_URL, settings.PDF_JOB_LEASE_SECONDS,
    )
    last_cleanup = 0.0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            while not _STOP:
                db = SessionLocal()
                try:
                    # Retention pass roughly every 10 minutes, from whichever
                    # worker gets there first (deleting an already-deleted file
                    # is a no-op, so no coordination is needed).
                    if time.time() - last_cleanup > 600:
                        removed = pdf_export_service.cleanup_expired(db)
                        if removed:
                            logger.info("retention: removed %s expired export file(s)", removed)
                        last_cleanup = time.time()

                    job = pdf_export_service.claim_next_job(db)
                    if job is None:
                        time.sleep(2)
                        continue
                    logger.info("job=%s claimed (attempt %s)", job.id, job.attempts)
                    started = time.time()
                    try:
                        _render_job(browser, db, job)
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("job=%s render failed", job.id)
                        pdf_export_service.fail_job(db, job.id, str(exc))
                    finally:
                        logger.info("job=%s finished in %.1fs", job.id, time.time() - started)
                except Exception:  # noqa: BLE001 — never let the loop die
                    logger.exception("worker loop error")
                    time.sleep(5)
                finally:
                    db.close()
        finally:
            browser.close()
    logger.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(run())
