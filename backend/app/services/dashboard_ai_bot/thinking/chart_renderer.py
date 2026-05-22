"""Server-side chart-to-PNG renderer.

The agent calls ``get_chart_image`` to "see" a chart. We render a small,
analytics-friendly PNG (no fancy theming) and ship it to the LLM as a
multimodal image block so the model can reason about SHAPE.

Implementation notes:
  - Uses matplotlib's ``Agg`` backend (headless, thread-safe).
  - We pick the chart kind from chart_type metadata + role:
      KPI / Number → simple text card with the value
      TREND        → line plot
      DISTRIBUTION → pie/donut style → horizontal bar (clearer at small px)
      BREAKDOWN    → vertical bar (top 12 segments)
  - Output is a base64-encoded PNG, target ≤ 60 KB so SSE+LLM payloads stay
    small. Width 480 px is plenty for "see the shape" at LLM resolution.
  - We never block the event loop: callers should run this in a thread.
"""
from __future__ import annotations

import base64
import io
import logging
import math
import threading
from typing import Any, Sequence

import matplotlib

matplotlib.use("Agg")  # noqa: E402  (must precede pyplot import)
import matplotlib.pyplot as plt  # noqa: E402

logger = logging.getLogger(__name__)

# ── Thread safety ────────────────────────────────────────────────────────────
#
# matplotlib.pyplot is NOT thread-safe — it carries process-global state for
# the active figure / axis. Two concurrent renders (e.g. parallel recon
# fan-out, two users on the same backend) can swap figures mid-flight and
# produce a frankenstein PNG. We serialise every entry point through this
# lock. Renders are 50-200 ms each, so contention is negligible compared to
# the cost of debugging a corrupted overview at 2 AM.
_RENDER_LOCK = threading.Lock()


# Public dataclass-ish dict shape:
#   {
#       "ok": True,
#       "kind": "line" | "bar" | "hbar" | "pie" | "kpi",
#       "png_base64": "...",
#       "width": 480,
#       "height": 280,
#       "approx_kb": 12,
#   }


def render_chart_png(
    *,
    chart_id: int,
    chart_name: str,
    chart_type: str,
    chart_role: str,
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    dim_idx: int | None,
    measure_idx: int | None,
    _skip_lock: bool = False,
) -> dict[str, Any]:
    """Render a chart to PNG and return metadata for the LLM.

    Returns ``{"ok": False, "reason": "..."}`` when there isn't enough data
    to draw anything meaningful — caller should fall back to ASCII.

    ``_skip_lock`` is set to True when called from inside another locked
    renderer (e.g. ``render_dashboard_overview_png``) — the outer lock is
    already held and re-entering would deadlock on a non-RLock primitive.
    """
    if not rows:
        return {"ok": False, "reason": "no rows to plot"}
    if _skip_lock:
        return _render_chart_png_unlocked(
            chart_id=chart_id, chart_name=chart_name, chart_type=chart_type,
            chart_role=chart_role, columns=columns, rows=rows,
            dim_idx=dim_idx, measure_idx=measure_idx,
        )
    with _RENDER_LOCK:
        return _render_chart_png_unlocked(
            chart_id=chart_id, chart_name=chart_name, chart_type=chart_type,
            chart_role=chart_role, columns=columns, rows=rows,
            dim_idx=dim_idx, measure_idx=measure_idx,
        )


