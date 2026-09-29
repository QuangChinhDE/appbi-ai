# -*- coding: utf-8 -*-
"""What went wrong, said to the person who asked — not to the model that retried.

WHY THIS EXISTS.

A refused tool call carries two audiences in one object. `result.err()` writes a
message for the MODEL: it names the tool, the chart id and the raw field so the
agent can pick a different chart on its next turn. That is the right message for
that reader, and nothing here changes it.

It became the wrong message the moment the same object reached a viewer. On a
public `/d/{token}` link an anonymous reader opening "view details" was shown

    rank_values: biểu đồ 684 nhóm theo 'year_month', không phải theo
                 'customer_state' — câu hỏi đang hỏi theo 'customer_state'.

which hands out an internal tool id, a chart id and two column names, to someone
who cannot open the report those ids belong to. The notice ABOVE it was already
correct — it said "Customer state", the governed label — so the structured facts
needed to say this properly were present the whole time and simply were not used
on this path.

WHY IT CONSTRUCTS AND NEVER FILTERS.

The same argument `reader_capability` makes about `coverage()`: sanitising the
technical message on the way out leaves the next person to add a field one
interpolation away from a leak, and a regex over rendered prose cannot know
whether `684` is a chart id or a revenue figure. So this builds the reader's
sentence from `error_code` + `detail` and never looks at `result["error"]`.

The allow-list is the point, not an optimisation. An error code this module does
not know maps to the generic sentence, so a code added next month leaks nothing
by default — it just says less than it could until someone teaches it a line.

WHAT IS NOT AFFECTED.

The author's trace. `state.tool_log`, the run envelope's `trace`, the Runs tab
and the logs keep the full technical message, the tool name and the chart id:
diagnosing a refusal still needs exactly those, and a reader was never who they
were written for.
"""
from __future__ import annotations

from typing import Any

#: Said when the code is one this module has not been taught. Deliberately the
#: default rather than a fallback nobody reaches: an unknown code is precisely
#: the case where we do not know which parts of `detail` are safe to say.
GENERIC = "Bước này không hoàn thành được."


def tool_label(tool_name: str | None) -> str:
    """The registry's product-facing name for a tool, e.g. `Xếp hạng theo chỉ số`.

    `ToolSpec.label_vi` is what the builder's picker already shows an author, so
    the reader sees the same words the product uses elsewhere rather than a third
    vocabulary invented here.
    """
    name = (tool_name or "").strip()
    if not name:
        return ""
    try:
        # `all_tools()` is a dict KEYED BY NAME. Iterating it yields the keys,
        # which silently sent every lookup to the fallback below — safe, but the
        # product's own word was there and went unused.
        from app.services.agent_flows.tools.registry import all_tools

        spec = all_tools().get(name)
        label = str(getattr(spec, "label_vi", "") or "").strip() if spec else ""
        if label:
            return label
    except Exception:  # noqa: BLE001 - a label must never break a run
        pass
    # Unknown to the registry: humanise rather than echo `snake_case`, which is
    # itself a give-away that an identifier is showing through.
    return name.replace("_", " ").strip().capitalize()


def _dimension_sentence(detail: dict) -> str:
    """The refusal that started this: the chart does not cut by what was asked."""
    label = str(detail.get("requested_label") or "").strip()
    if label:
        return (
            f"Biểu đồ được chọn không tách số liệu theo {label}, "
            "nên không dùng được cho câu hỏi này."
        )
    # `requested_dimension` is a raw field key. Saying less is correct here.
    return (
        "Biểu đồ được chọn không tách số liệu theo chiều bạn hỏi, "
        "nên không dùng được cho câu hỏi này."
    )


#: WHAT A REFUSED CALL MEANS TO A READER, as opposed to whether it succeeded.
#:
#: `ok: False` is a TRANSPORT fact — the call did not return a payload. It says
#: nothing about whether the system failed, and every reader surface was deriving
#: its error count from it. So a link that correctly withheld an out-of-scope
#: chart, a tool that correctly declined a chart with no date axis, and a
#: warehouse that actually fell over were all counted the same and printed as
#: "3 errors" above a perfectly good answer. A product that reports its own
#: governance working as three failures teaches readers to distrust it.
#:
#: The classification the reader needs already exists as `error_code`; it was
#: simply thrown away one layer before the reader. Three classes, because that is
#: what a reader can act on:
#:
#:   notice      the system behaved correctly and there is nothing to fix —
#:               the data is out of scope, absent, or the calculation does not
#:               apply. Not a failure in any sense the reader would recognise.
#:   limitation  the answer is available but narrower than asked for; the request
#:               could not be served exactly as put.
#:   error       something actually broke.
#:
#: An unknown code maps to `error` ON PURPOSE. This module's allow-list style is
#: "say less when unsure" for TEXT, but severity must fail the other way: quietly
#: downgrading an unrecognised failure to a notice would hide real breakage, and
#: hiding breakage is the one outcome worse than over-reporting it.
_OUTCOME_BY_CODE: dict[str, str] = {
    # Governance and scope boundaries. The system working as designed.
    "dimension_mismatch": "notice",
    "chart_out_of_scope": "notice",
    "not_granted": "notice",
    "gated": "notice",
    # Ran fine, nothing to return. `result.py` says it outright: "NOT an error
    # to hide".
    "no_data": "notice",
    "not_applicable": "notice",
    # The request could not be served as asked, and the agent usually recovers
    # by asking differently. Worth saying; not a breakage.
    "chart_not_found": "limitation",
    "bad_argument": "limitation",
    # Real failures.
    "query_failed": "error",
    "internal": "error",
    "unknown_tool": "error",
}

READER_OUTCOMES = ("ok", "notice", "limitation", "error")


def reader_outcome(result: Any) -> str:
    """How a READER should read this tool result: ok / notice / limitation / error.

    Returns `"ok"` for anything that is not a failure, so a caller can classify
    every result through one call.
    """
    if not isinstance(result, dict) or result.get("ok") is True:
        return "ok"
    code = str(result.get("error_code") or "").strip()
    return _OUTCOME_BY_CODE.get(code, "error")


def reader_error(result: Any) -> str:
    """A sentence a viewer can act on, built only from structured facts.

    Returns "" when the result is not a failure, so a caller can keep sending
    `None` on the success path.
    """
    if not isinstance(result, dict) or result.get("ok") is True:
        return ""
    code = str(result.get("error_code") or "").strip()
    detail = result.get("detail") if isinstance(result.get("detail"), dict) else {}

    if code == "dimension_mismatch":
        return _dimension_sentence(detail or {})
    if code in ("chart_out_of_scope", "not_granted", "gated"):
        return "Phần dữ liệu này không nằm trong phạm vi được chia sẻ."
    if code == "chart_not_found":
        return "Không tìm thấy biểu đồ cần dùng trong báo cáo này."
    if code == "no_data":
        return "Không có dữ liệu phù hợp với câu hỏi này."
    if code == "not_applicable":
        return "Phép tính này không áp dụng được cho biểu đồ đã chọn."
    if code == "query_failed":
        return "Không lấy được số liệu cho yêu cầu này."
    return GENERIC
