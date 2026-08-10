"""Run state: the variables, the templates that read them, and the budget.

WHY THIS EXISTS
---------------
The engine this replaces carried exactly one thing between steps: `carried`, the
RAW TEXT of the immediately preceding step. Step three could not see step one, a
loop had nowhere to accumulate, and a branch could not be taken on anything, because
there was nothing to take it on.

A flow needs a place to put things. This is that place, and it is deliberately a
plain dict rather than an object graph: everything in it has to survive being
serialised into the session store and read back next turn.

WHY THE TEMPLATE LANGUAGE IS `{{name}}` AND NOTHING ELSE
--------------------------------------------------------
No expressions, no method calls, no arithmetic. Conditions are structured
(field/op/value) and transforms are a fixed list of operations, so there is nothing
here for a sandbox to contain. A flow is authored by someone with edit rights and
run on behalf of anonymous viewers — an expression language would be a place for
one to reach the other.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from app.services.agent_flows.envelope import Citation, Notice, TraceStep

logger = logging.getLogger(__name__)

_TEMPLATE_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}")
#: A string that is EXACTLY one template and nothing else. Matters because
#: `over: "{{segments}}"` must yield the LIST, not the string "['SMB', ...]" —
#: getting this wrong turns a loop over 3 segments into a loop over 30 characters.
_SOLE_TEMPLATE_RE = re.compile(r"^\s*\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}\s*$")

#: Hard ceiling on what one session may remember. A per-session store on a public,
#: unauthenticated link with no cap is a way to fill the database from a browser.
#:
#: 256KB, not 32KB. The thing worth remembering across turns is precisely the
#: expensive one — a read of several charts — and at 32KB that value was silently
#: dropped every time, so `when_stale` never actually saved a read. A cap that
#: excludes the only payload the feature exists for is not a cap, it is an off
#: switch. Still bounded, and still reported when it bites.
MAX_MEMORY_BYTES = 256 * 1024


class BudgetExhausted(Exception):
    """Raised the moment a run would exceed what the binding funded.

    Not an error the viewer sees as a failure: the executor catches it, stops
    walking, and the answer is produced from what has already been gathered.
    """


@dataclass
class Budget:
    """Ceilings for the WHOLE run.

    Per-node `max_tool_calls` stopped bounding a turn the moment Loop existed: a
    loop of 25 over an agent with 8 tool calls is 200 tool calls for one question,
    and every one of those numbers was individually within its limit.
    """

    max_llm_calls: int = 12
    max_tool_calls: int = 40
    max_seconds: int = 45
    llm_calls: int = 0
    tool_calls: int = 0
    started_at: float = field(default_factory=time.monotonic)

    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    def check(self) -> None:
        if self.llm_calls >= self.max_llm_calls:
            raise BudgetExhausted("đã dùng hết số lượt gọi mô hình cho câu hỏi này")
        if self.tool_calls >= self.max_tool_calls:
            raise BudgetExhausted("đã dùng hết số lượt gọi công cụ cho câu hỏi này")
        if self.elapsed() >= self.max_seconds:
            raise BudgetExhausted("câu hỏi này đã chạy quá thời gian cho phép")

    def spend_llm(self) -> None:
        self.check()
        self.llm_calls += 1

    def spend_tool(self) -> None:
        self.check()
        self.tool_calls += 1


@dataclass
class RunState:
    """Everything a run accumulates. One instance per turn."""

    vars: dict[str, Any] = field(default_factory=dict)
    #: Every node's result, by node key. Any node can read any earlier node —
    #: the thing `carried` could not do.
    outputs: dict[str, Any] = field(default_factory=dict)
    trace: list[TraceStep] = field(default_factory=list)
    #: Human-readable route, e.g. ["Path A", "Loop×4", "MEDIUM"]. What the Runs
    #: table shows in its "Execution path" column.
    path: list[str] = field(default_factory=list)
    notices: list[Notice] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    #: Variables to persist for the next turn. Written only by nodes whose
    #: `run_policy` says so, never by everything that happens to set a variable.
    memory_set: dict[str, Any] = field(default_factory=dict)
    #: Set by a Stop node, or by the executor when the budget runs out.
    stopped: bool = False
    stop_message: str = ""
    budget: Budget = field(default_factory=Budget)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    #: Every number this run actually READ, harvested from tool results. The
    #: answer's figures are checked against it — a figure the evidence does not
    #: contain is one the model produced from nothing.
    evidence: list[float] = field(default_factory=list)
    #: Every LABEL the run read. A number check alone cannot catch a real figure
    #: attached to the wrong name — a live run listed two product categories that
    #: were not in the chart at all, with values that happened to exist elsewhere
    #: in the payload, and the number check passed it at 100%.
    evidence_labels: set[str] = field(default_factory=set)

    def add_evidence(self, payload: Any, *, depth: int = 0) -> None:
        """Harvest numbers from a tool result.

        Bounded on depth and count: a chart payload can be tens of thousands of
        cells, and the check is "did this figure come from somewhere", not a full
        index of the warehouse.
        """
        if depth > 6 or len(self.evidence) > 20000:
            return
        if isinstance(payload, bool):
            return
        if isinstance(payload, (int, float)):
            self.evidence.append(float(payload))
            return
        if isinstance(payload, str):
            n = _num(payload)
            if n is not None:
                self.evidence.append(n)
            elif 1 < len(payload) <= 80 and len(self.evidence_labels) < 5000:
                self.evidence_labels.add(payload.strip().lower())
            return
        if isinstance(payload, dict):
            for v in payload.values():
                self.add_evidence(v, depth=depth + 1)
            return
        if isinstance(payload, (list, tuple)):
            for v in payload:
                self.add_evidence(v, depth=depth + 1)

    def set_var(self, name: str, value: Any) -> None:
        if name:
            self.vars[name] = value

    def get(self, dotted: str) -> Any:
        """Read `name`, `a.b`, or `outputs.node_key`. Missing reads as None.

        Missing is None rather than an exception on purpose: a branch condition on
        an absent variable should evaluate to "no", not abort the turn. What catches
        a genuinely misspelled variable is `Flow.warnings()` at authoring time,
        where the author can still see it.
        """
        parts = [p for p in (dotted or "").split(".") if p]
        if not parts:
            return None
        head, *rest = parts
        cur: Any = self.outputs if head == "outputs" else self.vars.get(head)
        if head == "outputs" and rest:
            cur = self.outputs.get(rest[0])
            rest = rest[1:]
        for p in rest:
            if isinstance(cur, dict):
                cur = cur.get(p)
            elif isinstance(cur, list) and p.isdigit():
                cur = cur[int(p)] if int(p) < len(cur) else None
            else:
                return None
        return cur

    # ── Templates ─────────────────────────────────────────────────────────────
    def resolve(self, text: str) -> Any:
        """Resolve a template, PRESERVING TYPE when the string is exactly one.

        `"{{segments}}"`      → the list itself
        `"Phân tích {{seg}}"` → a string with the value interpolated
        """
        if not isinstance(text, str) or "{{" not in text:
            return text
        sole = _SOLE_TEMPLATE_RE.match(text)
        if sole:
            return self.get(sole.group(1))
        return self.resolve_text(text)

    def resolve_text(self, text: str) -> str:
        if not isinstance(text, str) or "{{" not in text:
            return text or ""

        def sub(m: re.Match) -> str:
            v = self.get(m.group(1))
            if v is None:
                return ""
            if isinstance(v, (list, tuple)):
                return ", ".join(str(x) for x in v)
            if isinstance(v, dict):
                import json

                return json.dumps(v, ensure_ascii=False)
            return str(v)

        return _TEMPLATE_RE.sub(sub, text)

    # ── Trace ─────────────────────────────────────────────────────────────────
    def record(self, step: TraceStep) -> None:
        self.trace.append(step)

    def path_label(self) -> str:
        return " · ".join(self.path)

    def memory_payload(self) -> dict[str, Any]:
        """What to persist, bounded.

        Refuses oversized values rather than truncating them: half a JSON object
        restored next turn is worse than none, and the author gets a notice saying
        which variable was dropped.
        """
        import json

        out: dict[str, Any] = {}
        total = 0
        for k, v in self.memory_set.items():
            try:
                blob = json.dumps(v, ensure_ascii=False, default=str)
            except Exception:  # noqa: BLE001
                continue
            if total + len(blob) > MAX_MEMORY_BYTES:
                self.notices.append(
                    Notice(
                        code="memory_too_large",
                        text=f"Biến “{k}” quá lớn để nhớ sang lượt sau nên đã bỏ qua.",
                    )
                )
                continue
            total += len(blob)
            out[k] = v
        return out


# ═══ Conditions ═══════════════════════════════════════════════════════════════
def evaluate(state: RunState, left: str, op: str, right: str) -> bool:
    """One structured condition. Never `eval`, never a expression parser."""
    lv = state.resolve(left)
    rv = state.resolve(right)

    if op == "is_empty":
        return _empty(lv)
    if op == "is_not_empty":
        return not _empty(lv)

    if op in {"contains", "not_contains"}:
        hit = _contains(lv, rv)
        return hit if op == "contains" else not hit

    if op in {"equals", "not_equals"}:
        hit = _equals(lv, rv)
        return hit if op == "equals" else not hit

    if op in {"gt", "gte", "lt", "lte"}:
        ln, rn = _num(lv), _num(rv)
        if ln is None or rn is None:
            return False
        return {
            "gt": ln > rn, "gte": ln >= rn, "lt": ln < rn, "lte": ln <= rn,
        }[op]

    if op == "matches":
        try:
            return bool(re.search(str(rv or ""), str(lv or ""), re.IGNORECASE))
        except re.error:
            # A malformed pattern is an authoring mistake, not a run-time crash.
            logger.warning("[flow] bad regex in condition: %r", rv)
            return False

    if op == "in_list":
        options = rv if isinstance(rv, (list, tuple)) else str(rv or "").split(",")
        return any(_equals(lv, o) for o in options)

    return False


def evaluate_all(state: RunState, conditions: list[Any], match: str) -> bool:
    """`all` on an empty list is True — a path with no rules runs, which is what
    "Always run" means and what an author expects from an empty condition list."""
    if not conditions:
        return True
    results = [evaluate(state, c.left, c.op, c.right) for c in conditions]
    return all(results) if match == "all" else any(results)


def _empty(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return not v.strip()
    if isinstance(v, (list, tuple, dict, set)):
        return len(v) == 0
    return False


def _contains(haystack: Any, needle: Any) -> bool:
    """Membership for lists, substring for text — chosen by the LEFT side's type.

    LIST MEMBERSHIP IS NOT EXACT EQUALITY, and that is a deliberate correction.
    Real field names arrive fully qualified: `available_metrics` on a live report
    holds `dataset_table_438.total_revenue`, not `revenue`. Exact matching made the
    obvious condition — `available_metrics contains revenue`, the mockup's own
    example — never fire, so every flow silently took its fallback branch.

    So an element matches when the needle equals it outright, or appears within its
    LAST dotted segment. The cost is that `revenue` also matches `revenue_growth`.
    That is the right side to err on: the author is asking "does this report have
    something revenue-ish", and a condition that never matches is worse than one
    that matches a near neighbour.
    """
    if haystack is None:
        return False
    if isinstance(haystack, dict):
        return str(needle) in haystack
    want = str(needle or "").strip().lower()
    if isinstance(haystack, (list, tuple, set)):
        if not want:
            return False
        for x in haystack:
            if _equals(x, needle):
                return True
            leaf = str(x if x is not None else "").split(".")[-1].lower()
            if want in leaf:
                return True
        return False
    return want in str(haystack).lower()


def _equals(a: Any, b: Any) -> bool:
    an, bn = _num(a), _num(b)
    if an is not None and bn is not None:
        return an == bn
    return str(a if a is not None else "").strip().lower() == str(
        b if b is not None else ""
    ).strip().lower()


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip().replace(",", ""))
    except (TypeError, ValueError):
        return None


def as_list(value: Any, *, limit: int) -> list[Any]:
    """What a Loop walks.

    A model or a binding may hand back a JSON string, a comma-separated line, or a
    real list; a loop that silently iterates the CHARACTERS of a string is the
    classic version of this bug, so a bare string becomes a one-item list unless it
    parses as JSON or is clearly delimited.
    """
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)[:limit]
    if isinstance(value, dict):
        return list(value.values())[:limit]
    text = str(value).strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            import json

            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed[:limit]
        except Exception:  # noqa: BLE001
            pass
    if "," in text:
        return [p.strip() for p in text.split(",") if p.strip()][:limit]
    return [text]