def _render_chart_png_unlocked(
    *,
    chart_id: int,
    chart_name: str,
    chart_type: str,
    chart_role: str,
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    dim_idx: int | None,
    measure_idx: int | None,
) -> dict[str, Any]:
    """Inner renderer (caller holds ``_RENDER_LOCK``)."""
    if not rows:
        return {"ok": False, "reason": "no rows to plot"}

    role = (chart_role or "").lower()
    ctype = (chart_type or "").lower()

    # KPI single-value card: chart shows ONE number.
    if role == "kpi" and measure_idx is not None and len(rows) == 1:
        try:
            val = _to_num(rows[0][measure_idx])
        except Exception:
            val = None
        if val is not None:
            return _render_kpi(chart_name, columns[measure_idx], val)

    if dim_idx is None or measure_idx is None:
        return {"ok": False, "reason": "need dimension + measure"}

    points = []
    for r in rows:
        if dim_idx >= len(r) or measure_idx >= len(r):
            continue
        x = r[dim_idx]
        y = _to_num(r[measure_idx])
        if x is None or y is None:
            continue
        points.append((x, y))
    if not points:
        return {"ok": False, "reason": "no numeric points"}

    measure_name = columns[measure_idx]
    dim_name = columns[dim_idx]

    # Pick chart kind
    if role == "trend" or any(h in ctype for h in ("line", "area")) or _looks_datetime(dim_name):
        return _render_line(chart_name, dim_name, measure_name, points)
    if role == "distribution" or any(h in ctype for h in ("pie", "donut")):
        return _render_hbar(chart_name, dim_name, measure_name, points, top=12)
    # default breakdown → vertical bar
    return _render_bar(chart_name, dim_name, measure_name, points, top=12)


# ── Renderers ───────────────────────────────────────────────────────────────


_FIG_DPI = 96
_FIG_W_PX = 480
_FIG_H_PX = 280
_PALETTE = ["#3b82f6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"]


def _new_fig():
    fig, ax = plt.subplots(
        figsize=(_FIG_W_PX / _FIG_DPI, _FIG_H_PX / _FIG_DPI),
        dpi=_FIG_DPI,
    )
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.tick_params(axis="both", labelsize=8, colors="#475569")
    ax.grid(axis="y", color="#e2e8f0", linewidth=0.6, linestyle="-")
    return fig, ax


def _save_png(fig) -> tuple[str, int]:
    buf = io.BytesIO()
    fig.tight_layout(pad=1.0)
    fig.savefig(buf, format="png", dpi=_FIG_DPI, bbox_inches="tight")
    plt.close(fig)
    raw = buf.getvalue()
    return base64.b64encode(raw).decode("ascii"), len(raw)


def _render_kpi(title: str, measure: str, value: float) -> dict[str, Any]:
    fig, ax = _new_fig()
    ax.axis("off")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.text(0.5, 0.65, _fmt_num(value), ha="center", va="center",
            fontsize=42, weight="bold", color=_PALETTE[0])
    ax.text(0.5, 0.30, measure, ha="center", va="center",
            fontsize=11, color="#334155")
    ax.text(0.5, 0.92, _truncate(title, 60), ha="center", va="top",
            fontsize=9, color="#64748b")
    b64, size = _save_png(fig)
    return {
        "ok": True, "kind": "kpi", "png_base64": b64,
        "width": _FIG_W_PX, "height": _FIG_H_PX, "approx_kb": round(size / 1024, 1),
    }


