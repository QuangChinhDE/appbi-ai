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
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

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
    `resource` says which ceiling: a spent TOOL ceiling stops the step that
    needed a tool, not the run — the answering step may need only the model.
    """

    def __init__(self, message: str = "", *, resource: str = "all") -> None:
        super().__init__(message)
        self.resource = resource


class StepBudgetExhausted(Exception):
    """THIS step may not make a model call: what is left is reserved for the steps
    after it (`Budget.llm_reserve_stack`).

    Not `BudgetExhausted`: the run is not over — the step is recorded as an error
    naming the reservation, and the executor walks on to the steps the reservation
    exists for. A gathering step that cannot gather must never be the reason the
    answering step cannot answer.
    """


#: Dict keys whose numeric value identifies a record rather than measuring
#: anything. Evidence is the pile an answer's figures are checked against, so a
#: primary key in it is a false witness: it can only ever agree by coincidence.
#: How many results one run may register as referenceable evidence. A run has a
#: tool budget of tens of calls; this only stops a runaway from growing the store.
_MAX_EVIDENCE_REFS = 500

_IDENTIFIER_KEYS = frozenset({
    "id", "chart_id", "dashboard_id", "doc_id", "dataset_id", "dataset_table_id",
    "link_id", "binding_id", "run_id", "version", "flow_version",
})


def caller_numbers(args: Any, *, depth: int = 0) -> list[float]:
    """Every number the caller put into a call's arguments (numbers and numeric
    strings, a few levels deep). Bounded: arguments are small by contract."""
    out: list[float] = []
    if depth > 3 or args is None or isinstance(args, bool):
        return out
    if isinstance(args, (int, float)):
        return [float(args)]
    if isinstance(args, str):
        n = _num(args)
        return [n] if n is not None else []
    if isinstance(args, dict):
        for v in list(args.values())[:50]:
            out += caller_numbers(v, depth=depth + 1)
    elif isinstance(args, (list, tuple)):
        for v in list(args)[:50]:
            out += caller_numbers(v, depth=depth + 1)
    return out


def _is_caller_number(value: float, caller: list[float] | None) -> bool:
    return any(abs(value - c) <= 1e-9 * max(1.0, abs(c)) for c in (caller or ()))


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

    #: WHAT THE REST OF THE FLOW STILL NEEDS, pushed by the executor around every
    #: node (`executor._run_body`): the minimum model / tool calls of the nodes
    #: after it, at every level of nesting. A step spends only what is left above
    #: that, so no step — a gathering agent, a coordinator lane, a Skill's child —
    #: can spend the call a later mandatory step needs in order to run at all.
    #:
    #: Measured before this existed: an agent that found its evidence and then
    #: asked for one more tool on its last model call ended the run "đã dùng hết
    #: số lượt gọi mô hình" with the evidence in hand and nothing said.
    llm_reserve_stack: list[int] = field(default_factory=list)
    tool_reserve_stack: list[int] = field(default_factory=list)

    #: Tool calls kept back for the step that actually answers. A gathering step
    #: reads a fixed cost per chart, so on a wide report it can spend the whole
    #: turn's budget before the answering step asks its first question — and the
    #: viewer gets "chưa trả lời được" from a run where every step said ok.
    #: Gathering steps stop at the reserve; the answering step may spend it.
    answer_reserve: int = 6

    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    def tools_left(self, *, answering: bool = False) -> int:
        """Tool calls still available to this kind of step."""
        ceiling = self.max_tool_calls - sum(self.tool_reserve_stack)
        if not answering:
            ceiling -= min(self.answer_reserve, self.max_tool_calls // 3)
        return max(0, ceiling - self.tool_calls)

    def llm_available(self) -> int:
        """Model calls the CURRENT step may still make: what is left, minus what
        the steps after it are guaranteed."""
        return max(0, self.max_llm_calls - self.llm_calls - sum(self.llm_reserve_stack))

    @contextmanager
    def reserve(self, *, llm: int, tools: int) -> Iterator[None]:
        """Hold `llm` / `tools` back for the steps after the one about to run."""
        self.llm_reserve_stack.append(max(0, int(llm)))
        self.tool_reserve_stack.append(max(0, int(tools)))
        try:
            yield
        finally:
            self.llm_reserve_stack.pop()
            self.tool_reserve_stack.pop()

    def try_spend_llm(self) -> bool:
        """An OPTIONAL model call — a correction — spends only what is available
        to this step; it never eats a later step's reservation, and it never
        raises: not making an optional call is not a failure."""
        if self.llm_available() <= 0:
            return False
        try:
            self.spend_llm()
        except BudgetExhausted:
            return False
        return True

    def ledger(self) -> dict[str, int]:
        return {
            "llm_calls": self.llm_calls, "max_llm_calls": self.max_llm_calls,
            "tool_calls": self.tool_calls, "max_tool_calls": self.max_tool_calls,
            "llm_reserved": sum(self.llm_reserve_stack),
            "tools_reserved": sum(self.tool_reserve_stack),
        }

    def _check_clock(self) -> None:
        if self.elapsed() >= self.max_seconds:
            raise BudgetExhausted("câu hỏi này đã chạy quá thời gian cho phép")

    def check(self) -> None:
        """For the executor, BETWEEN nodes: may ANY step still run?

        Only when nothing can: both ceilings spent, or the clock. One ceiling
        spent is not the end of the run — a Tool step that used the last tool call
        must not stop the answering agent, which needs only a model call. Found by
        review: `[tool step, agent]` funded 5 model calls and 1 tool call died
        `budget_exhausted` before the answer, on a link preflight accepted. Each
        resource is still gated where it is SPENT (`spend_llm`, `spend_tool`).
        """
        if self.llm_calls >= self.max_llm_calls and self.tool_calls >= self.max_tool_calls:
            raise BudgetExhausted("đã dùng hết số lượt gọi mô hình và công cụ cho câu hỏi này")
        self._check_clock()

    def spend_llm(self) -> None:
        """A MODEL round is gated by the MODEL ceiling, never by the tool one.

        Both spenders used to call `check()`, so the two ceilings locked each
        other: a turn that legitimately spent its tool allowance could not open
        the one round it needed to say what it had found, and the viewer got
        "chưa trả lời được" out of a run whose every step reported ok. Running out
        of tools is a reason to stop READING — never a reason to be unable to
        speak.
        """
        if self.llm_calls >= self.max_llm_calls:
            raise BudgetExhausted("đã dùng hết số lượt gọi mô hình cho câu hỏi này")
        self._check_clock()
        self.llm_calls += 1

    def spend_tool(self) -> None:
        """A TOOL call is gated by the TOOL ceiling, never by the model one.

        The mirror of the case above: a round that had already been paid for
        could not run the tools it had just asked for, so the model's work was
        thrown away at the last step instead of being used.
        """
        if self.tool_calls >= self.max_tool_calls:
            raise BudgetExhausted("đã dùng hết số lượt gọi công cụ cho câu hỏi này",
                                  resource="tools")
        self._check_clock()
        self.tool_calls += 1


@dataclass
class RunState:
    """Everything a run accumulates. One instance per turn."""

    vars: dict[str, Any] = field(default_factory=dict)
    #: Every node's result, by node key. Any node can read any earlier node —
    #: the thing `carried` could not do.
    outputs: dict[str, Any] = field(default_factory=dict)
    trace: list[TraceStep] = field(default_factory=list)
    #: WHAT THE ANSWERING MODEL ACTUALLY SAW — which upstream steps reached it,
    #: which were reduced, which did not fit. A node's output and a node's
    #: contribution to the next prompt are different things, and an author who
    #: inspects the first and assumes the second has been wrong before.
    context_coverage: dict[str, Any] = field(default_factory=dict)
    #: WHY THE EVIDENCE IS HERE — per read step. Numeric verification asks whether
    #: a figure exists in the evidence; it cannot ask whether the evidence answers
    #: the question. Recorded so a run can tell "selected for this question" from
    #: "read through an explicit report-overview mode" from "unresolved", which
    #: are three different grounds for the same set of numbers.
    question_grounding: dict[str, Any] = field(default_factory=dict)
    #: WHICH STEPS PRODUCED EVIDENCE. `evidence` is a flat list of numbers, so
    #: "did this figure come from the step whose question never resolved" was
    #: unanswerable — and without it, a grounding rule could only punish every run
    #: with any unresolved source, including ones another capability answered
    #: correctly. The smallest contract that makes the distinction safe.
    evidence_sources: set[str] = field(default_factory=set)
    #: The step currently producing evidence. Set by a handler at entry; read by
    #: `add_evidence`, so call sites do not each have to remember to report.
    evidence_source: str = ""
    #: Human-readable route, e.g. ["Path A", "Loop×4", "MEDIUM"]. What the Runs
    #: table shows in its "Execution path" column.
    path: list[str] = field(default_factory=list)
    #: The branch a step is running INSIDE, right now. Separate from `path`, which
    #: is the cumulative route ("Branch B · Loop×2") and is never popped — using
    #: its last entry to label a step attributed everything after a loop TO that
    #: loop. This one is pushed and popped around a body, so it answers a different
    #: question: not "where has the run been" but "where is it".
    branch_stack: list[str] = field(default_factory=list)
    notices: list[Notice] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    #: Variables to persist for the next turn. Written only by nodes whose
    #: `run_policy` says so, never by everything that happens to set a variable.
    memory_set: dict[str, Any] = field(default_factory=dict)
    #: Nodes that DECLINED to do their work, keyed by node → why.
    #:
    #: A handler that returns normally is recorded `ok`, which is right for a node
    #: that did its job and wrong for one that was gated. A Web node on a link with
    #: web search off returns quietly — correct behaviour — and the trace then
    #: showed a green tick against a step that never reached the internet. Anyone
    #: auditing "did this flow go outside" read that tick as yes.
    #:
    #: Declared by the handler rather than inferred from its output, because
    #: inferring means guessing which shapes mean "skipped", and a guess in the
    #: trace is worse than no trace.
    skipped: dict[str, str] = field(default_factory=dict)
    #: A breakdown the question asked for that no tool call ever delivered.
    #:
    #: ``{"requested": "<field>", "satisfied": bool}``, written when the dimension
    #: gate refuses a grouped call and cleared when a grouped call succeeds on the
    #: dimension that was asked for. Measured: once the gate started refusing the
    #: category chart, two of three live runs stopped substituting a category —
    #: and then answered about monthly GMV instead, which is neither the answer
    #: nor an admission that the report cannot give it. The refusal fixed the
    #: wrong answer and left a wandering one, so the fact has to survive to the
    #: answer step where it can be said out loud.
    dimension_gap: dict[str, Any] = field(default_factory=dict)
    #: Every chart a successful call read (`chart_id` of its arguments), across
    #: every step — Agent tools, Tool steps and report reads all register their
    #: results through `record_evidence`. Lets the answer ask "did this run ever
    #: touch the breakdown the question named?" from facts, not prose.
    charts_read: set[int] = field(default_factory=set)
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
    #: Every tool call this run has made, in order, as `name` or `name(failed)`.
    #:
    #: `TraceStep.tool_calls` has been in the envelope since the first version and
    #: was never written to, so a run's history recorded that a step spent four
    #: tool calls without recording WHICH — and "which tools ran" is the only
    #: question an operator reviewing an agent's reach actually has. The executor
    #: slices this list per node, so every node type is covered by one append at
    #: each call site rather than by each handler remembering to report.
    tool_log: list[str] = field(default_factory=list)
    #: EVERY RESULT THE RUNTIME PRODUCED, under a stable reference (`e1`, `e2`, …
    #: in run order). The flat `evidence` list above answers "does this number
    #: appear somewhere"; it cannot answer "which result is this number" — with
    #: Revenue 2025 = 100 and Target = 100 in one run, value matching cannot tell
    #: them apart. A reference can. `compute` resolves its variables through this
    #: store, so the model names WHICH figure feeds a formula and the runtime
    #: reads the value itself; the model never supplies a trusted number.
    #:
    #: Holds the result objects the runtime produced — the same objects already
    #: held in the step's messages — plus which tool and step produced them.
    evidence_store: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Per Agent step: what it was granted, what was eligible, what it was shown
    #: each round, what it discovered, invoked and had refused. Stamped onto the
    #: step's TraceStep by `record`, so every recording site carries it.
    capability_trace: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: >0 while a coordinator lane's body runs.
    lane_depth: int = 0
    #: Per step, while it runs: the budget it started with and was made to leave
    #: for later steps. `record` turns it into the step's budget ledger.
    step_budget: dict[str, dict[str, Any]] = field(default_factory=dict)
    _evidence_recorded: set[str] = field(default_factory=set)

    def record_evidence(self, result: Any, *, tool: str = "", args: Any = None) -> str | None:
        """Register one capability result: give it a reference, then harvest it.

        Returns the reference; the caller shows it to the model next to the data
        it names. The result object is NOT modified: results are shared — the
        registry's cross-run cache stores the very object it returns, and a
        reference written into it would follow that figure into another run. A
        failed result gets no reference — there is nothing in it a formula could
        stand on.

        A result that declares ``provenance: "unreferenced"`` is stored and
        referenceable but NOT harvested into the trusted ledger: it is a figure
        computed from a number the model supplied, and certifying it would let an
        invented input vouch for itself.
        """
        if not isinstance(result, dict) or result.get("ok") is False:
            self.add_evidence(result)
            return None
        chart = args.get("chart_id") if isinstance(args, dict) else None
        if isinstance(chart, int) and not isinstance(chart, bool):
            self.charts_read.add(chart)
        if len(self.evidence_store) >= _MAX_EVIDENCE_REFS:
            self.add_evidence(result)
            return None
        ref = f"e{len(self.evidence_store) + 1}"
        # WHAT THE CALLER TYPED INTO THIS CALL. A tool that echoes an argument —
        # `search_business_assets` returns its query, `compare_to_target` its
        # caller-supplied target — would otherwise hand the model's own number
        # back as a result the ledger and `compute` trust (found by review:
        # query "13590000" became a certified figure). A number the model supplied
        # to a call cannot vouch for itself in that call's result.
        caller = caller_numbers(args)
        self.evidence_store[ref] = {
            "tool": tool,
            "source": self.evidence_source,
            "result": result,
            "caller_numbers": caller,
        }
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        # A RESULT MAY DECLARE WHICH NUMBERS IT VOUCHES FOR (`evidence_values`):
        # `compute` names only its certified result, never its literals or echoed
        # inputs; a Skill names nothing (its child's ledger is merged directly).
        # Everything else is harvested as it always was.
        if "evidence_values" in data or data.get("provenance") == "unreferenced":
            if self.evidence_source:
                self.evidence_sources.add(self.evidence_source)
            for v in data.get("evidence_values") or []:
                self.add_evidence(v, depth=1)
            return ref
        if "evidence_paths" in data:
            # A result that says which of its fields it vouches for is harvested
            # from those fields only (e.g. a projection against a caller target).
            if self.evidence_source:
                self.evidence_sources.add(self.evidence_source)
            for key in data.get("evidence_paths") or []:
                self.add_evidence(data.get(key), depth=1, exclude=caller)
            return ref
        self.add_evidence(result, exclude=caller)
        return ref

    def add_evidence(self, payload: Any, *, depth: int = 0, exclude: list[float] | None = None) -> None:
        """Harvest numbers from a tool result.

        Bounded on depth and count: a chart payload can be tens of thousands of
        cells, and the check is "did this figure come from somewhere", not a full
        index of the warehouse.
        """
        if depth == 0 and self.evidence_source:
            self.evidence_sources.add(self.evidence_source)
        if depth > 6 or len(self.evidence) > 20000:
            return
        if isinstance(payload, bool):
            return
        if isinstance(payload, (int, float)):
            if not _is_caller_number(float(payload), exclude):
                self.evidence.append(float(payload))
            return
        if isinstance(payload, str):
            n = _num(payload)
            if n is not None:
                if not _is_caller_number(n, exclude):
                    self.evidence.append(n)
            elif 1 < len(payload) <= 80 and len(self.evidence_labels) < 5000:
                self.evidence_labels.add(payload.strip().lower())
            return
        if isinstance(payload, dict):
            for k, v in payload.items():
                # AN IDENTIFIER IS NOT A MEASUREMENT.
                #
                # `_route_call` in the read handler already refuses to harvest a
                # chart listing for this reason — "chart 1001" must not vouch for
                # a claim of 1001. But the DATA tools echo the id back inside
                # their own result: `get_chart_data` returns
                # `_ok({"chart_id": ..., "columns": ..., "rows": ...})` and an
                # insight pack opens with `chart_id` plus a `related` list of
                # other charts' ids. Those go through `_call`, so the ids landed
                # in the ledger anyway and the invariant held only where nobody
                # had looked. Observed: a one-chart read put 41 and 88 in the
                # pile the figure checker matches against.
                #
                # Keyed on what the value IS, not on a list of field names that
                # happened to be numeric: these keys name a row in a table, and a
                # row number cannot support a statement about the world. Titles
                # and names are deliberately NOT here — they are labels, and
                # `_unknown_labels` needs them.
                if isinstance(v, (int, float)) and k in _IDENTIFIER_KEYS:
                    continue
                # A reference names a result; it is neither a figure nor a label.
                if k == "evidence_ref":
                    continue
                self.add_evidence(v, depth=depth + 1, exclude=exclude)
            return
        if isinstance(payload, (list, tuple)):
            for v in payload:
                self.add_evidence(v, depth=depth + 1, exclude=exclude)

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
        # `items[0].value` and `items.0.value` are the same path — the bracket
        # form is what a JSON reader writes and what the builder documents.
        dotted = (dotted or "").replace("[", ".").replace("]", "")
        parts = [p.strip() for p in dotted.split(".") if p.strip()]
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
            return render_value(self.get(m.group(1)))

        return _TEMPLATE_RE.sub(sub, text)

    # ── Trace ─────────────────────────────────────────────────────────────────
    def record(self, step: TraceStep) -> None:
        """Append a step, stamped with the branch it ran inside.

        `TraceStep.branch` was declared in the envelope, given a column in
        `agent_flow_run_steps`, returned by the run detail and rendered by the Runs
        tab — and set by nobody, so every step of every run reported no branch. The
        one place that knows is here: `self.path` is pushed with the case label
        immediately before its body runs, so the innermost entry IS the branch this
        step is executing under. Stamping it at the single recording point means a
        new node type cannot forget to.
        """
        if not step.branch and self.branch_stack:
            step.branch = self.branch_stack[-1]
        if step.capabilities is None and step.key in self.capability_trace:
            step.capabilities = self.capability_trace.pop(step.key)
        # WHICH EVIDENCE THIS STEP CREATED — the references a later formula or a
        # debugger can name. Children record before their container, so a lane's
        # evidence is on the lane's step, not repeated on the coordinator.
        made = [{"ref": ref, "tool": entry.get("tool") or ""}
                for ref, entry in self.evidence_store.items()
                if entry.get("source") == step.key and ref not in self._evidence_recorded]
        if made:
            self._evidence_recorded.update(m["ref"] for m in made)
            step.capabilities = {**(step.capabilities or {}), "evidence": made}
        if step.budget is None and step.key in self.step_budget:
            start = self.step_budget.pop(step.key)
            step.budget = {
                **{k: v for k, v in start.items() if not k.startswith("_")},
                "llm_calls": self.budget.llm_calls - int(start.get("_llm0", 0)),
                "tool_calls": self.budget.tool_calls - int(start.get("_tools0", 0)),
            }
        self.trace.append(step)

    def path_label(self) -> str:
        return " · ".join(self.path)

    @contextmanager
    def in_branch(self, label: str) -> Iterator[None]:
        """Run a body inside a named branch.

        Records the label on the cumulative route AND on the branch stack, then
        pops only the stack. Every node executed within the block is stamped with
        this label; anything after the block is not, which is the distinction the
        Runs tab needs to show which lane a step belonged to.
        """
        self.path.append(label)
        self.branch_stack.append(label)
        try:
            yield
        finally:
            self.branch_stack.pop()

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


def render_value(v: Any) -> str:
    """A step's value as text a prompt can carry. THE one definition.

    THREE COPIES OF THIS EXISTED AND ONE OF THEM CRASHED.
    Template substitution (here), the previous-step text handed to an Agent
    (`handlers/agent._previous_text`) and the `join_text` transform
    (`handlers/util`) each serialised dicts on their own. Two passed
    `default=str`; this one did not — and the values in question come from chart
    data, which is full of `date` and `Decimal`. So `{{rows}}` in a prompt raised
    `TypeError: Object of type date is not JSON serializable` on exactly the data
    the flow exists to talk about, while the other two rendered it fine.

    No logic was wrong anywhere. One copy simply never received a fix the others
    got — the same failure `_apply_scope` in `handlers/agent.py` records: "one
    builder, one set of keys, no room for the two to drift again".
    """
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        # A list reads as a list, not as JSON: `{{segments}}` in a sentence should
        # come out "Bắc, Trung, Nam". Elements go through this same function, so a
        # list OF dicts still survives a `date` inside one of them.
        return ", ".join(render_value(x) for x in v)
    if isinstance(v, dict):
        import json

        try:
            return json.dumps(v, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            # `default=str` covers all but the self-referential; a readable repr
            # beats failing the node that reads the variable.
            return str(v)
    return str(v)


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
