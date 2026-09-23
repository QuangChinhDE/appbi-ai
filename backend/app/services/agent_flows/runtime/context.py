# -*- coding: utf-8 -*-
"""What a downstream model RECEIVES, as distinct from what a step PRODUCED.

THE INVARIANT THIS EXISTS FOR

A green upstream node must imply either that its result reached the step that
needed it, or that its absence is recorded. Before this, neither was true: each
step's text was head-sliced at 2,000 characters and the 8,000-character total was
spent in run order and then abandoned. A Report Read could hold exactly the right
chart and hand the answering model a fragment ending mid-array, and a third
specialist could vanish entirely because the first was verbose — while the run
reported three healthy steps.

TWO THINGS ARE SEPARATE HERE

    full step output   what the runtime produced; the trace and replay keep it
    model handoff      this projection, which is bounded and self-describing

WHAT IT WILL NOT DO

It will not cut inside an object. A JSON payload is reduced STRUCTURALLY, and
BULK GOES BEFORE IDENTITY: lists of rows lose their tails before lists of things
an answer cites by id or name. An earlier version of this docstring claimed the
identity fields "survive by construction because they are scalars" — they are
scalars INSIDE the elements the reducer was deleting, and a 13-chart read reached
the answering step as one chart with all its rows intact. Prose is cut on a line
boundary. A fragment ending mid-number reads to a model as a complete finding.

FAIRNESS IS DELIBERATE

Allocation is max-min (water-filling): every step gets an equal share, whatever a
step does not need is redistributed to the ones that do, repeatedly. Order does
not decide who survives. Cheap, deterministic, and explainable to an author —
which matters more here than optimality.

BUDGET

Characters, centrally, with one approximate conversion. Not a tokenizer: an exact
per-provider count belongs behind this function if it is ever needed, and a
model-specific constant scattered through node handlers is what this replaces.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

#: THE handoff ceiling. Lives here because this module owns the handoff; the read
#: node and the answering node both import it rather than each keeping a copy that
#: can drift. One did drift: the read node's author-facing notice kept saying
#: "2.000 ký tự" after the ceiling moved, so it told authors a number that no
#: longer existed.
HANDOFF_CHARS = 8000

#: Rough chars-per-token for the mixed Vietnamese/English/JSON this carries.
#: Approximate ON PURPOSE and in ONE place; see the module docstring.
_CHARS_PER_TOKEN = 3.5

#: What a step needs before a block says anything useful. Below it the step is
#: omitted and named, because a stub that looks like a finding is worse.
_MIN_USEFUL = 220

_TRUNCATED_NOTE = (
    "… (phần còn lại của bước này đã được lược bớt để vừa ngữ cảnh — KHÔNG phải "
    "là không có dữ liệu. Nếu câu hỏi cần thứ không thấy ở đây, hãy gọi công cụ "
    "lấy đúng thứ cần thay vì suy ra.)"
)


def budget_chars(max_tokens: int | None = None, *, default: int = HANDOFF_CHARS) -> int:
    """The handoff ceiling, in characters. One conversion, one place."""
    if not max_tokens or max_tokens <= 0:
        return default
    return int(max_tokens * _CHARS_PER_TOKEN)


@dataclass
class StepView:
    """One upstream step as the compiler sees it."""

    key: str
    name: str
    text: str


@dataclass
class Projection:
    """The handoff, plus the accounting an author and a trace need."""

    text: str = ""
    included: list[str] = field(default_factory=list)
    reduced: list[str] = field(default_factory=list)
    omitted: list[str] = field(default_factory=list)
    coverage: dict[str, Any] = field(default_factory=dict)


# ── reduction that respects boundaries ───────────────────────────────────────


#: Keys that make a dict an ENTITY rather than a row: something an answer cites by
#: name or id. A list of these is dropped last.
_IDENTITY_KEYS = ("id", "chart_id", "doc_id", "metric", "title", "name", "chart_name")


def _carries_identity(node: Any) -> bool:
    """Is this a list of things an answer would cite, rather than bulk rows?"""
    if not isinstance(node, list):
        return False
    return any(
        isinstance(v, dict) and any(k in v for k in _IDENTITY_KEYS)
        for v in node[:5]
    )


def _shrink_json(obj: Any, budget: int) -> tuple[Any, bool]:
    """Halve the biggest list repeatedly until the object fits, BULK FIRST.

    Structural, so what comes out is still valid JSON — the defect this replaces
    cut the serialised text at a character offset, mid-array and mid-number.

    Bulk first, because "biggest" alone chose wrong. On a Report Read result the
    biggest array is `charts`, so a 13-chart read reached the answering step as
    ONE chart while every row inside it survived: it dropped ~1.5k of identities
    to keep ~38k of rows. Lists whose elements carry an id or a name are the
    evidence an answer cites; they are reduced only when nothing else is left.
    """
    reduced = False
    for _ in range(80):
        if len(json.dumps(obj, ensure_ascii=False)) <= budget:
            return obj, reduced
        bulk: list[Any] = []
        entities: list[Any] = []
        stack: list[Any] = [obj]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                stack.extend(node.values())
            elif isinstance(node, list):
                if len(node) > 1:
                    (entities if _carries_identity(node) else bulk).append(node)
                stack.extend(node)

        def biggest(cands):
            best, size = None, 0
            for c in cands:
                n = len(json.dumps(c, ensure_ascii=False))
                if n > size:
                    best, size = c, n
            return best

        target = biggest(bulk) or biggest(entities)
        if target is None:
            return obj, True
        keep = max(1, len(target) // 2)
        dropped = len(target) - keep
        del target[keep:]
        target.append("… (%d mục nữa đã lược)" % dropped)
        reduced = True
    return obj, True


def _reduce(text: str, budget: int) -> tuple[str, bool]:
    """Fit `text` into `budget` without cutting inside a unit of meaning."""
    if len(text) <= budget:
        return text, False
    stripped = text.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            parsed = json.loads(stripped)
        except (ValueError, TypeError):
            parsed = None
        if parsed is not None:
            obj, was = _shrink_json(parsed, budget)
            out = json.dumps(obj, ensure_ascii=False)
            if len(out) <= budget:
                return out, was
            # STILL TOO BIG — and falling through to the prose cut below would
            # slice this JSON at a character offset and hand the model a fragment,
            # which is the one thing this function exists to prevent. Degrade to a
            # valid object holding the scalars instead: scope, status, read_ok —
            # the grounding fields — and say the rest is gone.
            if isinstance(obj, dict):
                minimal = {k: v for k, v in obj.items()
                           if not isinstance(v, (list, dict))}
                minimal["_reduced"] = "chi tiết đã lược hết để vừa ngữ cảnh"
                return json.dumps(minimal, ensure_ascii=False), True
            return json.dumps([obj[0]] if obj else [], ensure_ascii=False), True
    room = max(0, budget - len(_TRUNCATED_NOTE) - 1)
    head = text[:room]
    cut = max(head.rfind("\n"), head.rfind(" "))
    if cut > room * 0.4:
        head = head[:cut]
    return head.rstrip() + "\n" + _TRUNCATED_NOTE, True


# ── fair allocation ──────────────────────────────────────────────────────────


def _allocate(sizes: dict[str, int], budget: int) -> dict[str, int]:
    """Max-min shares: equal split, slack from the small redistributed to the big."""
    shares: dict[str, int] = {}
    remaining = dict(sizes)
    left = budget
    while remaining and left > 0:
        even = left // len(remaining)
        settled = [k for k, n in remaining.items() if n <= even]
        if not settled:
            for k in remaining:
                shares[k] = even
            return shares
        for k in settled:
            shares[k] = remaining[k]
            left -= remaining[k]
            del remaining[k]
    for k in remaining:
        shares[k] = 0
    return shares


def compile_context(steps: list[StepView], budget_chars: int) -> Projection:
    """Project the steps that ran into what the next model will actually read."""
    live = [s for s in steps if (s.text or "").strip()]
    out = Projection()
    if not live:
        return out

    sizes = {s.key: len(s.text) for s in live}
    shares = _allocate(sizes, max(0, budget_chars))

    blocks: list[str] = []
    for s in live:
        share = shares.get(s.key, 0)
        if share < _MIN_USEFUL and sizes[s.key] > share:
            out.omitted.append(s.key)
            continue
        body, was_reduced = _reduce(s.text, share)
        blocks.append("### %s\n%s" % (s.name or s.key, body))
        (out.reduced if was_reduced else out.included).append(s.key)

    if out.reduced or out.omitted:
        note = []
        if out.reduced:
            note.append("đã lược bớt: " + ", ".join(out.reduced))
        if out.omitted:
            note.append("chưa gộp được (vượt ngữ cảnh): " + ", ".join(out.omitted))
        blocks.append(
            "(Ghi chú phạm vi — " + "; ".join(note) + ". Phần thiếu KHÔNG phải "
            "là không có dữ liệu. Trả lời bằng những gì đang có và NÓI RÕ phần "
            "chưa gộp; nếu cần thứ không thấy ở đây thì gọi công cụ lấy đúng thứ "
            "cần, đừng suy ra.)"
        )

    out.coverage = {"included": out.included, "reduced": out.reduced,
                    "omitted": out.omitted, "budget_chars": budget_chars}
    out.text = "\n\n".join(blocks)
    return out