def _render_line(title: str, x_name: str, y_name: str,
                 points: list[tuple[Any, float]]) -> dict[str, Any]:
    points = sorted(points, key=lambda p: str(p[0]))
    xs = list(range(len(points)))
    ys = [p[1] for p in points]
    labels = [str(p[0]) for p in points]

    fig, ax = _new_fig()
    ax.plot(xs, ys, color=_PALETTE[0], linewidth=2.2, marker="o",
            markersize=3.5, markerfacecolor="white",
            markeredgecolor=_PALETTE[0], markeredgewidth=1.4)
    ax.fill_between(xs, ys, color=_PALETTE[0], alpha=0.12)
    ax.set_title(_truncate(title, 60), fontsize=10, color="#0f172a", loc="left", pad=8)

    # Show only ~6 x ticks evenly so labels don't crowd
    if len(labels) > 8:
        step = max(1, len(labels) // 6)
        ticks = list(range(0, len(labels), step))
        if ticks[-1] != len(labels) - 1:
            ticks.append(len(labels) - 1)
        ax.set_xticks(ticks)
        ax.set_xticklabels([_truncate(labels[i], 8) for i in ticks], rotation=30, ha="right")
    else:
        ax.set_xticks(xs)
        ax.set_xticklabels([_truncate(s, 12) for s in labels], rotation=30, ha="right")
    ax.set_xlabel(x_name, fontsize=8, color="#64748b")
    ax.set_ylabel(y_name, fontsize=8, color="#64748b")

    # Annotate first + last + min + max so the LLM has anchors
    if ys:
        idx_min = ys.index(min(ys))
        idx_max = ys.index(max(ys))
        for idx, color in ((0, "#475569"), (len(ys) - 1, "#475569"),
                           (idx_max, "#10b981"), (idx_min, "#ef4444")):
            ax.annotate(_fmt_num(ys[idx]), (xs[idx], ys[idx]),
                        textcoords="offset points", xytext=(0, 6),
                        ha="center", fontsize=7, color=color)

    b64, size = _save_png(fig)
    return {
        "ok": True, "kind": "line", "png_base64": b64,
        "width": _FIG_W_PX, "height": _FIG_H_PX, "approx_kb": round(size / 1024, 1),
    }


def _render_bar(title: str, x_name: str, y_name: str,
                points: list[tuple[Any, float]], *, top: int = 12) -> dict[str, Any]:
    sorted_pts = sorted(points, key=lambda p: -p[1])[:top]
    labels = [_truncate(str(p[0]) or "(blank)", 14) for p in sorted_pts]
    ys = [p[1] for p in sorted_pts]
    xs = list(range(len(sorted_pts)))

    fig, ax = _new_fig()
    bars = ax.bar(xs, ys, color=_PALETTE[0], edgecolor="white", linewidth=0.5)
    # Highlight the top bar
    if bars:
        bars[0].set_color("#1d4ed8")
    ax.set_title(_truncate(title, 60), fontsize=10, color="#0f172a", loc="left", pad=8)
    ax.set_xticks(xs)
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=8)
    ax.set_xlabel(x_name, fontsize=8, color="#64748b")
    ax.set_ylabel(y_name, fontsize=8, color="#64748b")
    # Annotate values
    for bar, y in zip(bars, ys):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                _fmt_num(y), ha="center", va="bottom",
                fontsize=7, color="#334155")
    b64, size = _save_png(fig)
    return {
        "ok": True, "kind": "bar", "png_base64": b64,
        "width": _FIG_W_PX, "height": _FIG_H_PX, "approx_kb": round(size / 1024, 1),
    }


def _render_hbar(title: str, x_name: str, y_name: str,
                 points: list[tuple[Any, float]], *, top: int = 12) -> dict[str, Any]:
    sorted_pts = sorted(points, key=lambda p: -p[1])[:top]
    labels = [_truncate(str(p[0]) or "(blank)", 22) for p in sorted_pts]
    ys = [p[1] for p in sorted_pts]
    ys_rev = list(reversed(ys))
    labels_rev = list(reversed(labels))
    xs = list(range(len(sorted_pts)))

    fig, ax = _new_fig()
    ax.grid(axis="y", visible=False)
    ax.grid(axis="x", color="#e2e8f0", linewidth=0.6)
    bars = ax.barh(xs, ys_rev, color=_PALETTE[0], edgecolor="white", linewidth=0.5)
    if bars:
        bars[-1].set_color("#1d4ed8")
    ax.set_title(_truncate(title, 60), fontsize=10, color="#0f172a", loc="left", pad=8)
    ax.set_yticks(xs)
    ax.set_yticklabels(labels_rev, fontsize=8)
    ax.set_xlabel(y_name, fontsize=8, color="#64748b")
    for bar, y in zip(bars, ys_rev):
        ax.text(bar.get_width(), bar.get_y() + bar.get_height() / 2,
                f" {_fmt_num(y)}", ha="left", va="center",
                fontsize=7, color="#334155")
    b64, size = _save_png(fig)
    return {
        "ok": True, "kind": "hbar", "png_base64": b64,
        "width": _FIG_W_PX, "height": _FIG_H_PX, "approx_kb": round(size / 1024, 1),
    }


