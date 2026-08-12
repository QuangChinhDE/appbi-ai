"""What a tool result IS.

WHY THIS FILE EXISTS
--------------------
A tool used to return whatever dict its body happened to build. That was
survivable when the only consumer was a language model reading prose-ish JSON:
the model glanced at it, and a missing field just meant a vaguer answer.

It stopped being survivable the moment tools acquired two more consumers — a
flow node branching on a result WITHOUT a model, and a verifier checking the
answer's figures against the data they came from. Both need to know the shape
before they read it, and neither can ask a model what it is looking at.

Three things every result must now carry, because each one was a bug:

LANGUAGE: everything in a result is English. A tool result is read by a model,
not by a person, so it is a machine contract — and one written half in Vietnamese
and half in English is a contract in neither. The viewer's language is decided
from the viewer's own question at the edge of the system. What stays Vietnamese
is what an AUTHOR reads in the builder (`label_vi`, `description_vi`).

`kind`       what shape the payload is, so an `if` node can read `.value` without
             a model translating for it, and the frontend can render a result as a
             block rather than pasting JSON into a bubble.

`coverage`   how much of the data this is. `get_chart_data` truncated to fifty
             rows and reported `row_count: 50` — the count AFTER the cut, with no
             total. A model reading that has no way to know it is holding a
             fragment, so it answered "the top category is agro_industry" when it
             held rows 1-50 of 72 in alphabetical order. The answer was off by a
             factor of seventeen and nothing in the result was false; the result
             was simply silent about being partial. Silence is the defect.

`error.code` a machine-readable reason. `{"ok": false, "error": "<sentence>"}`
             can only be branched on by matching substrings of a Vietnamese
             sentence, so no flow ever branched on failure and every error became
             "the agent says something went wrong".

ONE SHAPE, AND IT IS THE ONE THAT ALREADY EXISTED
-------------------------------------------------
Every result looks like this, whichever tool produced it::

    {"ok": true, "kind": "ranking", "data": {…payload…}, "coverage": {…}}

The payload sits under `data` because that is where twenty-four tool bodies
already put it — `_ok()` in `dashboard_ai_bot/tool_context.py` has wrapped it
that way since the first-generation bot — and where every prompt, provider
adapter and regression assertion expects to find it. Contract fields are its
SIBLINGS, never mixed into it: `data` is whatever the tool has to say, and `ok`,
`kind` and `coverage` are what the system says about it. A reader never has to
know which tool it is holding to know where to look.

Getting this wrong is not hypothetical. The engine spent an afternoon returning
`{}` from every tool call because one side wrote the payload under `content` and
the other read `result` — the same class of mistake, one level up. So `coverage`
is HOISTED out of `data` when a body puts it there, rather than being legal in
two places.

The rule the run envelope follows applies here too: absent is not a different
shape, and new fields are additive. See `agent_flows/envelope.py`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

#: What shape the payload is. A flow node branches on this without a model, and
#: the frontend picks a renderer from it.
#:
#: Deliberately coarse. `kind` answers "how do I read this", not "what does it
#: mean" — a taxonomy fine enough to name every tool would just be the tool list
#: again, and a second list that can disagree with the first.
ResultKind = Literal[
    "value",       # one number/string + its unit — `value`, `formatted`
    "ranking",     # ordered items with a share of total — `items[]`, `total`
    "table",       # columns + rows, possibly partial — `columns`, `rows`
    "series",      # points over time — `points[]`
    "comparison",  # two sides and their delta — `a`, `b`, `delta`, `pct_change`
    "diagnosis",   # findings with evidence — `findings[]`
    "projection",  # forecast points + confidence — `points[]`, `method`
    "documents",   # retrieved text with citations — `documents[]`
    "narrative",   # prose meant for a model to read, not to branch on
    "catalogue",   # a list of things that exist — charts, fields, filters
]

#: Why a call failed, in a form a flow can branch on.
#:
#: `retryable` is carried separately rather than derived from the code, because
#: "the warehouse timed out" and "the warehouse rejected the SQL" share a code in
#: every driver and differ in whether trying again is sane.
ErrorCode = Literal[
    "bad_argument",        # the caller passed something the tool cannot use
    "chart_out_of_scope",  # real chart, not granted to this link's binding
    "chart_not_found",     # no such chart on this dashboard
    "no_data",             # ran fine, found nothing — NOT an error to hide
    "not_applicable",      # e.g. a trend over a chart with no date field
    "query_failed",        # the warehouse or semantic layer refused
    "gated",               # the deployment or link withholds this pack
    "not_granted",         # the step was never given this tool
    "unknown_tool",        # no such tool
    "internal",            # a bug — the body raised
]


@dataclass(frozen=True)
class Coverage:
    """How much of the data the payload represents.

    `total=None` means genuinely unknown (a streaming or sampled source), which
    is different from `total=returned` meaning "this is all of it". Collapsing
    the two is what let a partial read pass for a complete one.
    """

    returned: int
    total: int | None = None
    #: How the rows were ordered BEFORE truncation. Without this, "the first 50"
    #: is not a fact about the data — it is a fact about nothing.
    ordered_by: str | None = None
    #: Set when the caller asked for fewer rows than exist.
    truncated: bool | None = None
    #: Whether the figures were derived from EVERY row, even if only some are
    #: listed. This is the difference between a page of a table and the top of a
    #: ranking, and collapsing it produced a worse answer than having no coverage
    #: at all: `rank_values` computes over all 72 groups and returns the top one,
    #: and the first version of this class labelled that "CHỈ có 1/72 dòng —
    #: không được kết luận về thứ hạng". The model dutifully passed the warning
    #: on, so a correct, complete ranking was presented to the viewer with a
    #: sentence undermining it. A caveat attached to a sound answer is not a
    #: harmless caveat.
    computed_over_all: bool = False

    def to_dict(self) -> dict[str, Any]:
        truncated = self.truncated
        if truncated is None:
            truncated = self.total is not None and self.returned < self.total
        out: dict[str, Any] = {"returned": self.returned, "truncated": truncated}
        if self.total is not None:
            out["total"] = self.total
        if self.ordered_by:
            out["ordered_by"] = self.ordered_by
        if self.computed_over_all:
            out["computed_over_all"] = True
            # Listing fewer than exist is what was ASKED for here, so the note
            # says the answer is sound rather than warning against it.
            if self.total is not None and self.returned < self.total:
                out["note"] = (
                    f"Computed over ALL {self.total} groups; listing the top "
                    f"{self.returned} by {self.ordered_by or 'the measure'}. "
                    "The ranks and shares here are exact — state them plainly, "
                    "with no hedging about missing data."
                )
        elif truncated:
            # Spelled out because a model reading a boolean in a nested object
            # will not reliably act on it, and acting on it is the entire point.
            shown = f"{self.returned}/{self.total}" if self.total is not None else str(self.returned)
            out["note"] = (
                f"ONLY {shown} rows, ordered by {self.ordered_by or 'source order'}. "
                "Do not draw a total, a ranking, or any whole-population claim "
                "from this fragment."
            )
        return out


def ok(
    payload: dict[str, Any],
    *,
    kind: ResultKind,
    coverage: Coverage | None = None,
) -> dict[str, Any]:
    """A successful result: the payload under `data`, plus what it is and how
    complete beside it."""
    out: dict[str, Any] = {"ok": True, "kind": kind, "data": payload}
    if coverage is not None:
        out["coverage"] = coverage.to_dict()
    return out


def err(
    message: str,
    *,
    code: ErrorCode,
    retryable: bool = False,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A failure a flow can branch on and a person can read.

    `error` stays a plain string in the position it has always occupied, so
    existing readers keep working; `error_code` is what a condition tests.
    """
    out: dict[str, Any] = {
        "ok": False,
        "error": message,
        "error_code": code,
        "retryable": retryable,
    }
    if detail:
        out["detail"] = detail
    return out


