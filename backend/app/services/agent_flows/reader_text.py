"""The reader's answer text carries no internal execution details - whoever wrote it.

`reader_diagnostics` already keeps the STRUCTURED channels clean (tool labels,
error sentences built from codes). The answer PROSE is the one channel it cannot
reach: an agent step's model reads tool results whose technical messages name the
tool id, the raw chart id and the exception ("get_chart_data: chart_id 1566 is
not part of this dashboard"), and nothing but the prompt asked it not to repeat
them. A security guarantee cannot rest on a model following an instruction, so
the answer is scrubbed deterministically before it is stored and published
(executor), on every reader surface - an anonymous public-link visitor included.

Narrow on purpose: it removes identifiers and internals, never words. Each
pattern is a shape no reader-facing sentence needs:

  * a registry TOOL ID (snake_case, from the registry) -> its product label;
  * error codes and internal field names of the run (`chart_out_of_scope`,
    `error_code`, `brain_key`, `answer_node`, ...);
  * a field key with a raw id (`chart_id 1566`, `dataset_table_id=7`) and the
    engine's `dataset_table_<n>` view token;
  * a Python traceback, and exception class names (`ValueError`, ...);
  * a URL or host:port on loopback / an internal service name.

The author's trace keeps the raw text: this applies to the ANSWER only.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

#: Internal names of the run/flow that are never reader vocabulary.
_INTERNAL_WORDS = (
    "error_code", "brain_key", "answer_node", "binding_id", "execution_path",
    "not_executed", "config_source", "output_var", "run_id",
)

_FIELD_ID = re.compile(r"\b(?:chart|dataset|table|dataset_table|view|column)_id\b\s*[:=]?\s*\d*", re.I)
_VIEW_TOKEN = re.compile(r"\bdataset_table_\d+\b")
_TRACEBACK = re.compile(r"Traceback \(most recent call last\):.*?(?:\n\s*\n|\Z)", re.S)
_TB_FRAME = re.compile(r'File "[^"]+", line \d+[^\n]*')
_EXC_CLASS = re.compile(r"\b[A-Z][A-Za-z]*(?:Error|Exception)\b")
_INTERNAL_URL = re.compile(
    r"\b(?:https?|postgres(?:ql)?|mysql|redis)://"
    r"(?:[^\s/@]*@)?(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[a-z0-9-]+(?:\.(?:internal|local|svc|cluster\.local))+|"
    r"(?:backend|frontend|db|postgres|redis|worker|pdf-worker)(?=[:/]))"
    r"(?::\d+)?[^\s)\"'<>]*",
    re.I,
)
_LOOPBACK_HOSTPORT = re.compile(r"\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\b", re.I)
#: The tool layer's own technical sentences (registry error messages), English
#: and never reader text: "chart_id 7 is not part of this dashboard.",
#: "failed to load chart 7: DataError", "unknown tool: x".
_TECH_PHRASES = re.compile(
    r"(?:is not part of this dashboard\.?|failed to load charts?(?:\s+\d+)?:?|unknown tool:?\s*\S*|"
    r"\bnot in scope\b|\bout of scope\b)",
    re.I,
)


@lru_cache(maxsize=1)
def _codes() -> tuple[str, ...]:
    from app.services.agent_flows import reader_diagnostics as rd

    codes = set(getattr(rd, "_OUTCOME_BY_CODE", {}).keys())
    codes |= {"chart_out_of_scope", "not_granted", "gated", "dimension_mismatch", "not_found",
              "tool_error", "budget_exhausted", "run_failed"}
    return tuple(sorted((c for c in codes if "_" in c), key=len, reverse=True))


@lru_cache(maxsize=1)
def _tools() -> tuple[str, ...]:
    try:
        from app.services.agent_flows.tools.registry import all_tools

        names = list(all_tools())
    except Exception:  # noqa: BLE001 - the guard must never take the answer down
        names = []
    names += ["get_chart_data", "rank_values", "total_measure", "search_business_assets"]
    return tuple(sorted({n for n in names if n and "_" in n}, key=len, reverse=True))


def scrub(text: Any) -> Any:
    """``text`` with every internal identifier removed; non-strings unchanged."""
    if not isinstance(text, str) or not text:
        return text
    from app.services.agent_flows.reader_diagnostics import tool_label

    out = _TRACEBACK.sub("", text)
    out = _TB_FRAME.sub("", out)
    out = _INTERNAL_URL.sub("", out)
    out = _LOOPBACK_HOSTPORT.sub("", out)
    out = _VIEW_TOKEN.sub("bảng dữ liệu", out)
    out = _FIELD_ID.sub("", out)
    out = _TECH_PHRASES.sub("", out)
    for name in _tools():
        if name in out:
            label = tool_label(name) or ""
            out = re.sub(rf"\b{re.escape(name)}\b", label if "_" not in label else "", out)
    for word in (*_codes(), *_INTERNAL_WORDS):
        if word in out:
            out = re.sub(rf"\b{re.escape(word)}\b", "", out)
    out = _EXC_CLASS.sub("", out)
    if out == text:
        return text
    # tidy what the removals left behind, without touching untouched text
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r" +([,.;:!?])", r"\1", out)
    out = re.sub(r"\(\s*[,;]?\s*\)", "", out)          # "( , )" left by removals
    out = re.sub(r"([.:;,])(?:\s*[.:;,])+", r"\1", out)  # ". ." / ": ." runs
    return out.strip()


def scrub_answer(answer: Any) -> Any:
    """The same Answer with every reader-facing STRING scrubbed (text, labels,
    captions, callouts, follow-ups). Table cells are the report's data and
    `chart_ref` ids point at the report's own (public) charts: both untouched."""
    blocks = getattr(answer, "blocks", None)
    if not blocks:
        return answer
    changed = False
    for block in blocks:
        for attr in ("markdown", "label", "caption", "text"):
            if hasattr(block, attr):
                old = getattr(block, attr)
                new = scrub(old)
                if new != old:
                    setattr(block, attr, new)
                    changed = True
        if hasattr(block, "items") and isinstance(block.items, list):
            new_items = [scrub(i) for i in block.items]
            if new_items != block.items:
                block.items = new_items
                changed = True
        for col in getattr(block, "columns", None) or []:
            if hasattr(col, "label"):
                new = scrub(col.label)
                if new != col.label:
                    col.label = new
                    changed = True
    return answer