# ── Helpers ────────────────────────────────────────────────────────────────


def _to_num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
        if not math.isfinite(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _fmt_num(v: float) -> str:
    if abs(v) >= 1_000_000_000:
        return f"{v/1_000_000_000:.2f}B"
    if abs(v) >= 1_000_000:
        return f"{v/1_000_000:.2f}M"
    if abs(v) >= 1_000:
        return f"{v/1_000:.1f}K"
    if abs(v - round(v)) < 1e-6:
        return f"{int(round(v))}"
    return f"{v:.2f}"


def _truncate(s: str, n: int) -> str:
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


_DT_HINTS = ("date", "time", "month", "week", "year", "day", "ngay", "thang", "tuan", "quy")


def _looks_datetime(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in _DT_HINTS)


# ── Multi-chart composition (used by PDF export) ────────────────────────────


def render_dashboard_pdf(
    *,
    dashboard_name: str,
    chart_payloads: list[dict],
) -> bytes:
    """Render a multi-page PDF: one page per chart + a cover page.

    Each ``chart_payloads`` entry must follow the same shape as the input
    to ``render_chart_png`` (chart_id, chart_name, chart_type, chart_role,
    columns, rows, dim_idx, measure_idx).
    """
    from matplotlib.backends.backend_pdf import PdfPages

    buf = io.BytesIO()
    with _RENDER_LOCK, PdfPages(buf) as pdf:
        # Cover page
        fig, ax = _new_fig()
        ax.axis("off")
        ax.text(0.5, 0.7, dashboard_name or "Dashboard", ha="center",
                fontsize=18, weight="bold", color="#0f172a")
        ax.text(0.5, 0.55, f"{len(chart_payloads)} biểu đồ", ha="center",
                fontsize=12, color="#475569")
        ax.text(0.5, 0.35, "Tạo bởi AI Analyst", ha="center",
                fontsize=10, color="#94a3b8")
        pdf.savefig(fig)
        plt.close(fig)

        # One page per chart
        for payload in chart_payloads:
            try:
                # Inner call: lock already held — pass _skip_lock=True.
                rendered = render_chart_png(_skip_lock=True, **payload)
            except Exception:
                rendered = None
            if not rendered or not rendered.get("ok"):
                # Add a placeholder page so the user can still see what was
                # missing instead of silently dropping a chart.
                fig, ax = _new_fig()
                ax.axis("off")
                ax.text(0.5, 0.5,
                        f"[{payload.get('chart_name', '?')}] không có đủ dữ liệu để vẽ",
                        ha="center", fontsize=10, color="#94a3b8")
                pdf.savefig(fig)
                plt.close(fig)
                continue
            # Decode base64 PNG and re-embed in a fresh page
            png = base64.b64decode(rendered["png_base64"])
            img_buf = io.BytesIO(png)
            import matplotlib.image as mpimg
            img = mpimg.imread(img_buf, format="png")
            fig, ax = plt.subplots(figsize=(7, 5))
            ax.imshow(img)
            ax.axis("off")
            ax.set_title(payload.get("chart_name", ""), fontsize=11,
                         color="#0f172a", loc="left", pad=10)
            pdf.savefig(fig)
            plt.close(fig)

    return buf.getvalue()


def render_dashboard_overview_png(
    *,
    dashboard_name: str,
    chart_payloads: list[dict],
    max_charts: int = 12,
    filters_applied: list[dict] | None = None,
    page_id: str | None = None,
) -> dict[str, Any]:
    """Render a single visual overview of the dashboard for multimodal AI.

    This is not a browser DOM screenshot. It is a server-side visual board that
    preserves dashboard chart order/layout when layout coordinates are present,
    and falls back to a contact sheet otherwise. The goal is to let the model
    inspect the whole report surface from a viewer perspective without exposing
    a manual export button.

    ``filters_applied`` (optional): list of dashboard filter dicts to render
    as a small banner under the title — without it the LLM has no way to
    know if it's looking at "Q3 only" or "all time".

    ``page_id`` (optional): if the dashboard is multi-page, only render
    charts whose ``layout.pageId`` matches. When None, charts from all
    pages are included but visibly grouped (overlapping coordinates would
    otherwise stack on top of each other).
    """
    payloads = [payload for payload in chart_payloads if isinstance(payload, dict)]

    # Multi-page handling: keep only the requested page, OR if multiple
    # distinct pageIds are present and no page_id was given, fall back to
    # contact sheet to avoid overlap.
    payloads, multi_page_mode = _filter_payloads_by_page(payloads, page_id)
    payloads = payloads[:max_charts]
    if not payloads:
        return {"ok": False, "reason": "no chart payloads"}

    with _RENDER_LOCK:
        return _render_overview_unlocked(
            dashboard_name=dashboard_name,
            payloads=payloads,
            filters_applied=filters_applied or [],
            page_id=page_id,
            multi_page_mode=multi_page_mode,
        )


def _filter_payloads_by_page(
    payloads: list[dict], page_id: str | None,
) -> tuple[list[dict], bool]:
    """Resolve multi-page dashboards.

    Returns ``(filtered_payloads, multi_page_mode)`` where ``multi_page_mode``
    is True iff multiple ``pageId`` values were observed AND we kept all of
    them — the caller then forces a contact-sheet layout to prevent stacking.
    """
    page_ids: set[str] = set()
    for p in payloads:
        layout = p.get("layout") if isinstance(p.get("layout"), dict) else {}
        pid = layout.get("pageId")
        if isinstance(pid, str) and pid:
            page_ids.add(pid)

    if page_id is not None:
        kept = [
            p for p in payloads
            if isinstance(p.get("layout"), dict)
            and p["layout"].get("pageId") == page_id
        ]
        return kept, False

    # No page_id requested — if >1 distinct pageIds, force contact sheet
    return payloads, len(page_ids) > 1


def _render_overview_unlocked(
    *,
    dashboard_name: str,
    payloads: list[dict],
    filters_applied: list[dict],
    page_id: str | None,
    multi_page_mode: bool,
) -> dict[str, Any]:
    width_px = 1200
    height_px = 820
    fig = plt.figure(
        figsize=(width_px / _FIG_DPI, height_px / _FIG_DPI),
        dpi=_FIG_DPI,
        facecolor="#f8fafc",
    )
    try:
        title_ax = fig.add_axes([0, 0, 1, 1])
        title_ax.axis("off")
        title_ax.text(
            0.02,
            0.975,
            _truncate(dashboard_name or "Dashboard", 90),
            ha="left",
            va="top",
            fontsize=15,
            weight="bold",
            color="#0f172a",
        )
        # Subtitle: chart count + page hint (when multi-page)
        subtitle = f"Overview image generated from {len(payloads)} visible charts"
        if page_id:
            subtitle += f" — page {page_id}"
        elif multi_page_mode:
            subtitle += " — multi-page (showing all pages on a contact sheet)"
        title_ax.text(
            0.02, 0.952, subtitle,
            ha="left", va="top", fontsize=9, color="#64748b",
        )

        # Filter banner (Fix 5): make active filters visible to the LLM.
        if filters_applied:
            filter_text = _format_filters_for_banner(filters_applied)
            title_ax.text(
                0.02, 0.928,
                f"Filters: {filter_text}",
                ha="left", va="top", fontsize=8, color="#7c3aed",
                style="italic",
            )

        positions = _overview_positions(payloads, force_contact_sheet=multi_page_mode)
        for payload, rect in zip(payloads, positions):
            ax = fig.add_axes(rect)
            ax.set_facecolor("white")
            for spine in ax.spines.values():
                spine.set_visible(True)
                spine.set_color("#cbd5e1")
                spine.set_linewidth(0.8)
            ax.set_xticks([])
            ax.set_yticks([])

            # Fix 4: render KPI charts DIRECTLY on the destination axes at a
            # font size proportional to the cell. Nesting a 480×280 PNG inside
            # a 0.18×0.10 cell shrinks the headline number to ~6 pt and the
            # LLM cannot read it. We do the same for "no labelled data" KPIs
            # so the value is always readable.
            chart_role = str(payload.get("chart_role") or "").lower()
            if chart_role == "kpi" and _try_render_kpi_inline(ax, payload, rect, height_px):
                continue

            try:
                rendered = render_chart_png(
                    chart_id=int(payload.get("chart_id") or 0),
                    chart_name=str(payload.get("chart_name") or "Chart"),
                    chart_type=str(payload.get("chart_type") or ""),
                    chart_role=str(payload.get("chart_role") or ""),
                    columns=payload.get("columns") or [],
                    rows=payload.get("rows") or [],
                    dim_idx=payload.get("dim_idx"),
                    measure_idx=payload.get("measure_idx"),
                    _skip_lock=True,  # outer lock already held
                )
            except Exception:
                logger.debug("overview chart render failed", exc_info=True)
                rendered = {"ok": False}

            if rendered and rendered.get("ok") and rendered.get("png_base64"):
                try:
                    png = base64.b64decode(rendered["png_base64"])
                    import matplotlib.image as mpimg
                    image = mpimg.imread(io.BytesIO(png), format="png")
                    ax.imshow(image)
                    ax.axis("off")
                    continue
                except Exception:
                    logger.debug("overview image embed failed", exc_info=True)

        ax.text(
            0.5,
            0.55,
            _truncate(str(payload.get("chart_name") or "Chart"), 48),
            ha="center",
            va="center",
            fontsize=9,
            color="#0f172a",
            transform=ax.transAxes,
        )
        ax.text(
            0.5,
            0.42,
            "No drawable data",
            ha="center",
            va="center",
            fontsize=8,
            color="#94a3b8",
            transform=ax.transAxes,
        )

        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=_FIG_DPI, facecolor=fig.get_facecolor())
        raw = buf.getvalue()
        return {
            "ok": True,
            "kind": "dashboard_overview",
            "png_base64": base64.b64encode(raw).decode("ascii"),
            "width": width_px,
            "height": height_px,
            "approx_kb": round(len(raw) / 1024, 1),
            "charts_rendered": len(payloads),
        }
    finally:
        # Always close the figure even when savefig raises, otherwise the
        # global pyplot state leaks and future renders see ghost axes.
        plt.close(fig)