#: Legacy bodies signal failure with a bare sentence. Until every body is
#: rewritten, infer the code from it — matched on stable English fragments the
#: bodies emit, never on user-facing Vietnamese.
_CODE_HINTS: tuple[tuple[str, ErrorCode], ...] = (
    ("not in scope", "chart_out_of_scope"),
    ("không thuộc", "chart_out_of_scope"),
    ("không được cấp", "not_granted"),
    # A document outside the report's scope is a permission boundary, not a
    # warehouse failure. `query_failed` told a flow to retry a query that never
    # ran — and told an operator to look at the database.
    ("no such document within", "not_granted"),
    ("only published documents", "not_granted"),
    ("unknown tool", "unknown_tool"),
    ("not found", "chart_not_found"),
    ("is required", "bad_argument"),
    ("must be", "bad_argument"),
    # `compute` refuses caller-written expressions. A sandbox rejection, a
    # division by zero and an overflow were all landing on `query_failed`, which
    # tells a flow to retry a warehouse that never ran.
    ("bad argument", "bad_argument"),
    ("not allowed", "bad_argument"),
    ("invalid expression", "bad_argument"),
    ("not in columns", "bad_argument"),
    ("no data", "no_data"),
    ("failed to load", "query_failed"),
    ("raised", "internal"),
)


def classify(message: str) -> ErrorCode:
    """Best-effort code for a legacy error string."""
    low = (message or "").lower()
    for fragment, code in _CODE_HINTS:
        if fragment in low:
            return code
    return "query_failed"


def normalise(raw: Any, *, kind: ResultKind) -> dict[str, Any]:
    """Bring a legacy body's return value up to the contract.

    Adds only what is missing, and moves `coverage` up out of the payload when a
    body reported it from inside. A body that already speaks the contract passes
    through untouched, so there is never a moment where the wrapper and the body
    disagree about a result they both described.
    """
    if not isinstance(raw, dict):
        return err(
            f"tool returned {type(raw).__name__}, expected an object",
            code="internal",
        )
    if raw.get("ok") is False:
        if "error_code" in raw:
            return raw
        message = str(raw.get("error") or "tool failed")
        return err(message, code=classify(message), retryable=False)

    out = dict(raw)
    out.setdefault("ok", True)
    out.setdefault("kind", kind)
    # A legacy body reports coverage from inside its payload — it has no way to
    # reach the envelope. Hoist it, so `coverage` is findable in exactly one
    # place no matter which generation of tool produced the result.
    payload = out.get("data")
    if "coverage" not in out and isinstance(payload, dict) and "coverage" in payload:
        out["coverage"] = payload["coverage"]
    return out
