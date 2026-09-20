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

It will not cut inside an object. A JSON payload is reduced STRUCTURALLY — the
biggest arrays lose their tails first, and the identity fields an answer actually
cites (ids, titles, status, scope) are scalars and survive by construction. Prose
is cut on a line boundary. A fragment ending mid-number reads to a model as a
complete finding.

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


def _shrink_json(obj: Any, budget: int) -> tuple[Any, bool]:
    """Halve the biggest list repeatedly until the object fits.

    Structural, so what comes out is still valid JSON — the defect this replaces
    cut the serialised text at a character offset, mid-array and mid-number.
    """
    reduced = False
    for _ in range(40):
        if len(json.dumps(obj, ensure_ascii=False)) <= budget:
            return obj, reduced
        biggest, size = None, 0
        stack: list[Any] = [obj]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                stack.extend(node.values())
            elif isinstance(node, list):
                n = len(json.dumps(node, ensure_ascii=False))
                if n > size and len(node) > 1:
                    biggest, size = node, n
                stack.extend(node)
        if biggest is None:
            return obj, True
        keep = max(1, len(biggest) // 2)
        dropped = len(biggest) - keep
        del biggest[keep:]
        biggest.append("… (%d mục nữa đã lược)" % dropped)
        reduced = True
    return obj, True


def _reduce(text: str, budget: int) -> tuple[str, bool]:
    """Fit `text` into `budget` without cutting inside a unit of meaning."""
    if len(text) <= budget:
        return text, False
    stripped = text.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            obj, was = _shrink_json(json.loads(stripped), budget)
            out = json.dumps(obj, ensure_ascii=False)
            if len(out) <= budget:
                return out, was
        except (ValueError, TypeError):
            pass
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