def _normalize_layout(raw: dict | None) -> dict | None:
    """Convert any supported layout shape into a canonical {x,y,w,h} dict.

    Handles two encodings:
      - Grid mode  : {x, y, w, h} as ints (react-grid-layout)
      - Canvas mode: {xPx, yPx, wPx, hPx} as floats (pixel-positioned canvas)

    Returns None if neither shape is fully populated.
    """
    if not isinstance(raw, dict):
        return None
    # Grid first
    if all(isinstance(raw.get(k), (int, float)) for k in ("x", "y", "w", "h")):
        return {"x": float(raw["x"]), "y": float(raw["y"]),
                "w": max(1.0, float(raw["w"])), "h": max(1.0, float(raw["h"]))}
    # Canvas fallback
    if all(isinstance(raw.get(k), (int, float)) for k in ("xPx", "yPx", "wPx", "hPx")):
        return {"x": float(raw["xPx"]), "y": float(raw["yPx"]),
                "w": max(1.0, float(raw["wPx"])), "h": max(1.0, float(raw["hPx"]))}
    return None


def _try_render_kpi_inline(ax, payload: dict, rect: list[float], fig_h_px: int) -> bool:
    """Draw a KPI value directly on ``ax`` at a font size that matches the
    cell. Returns True if a value was drawn, False if the payload had no
    usable single-number measure (caller will fall back to PNG path).

    The font sizes scale with cell height in pixels so the headline stays
    legible whether the KPI takes 5% or 25% of the canvas.
    """
    measure_idx = payload.get("measure_idx")
    rows = payload.get("rows") or []
    if measure_idx is None or not rows:
        return False
    # Take the first row's measure — KPI charts have a single row by design
    try:
        v = rows[0][measure_idx] if measure_idx < len(rows[0]) else None
    except (IndexError, TypeError):
        return False
    val = _to_num(v)
    if val is None:
        return False

    cell_h_px = max(40, int(fig_h_px * rect[3]))
    # Headline ~ 38% of cell height; capped so very tall KPIs don't overshoot.
    headline_pt = max(14, min(54, int(cell_h_px * 0.38)))
    label_pt = max(7, min(13, int(cell_h_px * 0.10)))
    title_pt = max(6, min(11, int(cell_h_px * 0.08)))

    columns = payload.get("columns") or []
    measure_name = ""
    if isinstance(measure_idx, int) and 0 <= measure_idx < len(columns):
        measure_name = str(columns[measure_idx])

    ax.text(
        0.5, 0.92,
        _truncate(str(payload.get("chart_name") or "KPI"), 36),
        ha="center", va="top", fontsize=title_pt, color="#64748b",
        transform=ax.transAxes,
    )
    ax.text(
        0.5, 0.55,
        _fmt_num(val),
        ha="center", va="center",
        fontsize=headline_pt, weight="bold", color="#1d4ed8",
        transform=ax.transAxes,
    )
    if measure_name:
        ax.text(
            0.5, 0.18,
            _truncate(measure_name, 30),
            ha="center", va="center",
            fontsize=label_pt, color="#334155",
            transform=ax.transAxes,
        )
    ax.axis("off")
    return True


def _format_filters_for_banner(filters: list[dict]) -> str:
    """Compact one-line representation of public filters for the banner."""
    parts: list[str] = []
    for f in filters[:6]:  # cap so the banner doesn't overflow
        if not isinstance(f, dict):
            continue
        field = f.get("field") or f.get("column") or "?"
        op = f.get("op") or f.get("operator") or "="
        val = f.get("value") if "value" in f else f.get("values")
        if isinstance(val, (list, tuple)):
            val_str = ", ".join(str(v) for v in val[:3])
            if len(val) > 3:
                val_str += f", … (+{len(val) - 3})"
        else:
            val_str = str(val)
        parts.append(f"{field}{op}{val_str}")
    if len(filters) > 6:
        parts.append(f"… (+{len(filters) - 6} filter)")
    return "; ".join(parts) if parts else "(none)"


def _overview_positions(payloads: list[dict], *, force_contact_sheet: bool = False) -> list[list[float]]:
    """Compute axes rectangles `[left, bottom, width, height]` for each chart.

    Layout-aware when ≥50% of payloads carry resolvable layout coordinates
    (grid OR canvas pixels). Otherwise — or when ``force_contact_sheet`` is
    True — falls back to a contact-sheet grid where every cell is reserved
    upfront so charts never overlap.
    """
    if force_contact_sheet:
        return _contact_sheet_positions(len(payloads))

    # Pre-resolve layouts; capture the index of payloads that have NO layout.
    resolved_layouts: list[dict | None] = []
    no_layout_indices: list[int] = []
    for i, payload in enumerate(payloads):
        norm = _normalize_layout(payload.get("layout"))
        resolved_layouts.append(norm)
        if norm is None:
            no_layout_indices.append(i)

    valid_count = sum(1 for x in resolved_layouts if x is not None)
    if valid_count < max(1, len(payloads) // 2):
        return _contact_sheet_positions(len(payloads))

    max_x = max(
        layout["x"] + layout["w"]
        for layout in resolved_layouts if layout is not None
    ) or 12.0
    max_y = max(
        layout["y"] + layout["h"]
        for layout in resolved_layouts if layout is not None
    ) or 12.0
    left_pad = 0.025
    right_pad = 0.025
    top_pad = 0.135  # increased to accommodate filter banner
    bottom_pad = 0.03
    usable_w = 1.0 - left_pad - right_pad
    usable_h = 1.0 - top_pad - bottom_pad

    # Reserve a contact-sheet grid for the charts WITHOUT layout — sized to
    # exactly that count so we never reuse the same cell for two charts
    # (Fix 2 — old code reused fallback cells and overlapped).
    if no_layout_indices:
        fallback_grid = _contact_sheet_positions(len(no_layout_indices))
    else:
        fallback_grid = []

    positions: list[list[float]] = []
    fb_iter = iter(fallback_grid)
    for layout in resolved_layouts:
        if layout is None:
            try:
                positions.append(next(fb_iter))
            except StopIteration:
                # Should never happen — defensive default.
                positions.append([left_pad, bottom_pad, 0.2, 0.2])
            continue
        layout_x = layout["x"]
        layout_y = layout["y"]
        layout_w = layout["w"]
        layout_h = layout["h"]

        left = left_pad + (layout_x / max_x) * usable_w
        width = (layout_w / max_x) * usable_w
        # Min size so one tiny chart in a sea of big ones is still legible.
        width = max(0.08, min(width, 1 - left - right_pad))

        # Dashboard y grows DOWN; matplotlib axis y grows UP, so flip.
        top = 1.0 - top_pad - (layout_y / max_y) * usable_h
        height = (layout_h / max_y) * usable_h
        # Clamp so the cell never extends past the bottom margin OR has
        # bottom < bottom_pad — old code re-set bottom but kept height,
        # producing chart cells that visually overflowed (Fix 3).
        height = max(0.06, min(height, top - bottom_pad))
        bottom = top - height
        positions.append([left, bottom, width, height])

    # Detect overlapping rectangles (e.g. two charts authored at identical
    # x,y,w,h by mistake). If we find any, fall back to contact-sheet so
    # nothing is hidden.
    if _has_overlap(positions):
        return _contact_sheet_positions(len(payloads))
    return positions


def _has_overlap(rects: list[list[float]]) -> bool:
    """Return True if any two rects overlap with > 70% area intersection."""
    for i in range(len(rects)):
        ax, ay, aw, ah = rects[i]
        for j in range(i + 1, len(rects)):
            bx, by, bw, bh = rects[j]
            ix = max(ax, bx)
            iy = max(ay, by)
            ix2 = min(ax + aw, bx + bw)
            iy2 = min(ay + ah, by + bh)
            if ix2 <= ix or iy2 <= iy:
                continue
            inter = (ix2 - ix) * (iy2 - iy)
            min_area = min(aw * ah, bw * bh)
            if min_area > 0 and inter / min_area > 0.7:
                return True
    return False


def _contact_sheet_positions(count: int) -> list[list[float]]:
    cols = max(1, math.ceil(math.sqrt(count)))
    rows = max(1, math.ceil(count / cols))
    gap = 0.018
    left_pad = 0.025
    right_pad = 0.025
    # Match layout-aware path so the filter banner has room (0.135 vs old 0.105).
    top_pad = 0.135
    bottom_pad = 0.03
    cell_w = (1.0 - left_pad - right_pad - gap * (cols - 1)) / cols
    cell_h = (1.0 - top_pad - bottom_pad - gap * (rows - 1)) / rows
    positions: list[list[float]] = []
    for idx in range(count):
        row = idx // cols
        col = idx % cols
        left = left_pad + col * (cell_w + gap)
        bottom = 1.0 - top_pad - (row + 1) * cell_h - row * gap
        positions.append([left, bottom, cell_w, cell_h])
    return positions
