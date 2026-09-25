"""AgentRuntime — how an Agent step's decisions are EXECUTED and GOVERNED.

STRATEGY DECIDES. RUNTIME EXECUTES AND GOVERNS.
-----------------------------------------------
An Agent node is an autonomy zone: the author granted a goal and capabilities,
and inside that zone the model decides what to do. Two different things were
fused in one 480-line function (`handlers/agent.py:run`):

  * how the Agent REASONS — what context it is shown, when it asks for a tool,
    how a result is fed back, when it stops — which is a policy that can have
    more than one shape (tool calling today; a planner or supervisor later);
  * the RULES that hold whatever the reasoning is — the provider call and its
    deadline, the run budget, the node's tool ceiling, the retry policy for
    refusals that cannot change, the dead-retry breaker, scope, evidence,
    citations, the reader's status line.

This module is the second half. A strategy (`runtime/strategies/`) drives the
loop and holds the conversation; it never imports a provider adapter and never
calls the tool registry — it asks this object. So a second strategy inherits
every rule here instead of re-implementing retry, budget and telemetry, which is
exactly the failure V3 exists to prevent (docs/agent-flow-v3-target-architecture.md
§3.3).

Every hard gate still lives where it lived: `registry.execute()` and the tool
bodies (V3 invariant 11). This object calls them; it does not replace them.

Behaviour is MOVED here unchanged from `handlers/agent.py` — the canonical
replay fixtures are the acceptance test for that.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Callable

from app.services.agent_flows.contract import AgentNode
from app.services.agent_flows.runtime.state import (
    BudgetExhausted,
    RunState,
    StepBudgetExhausted,
)
from app.services.agent_flows.tools import registry as tool_registry
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)


# ═══ Retry policy for refusals that cannot change ════════════════════════════

#: Refusals that describe the REQUEST rather than the moment. Asking again with
#: the same arguments cannot change any of these answers: the chart is still out
#: of scope, the tool is still ungranted, the argument is still the wrong type.
#:
#: Measured before this existed: a grant with no discovery tool produced
#: `rank_values(chart_out_of_scope)` six times in a row until the model-call
#: budget was gone, on two of three questions. The refusal was correct every
#: time; repeating it was what cost the answer.
_FINAL_ERROR_CODES = frozenset({
    "chart_out_of_scope", "not_granted", "bad_argument", "bad_tool_arguments",
    "not_applicable", "no_data", "doc_out_of_scope", "unsupported_dimension",
})

#: How many ignored recoveries a node tolerates before it stops offering tools.
#:
#: Two, because the measured failure was six identical calls and one explanation
#: can plausibly be missed in a batch the model had already committed to. Two
#: cannot: by then the model has seen the reason, named, twice.
_MAX_IGNORED_RECOVERIES = 2


def _is_final_refusal(result: dict) -> bool:
    """Is this a refusal that a second identical call cannot change?

    `retryable` comes first because the TOOL knows: `result.err()` has carried
    that flag since the error taxonomy landed, and a tool that marks a scope
    error retryable means it. The code list is the fallback for results that do
    not set it.
    """
    if not isinstance(result, dict) or result.get("ok") is not False:
        return False
    if "retryable" in result:
        return not bool(result["retryable"])
    return str(result.get("error_code") or "") in _FINAL_ERROR_CODES


def _retry_key(tool_name: str, args: Any) -> str:
    """Identity of a REQUEST, not of a call.

    Sorted, so re-ordering the same arguments is the same request; serialised
    with `default=str`, so an unserialisable argument degrades to a stable-enough
    string instead of raising inside the loop.
    """
    import json as _j

    try:
        body = _j.dumps(args or {}, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:                                           # noqa: BLE001
        body = str(args)
    return f"{tool_name}::{body}"


def _already_refused(tool_name: str, previous: str) -> dict:
    return {
        "ok": False,
        "error_code": "already_refused",
        "error": (
            f"công cụ '{tool_name}' đã bị từ chối với đúng tham số này "
            f"({previous}) — gọi lại y hệt sẽ cho cùng kết quả. Hãy đổi tham "
            "số, dùng công cụ khác, hoặc trả lời bằng những gì đã có và nói "
            "rõ phần không lấy được."
        ),
        "retryable": False,
    }


def _call_with_retry_policy(tool_name: str, args: Any, seen: dict, execute) -> dict:
    """Run the tool unless this exact request has already been finally refused.

    Returns the tool's own result, or — for a repeat — a refusal that NAMES the
    original reason. Handing back the same error a second time would tell the
    model "no" without telling it what to change, which is how the loop got
    stuck in the first place; `recovery` is what makes the next call different.
    """
    key = _retry_key(tool_name, args)
    previous = seen.get(key)
    if previous:
        return _already_refused(tool_name, previous)
    result = execute(tool_name, args)
    if _is_final_refusal(result):
        seen[key] = str(result.get("error_code") or "refused")
    return result


# ═══ Structured facts harvested from results ═════════════════════════════════

def _note_dimension_outcome(state: RunState, result: Any) -> None:
    """Record whether the requested breakdown was refused, and later delivered.

    Two structured facts, no prose: the gate's refusal names the dimension the
    question asked for, and every grouped tool result states the dimension it
    grouped by. A gap opens on the first refusal and closes only when a result
    arrives grouped by that same field.
    """
    from app.services.agent_flows.tools.dimension_gate import field_key

    if not isinstance(result, dict):
        return
    if result.get("error_code") == "dimension_mismatch":
        detail = result.get("detail") or {}
        wanted = str(detail.get("requested_dimension") or "")
        if wanted and not state.dimension_gap:
            state.dimension_gap = {
                "requested": wanted,
                "label": str(detail.get("requested_label") or ""),
                "satisfied": False,
            }
        return
    if result.get("ok") is not True or not state.dimension_gap:
        return
    from app.services.agent_flows.runtime.grain import per_member_dimensions

    # PER-MEMBER, BY THE RESULT'S OWN STRUCTURE: a declared `dimension`, a
    # summary's `primary_dimension`, or ROWS whose labels are that breakdown.
    # Found by review: refused on the category chart, the model did what the
    # refusal said — read the state chart's rows — and the gap stayed open,
    # because rows declare no `dimension`; the correct answer was marked partial.
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    if field_key(str(state.dimension_gap.get("requested") or "")) in per_member_dimensions(data):
        state.dimension_gap["satisfied"] = True


def _collect_citation(state: RunState, tool: str, args: dict, result: Any) -> None:
    """Record what the answer was actually built from.

    Derived from the TOOL CALLS, not from what the model says it used: a citation
    the model wrote is a claim, a citation from the tool log is evidence.
    """
    from app.services.agent_flows.envelope import Citation

    if not isinstance(result, dict) or result.get("ok") is False:
        return

    # THE PAYLOAD IS UNDER `data`.
    #
    # `tools.result.normalise` wraps every tool body as `{ok, kind, data}`, so
    # `result.get("citations")` is None and `result.get("name")` is None — this
    # read the ENVELOPE and the facts live one level down. Every knowledge search
    # therefore contributed nothing to the answer's citation list, and every chart
    # citation was labelled with an empty string, in production, while a unit test
    # passed because it handed this function the inner payload directly.
    #
    # Found by driving the Test panel in a browser and seeing no source cards under
    # an answer whose trace showed three `search_knowledge` calls.
    payload = result.get("data") if isinstance(result.get("data"), dict) else result

    chart_id = args.get("chart_id") if isinstance(args, dict) else None
    if chart_id and not any(c.ref == str(chart_id) for c in state.citations):
        state.citations.append(
            Citation(kind="chart", ref=str(chart_id), label=str(payload.get("name") or ""))
        )
    doc_id = args.get("document_id") if isinstance(args, dict) else None
    if doc_id and not any(c.ref == str(doc_id) for c in state.citations):
        state.citations.append(Citation(kind="document", ref=str(doc_id)))

    # THE PASSAGES A KNOWLEDGE SEARCH ACTUALLY RETURNED.
    #
    # Only `chart_id` and `document_id` were read above, both from the tool's
    # ARGUMENTS — so a `search_knowledge` call, which names no document in its
    # arguments and returns eight numbered sources in its result, contributed
    # nothing. An agent could search the knowledge base, quote a policy, and hand
    # the viewer an answer whose citation list was empty.
    #
    # `ref` is "doc:block" rather than the document id alone: two passages from
    # different sections of the same document are two different citations, and
    # collapsing them loses the only part a reader needs — which part.
    for source in (payload.get("citations") or [])[:12]:
        if not isinstance(source, dict):
            continue
        ref = "%s:%s" % (source.get("doc_id"), source.get("block"))
        if any(c.ref == ref for c in state.citations):
            continue
        state.citations.append(Citation(
            kind="document",
            ref=ref,
            label=_source_label(source),
            # The number the model was told to cite. Without it a `[3]` in the
            # answer cannot be resolved back to the passage it names.
            used=[str(source.get("n"))] if source.get("n") else [],
            # What makes the citation re-openable at the version it was made
            # against, months later, with a check that the text is still the same.
            version=source.get("source_version"),
            block_to=source.get("block_to"),
            fingerprint=str(source.get("content_fingerprint") or ""),
        ))


def _source_label(source: dict) -> str:
    """A passage named the way a person would name it: document, section, page."""
    title = str(source.get("title") or "").strip()
    path = [p.strip() for p in str(source.get("heading_path") or "").split(">") if p.strip()]
    if path and title and path[0].lower() == title.lower():
        path = path[1:]
    parts = [title, " > ".join(path)]
    if source.get("page"):
        parts.append("trang %s" % source["page"])
    return " › ".join(p for p in parts if p)


# ═══ Model and scope resolution ══════════════════════════════════════════════

def _resolve_model(node: AgentNode, rctx: Any) -> tuple[str, str]:
    """The node's provider/model, or the link's when it inherits.

    Delegates rather than deciding: the preflight guard needs the same answer to
    cost the flow, and when it had its own copy it read only the link's model — so
    a flow pinning a reasoning model on a fast link was costed at a quarter of what
    it takes. One rule, both readers.
    """
    from app.services.agent_flows.models_catalogue import effective_model

    return effective_model(
        node.provider, node.model,
        rctx.inp.runtime.provider, rctx.inp.runtime.model,
    )


def _apply_scope(ctx: Any, node: AgentNode) -> None:
    """This node's knowledge boundary, built by the SAME code the Knowledge node
    uses.

    Two copies of this existed and they disagreed: the copy here never collected
    `term_fqns`, so a glossary term attached to an Agent step was accepted by the
    builder, shown in the step's source list, and then dropped before retrieval —
    the picker worked and the boundary it configured did not. One builder, one
    set of keys, no room for the two to drift again.
    """
    from app.services.agent_flows.runtime.handlers.data import (
        bounded_scope,
        build_knowledge_scope,
    )

    if hasattr(ctx, "knowledge_scope"):
        ctx.knowledge_scope = bounded_scope(ctx, build_knowledge_scope(node.knowledge))


# ═══ The runtime ═════════════════════════════════════════════════════════════

@dataclass
class ModelReply:
    """What one model round produced, as the runtime observed it."""

    text: str = ""
    tool_calls: list[AgentEvent] = field(default_factory=list)
    #: The round hit the run's deadline. The provider error is already recorded.
    timed_out: bool = False


def _skill_capabilities(node: AgentNode, rctx: Any) -> tuple[list, dict[str, str]]:
    """The Skills this step was granted, as capabilities — or why each is not one.

    A Skill that cannot be resolved at its pinned version, or that is already on
    this run's Skill call stack, is EXCLUDED with its reason rather than offered:
    it would only be refused.
    """
    from types import SimpleNamespace

    from app.services.agent_flows import skills
    from app.services.agent_flows.contract import skill_function_name, skill_key_of_grant
    from app.services.agent_flows.runtime.capabilities import ExtraCapability

    extras: list = []
    excluded: dict[str, str] = {}
    stack = tuple(getattr(rctx, "skill_stack", ()) or ())
    for grant in node.tools:
        key = skill_key_of_grant(grant.tool)
        if not key:
            continue
        name = skill_function_name(key)
        found = skills.resolve_skill(getattr(rctx, "db", None), key, grant.version)
        if found is None:
            excluded[name] = "skill_not_found"
            continue
        row, flow = found
        if key == rctx.flow.key or any(k == key for k, _ in stack):
            excluded[name] = "skill_cycle"
            continue
        # NOT SHOWN what would only be refused — disabled, or no longer shared.
        # Visibility only: `invoke_skill` re-checks both, whatever is shown.
        refused = skills.invocation_refusal(getattr(rctx, "db", None), rctx, row, key)
        if refused is not None:
            excluded[name] = str(refused.get("error_code") or "refused")
            continue
        label = row.name or key
        definition = skills.capability_definition(key, label, flow.skill)
        extras.append(ExtraCapability(
            name=name, definition=definition, label=label, does=flow.skill.when_to_use,
            search=SimpleNamespace(
                name=name, label_vi=label, label_en=label,
                description_vi=f"{flow.skill.when_to_use} {flow.skill.output}",
                answers_vi=(), returns={}, definition=definition,
            ),
        ))
    return extras, excluded


def build_step_view(node: AgentNode, rctx: Any, *, web_enabled: bool,
                    extras: list | None = None, excluded_extras: dict | None = None):
    """The capability view for one Agent step — ONE builder, for the run and for
    "What the AI sees", so the preview cannot describe a view the run never builds.

    Ranked on the viewer's QUESTION, with the node prompt as a bounded tilt and the
    author's per-grant notes as part of each capability's own description."""
    from app.services.agent_flows.contract import skill_function_name, skill_key_of_grant
    from app.services.agent_flows.runtime.capabilities import build_view

    notes: dict[str, str] = {}
    for grant in node.tools:
        note = (grant.note or "").strip()
        if not note:
            continue
        key = skill_key_of_grant(grant.tool)
        notes[skill_function_name(key) if key else grant.tool] = note
    try:
        question = rctx.inp.question.text()
    except Exception:                                           # noqa: BLE001
        question = ""
    return build_view(
        node.tool_names(), rctx.ctx, web_enabled=web_enabled,
        limit=getattr(node, "visible_capabilities", None),
        extras=extras, excluded_extras=excluded_extras, notes=notes,
        question=question, context=node.prompt or "",
    )


class AgentRuntime:
    """Executes one Agent step's requests and enforces every rule around them.

    Owns: provider invocation and its deadline, usage accounting, provider-error
    capture, the node and run tool budgets, the retry policy and dead-retry
    breaker, the capability grant passed to the registry, the node's knowledge
    scope, evidence and citation harvesting, and the reader's status line.

    It does NOT own the conversation — that is the strategy's — and it holds no
    opinion about when to stop reasoning, only about what is still allowed.
    """

    def __init__(
        self,
        node: AgentNode,
        state: RunState,
        rctx: Any,
        *,
        stream: Callable[..., AsyncGenerator[AgentEvent, None]],
        status_label: Callable[[str], str],
    ) -> None:
        self.node = node
        self.state = state
        self.rctx = rctx
        self._stream = stream
        self._status_label = status_label
        self.provider, self.model = _resolve_model(node, rctx)
        self.api_key = node.resolved_api_key() or rctx.api_key
        if not self.api_key:
            # An error event rather than a raise: the chain continues, and a later
            # node with its own token can still produce an answer.
            raise RuntimeError(f"chưa có token để gọi {self.provider or 'nhà cung cấp'}")
        self.is_answering = node.key == rctx.answer_key
        #: The author's grant for this step. `registry.execute()` refuses anything
        #: outside it, whatever the model names.
        self.allowed = set(node.tool_names())
        self.web_enabled = bool(rctx.inp.binding.capabilities.web_search)
        #: WHAT THE MODEL MAY BE SHOWN (capability routing). Visibility only:
        #: `registry.execute()` still decides what may run.
        extras, excluded_extras = _skill_capabilities(node, rctx)
        self.view = build_step_view(node, rctx, web_enabled=self.web_enabled,
                                    extras=extras, excluded_extras=excluded_extras)
        #: The tool schemas the model is offered this round. A step whose grant
        #: fits within the limit is offered exactly what it always was — plus the
        #: Skills it was granted, which did not exist before.
        self.schemas: list[dict] = tool_registry.definitions_for(
            self.allowed, web_enabled=self.web_enabled) + [e.definition for e in extras]
        self._withdrawn = False
        #: Tool calls this step has made (the node ceiling reads it).
        self.calls_made = 0
        #: Requests this step has already had finally refused, so it does not spend
        #: a second call discovering the same 'no'. Per STEP, not per run: a later
        #: step may legitimately have different grants.
        self.final_refusals: dict[str, str] = {}
        #: How many times this node has handed back `already_refused` — that is,
        #: how many times it explained a dead request and the model asked for it
        #: anyway.
        self.ignored_recoveries = 0
        #: Provider adapters report a refused key or a bad model as an `error` EVENT
        #: rather than an exception. Without capturing it the node finished with
        #: empty text and was recorded `ok` — so the trace said every step succeeded
        #: while the answer was blank, which is the single most misleading thing a
        #: run log can do.
        self.provider_error = ""
        self.last_reply = ModelReply()
        #: None until the first round is asked (nothing to compare against yet).
        self.offered_names: set[str] | None = None
        self.last_result: dict = {}
        self._previous_scope: Any = None
        #: Rounds this step was made to answer on (no tools offered) — recorded so
        #: a trace can say "it answered because its budget said so".
        self.final_rounds = 0

    # ── scope ────────────────────────────────────────────────────────────────
    def enter(self) -> None:
        """Apply this node's knowledge scope and the previous turn's question.

        ATTACHING NARROWS; ATTACHING NOTHING DOES NOT MEAN NOTHING. A step that
        names its sources reaches only those. A step that names none is not sealed
        off — it reaches everything the REPORT is entitled to, which is what the
        binding's `knowledge.mode` grants. The entitlement is still the ceiling
        either way; the author's list only ever cuts inside it.
        """
        ctx = self.rctx.ctx
        self._previous_scope = getattr(ctx, "knowledge_scope", None)
        _apply_scope(ctx, self.node)
        # The previous turn's question, for any tool this node calls that
        # retrieves. Set here because this is already where the node's retrieval
        # boundary is applied, and the two belong to the same question.
        if hasattr(ctx, "prior_question"):
            from app.services.dashboard_ai_bot.govern_doc_followup import (
                prior_user_question,
            )

            ctx.prior_question = prior_user_question(self.rctx.inp.conversation.history)

    def exit(self) -> None:
        """Restored even when the node raises, or the next node would inherit a
        scope it was never granted — a silent widening of what the flow may read.

        Also leaves this step's capability view for the trace, whatever happened:
        "what could it see, what did it try" matters most on a step that failed.
        """
        if self._previous_scope is not None:
            self.rctx.ctx.knowledge_scope = self._previous_scope
        self.state.capability_trace[self.node.key] = {
            **self.view.to_trace(), "final_rounds": self.final_rounds,
        }

    # ── corrections ──────────────────────────────────────────────────────────
    async def correct(self, system: str, messages: list[dict]) -> str:
        """One OPTIONAL model call with no tools — a verifier's correction round.

        Through the runtime like every other call: the same deadline, the same
        usage accounting, and the budget's `try_spend_llm`, so a correction spends
        only what this step may spend and never a later step's reservation. Not
        making it is not a failure: the first answer stands.
        """
        state = self.state
        if not state.budget.try_spend_llm():
            return ""
        remaining = max(5.0, state.budget.max_seconds - state.budget.elapsed())
        out = ""
        try:
            async with asyncio.timeout(remaining):
                async for ev in self._stream(
                    provider=self.provider, api_key=self.api_key, model=self.model,
                    system_prompt=system, messages=messages, tools=[],
                ):
                    if ev.type == "text":
                        out += ev.text
                    elif ev.type == "usage":
                        state.prompt_tokens += int(ev.extra.get("prompt_tokens") or 0)
                        state.completion_tokens += int(ev.extra.get("completion_tokens") or 0)
        except Exception:  # noqa: BLE001 — a failed correction keeps the first answer
            logger.warning("[flow] correction round failed", exc_info=True)
            return ""
        return out.strip()

    # ── the model ────────────────────────────────────────────────────────────
    # ── the budget, as the strategy needs to know it ─────────────────────────
    def can_ask(self) -> bool:
        """May this step make another model call at all?"""
        return self.state.budget.llm_available() > 0

    def next_round_is_final(self, *, last: bool = False) -> bool:
        """Will the next round be offered no tools? True when it is the last call
        this step may make — the budget's (`llm_available() == 1`) or the
        strategy's own round ceiling (`last`)."""
        return bool(self.schemas) and (last or self.state.budget.llm_available() <= 1)

    async def ask(
        self, system: str, messages: list[dict], *, stream_text: bool, last: bool = False,
    ) -> AsyncGenerator[AgentEvent, None]:
        """One model round. Yields the events a reader may see; the round's text
        and tool calls are left on `last_reply`.

        `stream_text` is the strategy's choice of whether this round's prose is
        the reader's answer as it is written; `last` says the strategy will not
        ask again after this round.

        A STEP ALWAYS ENDS BY SPEAKING. The last call a step may make — by the
        budget (what is left after the reservation for later steps) or by `last`
        — is offered no tools: a tool asked for on the last call is a result
        nobody will read, and it is exactly how a run with its evidence in hand
        used to end "đã dùng hết số lượt gọi mô hình". A step with no call left
        at all raises: `BudgetExhausted` when the run itself is spent,
        `StepBudgetExhausted` when what is left belongs to later steps.
        """
        state = self.state
        budget = state.budget
        available = budget.llm_available()
        if available <= 0:
            left = budget.max_llm_calls - budget.llm_calls
            if left <= 0:
                raise BudgetExhausted("đã dùng hết số lượt gọi mô hình cho câu hỏi này")
            raise StepBudgetExhausted(
                f"bước này không còn lượt gọi mô hình để dùng: {left} lượt còn lại được "
                "giữ cho các bước bắt buộc phía sau"
            )
        final = last or available == 1
        budget.spend_llm()
        reply = ModelReply()
        self.last_reply = reply
        # THE VIEW FOR THIS ROUND. Shortlisted: the model is shown the core, what
        # it discovered or used, and the best-ranked for the question. Otherwise
        # the schemas are untouched and the round is only recorded.
        if self._withdrawn or (final and self.schemas):
            # Nothing is offered on this round, so nothing is shown, sized or
            # recorded as shown.
            self.view.rounds.append([])
            self.view.rounds_chars.append(0)
            if not self._withdrawn:
                self.final_rounds += 1
        else:
            self.view.refresh()
            if self.view.shortlisted:
                self.schemas = self.view.schemas(web_enabled=self.web_enabled)
        offered = [] if (final or self._withdrawn) else self.schemas
        #: This round was DELIBERATELY answer-only: the step has tools, and this
        #: round offers none (its last call, or tools withdrawn). Distinct from a
        #: step that never had an eligible tool — there a call must still reach
        #: the registry, so its refusal (`not_granted`, the I5 tripwire) fires.
        self.answer_only_round = bool(self._withdrawn or (final and self.schemas))
        #: What the model could call THIS round — `invoke` refuses anything else,
        #: so a call a model produces on an answer-only round (or on a name it
        #: remembers) does not run.
        self.offered_names = {str(d.get("name") or (d.get("function") or {}).get("name") or "")
                              for d in offered}

        # THE RUN BUDGET HAS TO BIND DURING A CALL, NOT ONLY BETWEEN NODES.
        #
        # `max_seconds` was checked between nodes, so a single slow call could
        # ignore it entirely: on a reasoning model this flow took 91s against a
        # 45s budget and every client gave up before the answer arrived. The
        # remaining budget is the ceiling for THIS round.
        remaining = max(5.0, state.budget.max_seconds - state.budget.elapsed())
        try:
            async with asyncio.timeout(remaining):
                async for ev in self._stream(
                    provider=self.provider, api_key=self.api_key, model=self.model,
                    system_prompt=system, messages=messages, tools=offered,
                ):
                    if ev.type == "tool_call":
                        reply.tool_calls.append(ev)
                        continue
                    if ev.type == "text":
                        reply.text += ev.text
                        if stream_text:
                            yield ev
                        continue
                    if ev.type == "usage":
                        state.prompt_tokens += int(ev.extra.get("prompt_tokens") or 0)
                        state.completion_tokens += int(
                            ev.extra.get("completion_tokens") or 0
                        )
                    if ev.type == "error":
                        self.provider_error = ev.text or "nhà cung cấp trả về lỗi"
                        continue
                    yield ev
        except TimeoutError:
            # Named, not swallowed. "The model took longer than this link allows"
            # is a different problem from "the model refused", and an operator
            # reading the Runs table has to be able to tell them apart.
            self.provider_error = (
                f"{self.model or self.provider} không trả lời kịp trong "
                f"{int(remaining)} giây còn lại của lượt này."
            )
            reply.timed_out = True

    # ── the budget ───────────────────────────────────────────────────────────
    def tool_room(self) -> int:
        """HOW MANY tool calls may still run in this step.

        The node ceiling used to be tested once per ROUND, then the whole batch
        ran. A model that asks for five tools in parallel with one call of
        headroom left made five — the limit held on paper and was exceeded in
        fact. The run-wide budget is checked here too, so the answer step is
        refused a tool rather than killed by one.
        """
        return max(0, min(
            self.node.max_tool_calls - self.calls_made,
            self.state.budget.tools_left(answering=self.is_answering),
        ))

    @staticmethod
    def budget_exhausted() -> dict:
        """The result owed to a call announced past the ceiling."""
        return {
            "ok": False,
            "error_code": "budget_exhausted",
            "error": "không còn lượt gọi công cụ cho bước này — hãy "
                     "trả lời bằng dữ liệu đã có và nói rõ phần chưa kiểm được",
        }

    def withdraw_tools(self) -> None:
        """No further tool calls are offered to the model in this step."""
        self.schemas = []
        self._withdrawn = True

    @property
    def tools_offered(self) -> bool:
        return bool(self.schemas)

    @property
    def recoveries_ignored(self) -> bool:
        """Has the model repeated a dead request often enough that tools should
        come off the table? Counted per NODE and only for repeats, so a corrected
        call still gets through."""
        return self.ignored_recoveries >= _MAX_IGNORED_RECOVERIES

    # ── executing a capability ───────────────────────────────────────────────
    def _execute(self, name: str, args: Any) -> dict:
        # BUDGET IS SPENT WHERE THE WORK HAPPENS, NOT WHERE IT IS ANNOUNCED.
        #
        # The retry policy stopped the second identical call from reaching the
        # registry, and the accounting stayed where it was — two lines above the
        # guard — so a request the runtime had already refused still cost a tool
        # call. Spending inside the executor makes the two inseparable: a call
        # that does not reach `tool_registry.execute` does not reach the budget.
        # Never past the ceiling, whatever the strategy counted: a call with no
        # room is answered, not raised — a raise here ends the whole run.
        if self.tool_room() <= 0:
            return self.budget_exhausted()
        self.state.budget.spend_tool()
        self.calls_made += 1
        return tool_registry.execute(self.rctx.ctx, name, args, allowed=self.allowed)

    async def _invoke_skill(self, skill_key: str, call: AgentEvent) -> AsyncGenerator[AgentEvent, None]:
        """A Skill the model asked for — through the ONE invocation path.

        The grant is checked here (a Skill is not a registry tool, so
        `registry.execute` cannot check it); everything else — version, ancestry,
        authority, budget, child run — is `skills.invoke_skill`'s.
        """
        from app.services.agent_flows import skills
        from app.services.agent_flows.contract import SKILL_GRANT_PREFIX

        grant = next((t for t in self.node.tools
                      if t.tool == f"{SKILL_GRANT_PREFIX}{skill_key}"), None)
        if grant is None:
            self.last_result = {
                "ok": False, "error_code": "not_granted", "retryable": False,
                "error": f"Skill '{skill_key}' không được cấp cho bước này",
            }
            return
        # THE SAME RETRY POLICY AS A TOOL. Found by review: a Skill refused for
        # budget stayed offered, the model asked again, and the identical refusal
        # was charged a second time — while the budget can only shrink. A final
        # refusal, asked again with the same inputs, is answered from memory:
        # nothing runs and nothing is charged.
        key = _retry_key(call.tool_name, call.tool_args)
        previous = self.final_refusals.get(key)
        if previous:
            self.ignored_recoveries += 1
            self.last_result = _already_refused(call.tool_name, previous)
            return
        # One call, like any capability: the node ceiling and the run budget see
        # it. What the Skill does inside is charged to the same budget by the child.
        if self.tool_room() <= 0:
            self.last_result = self.budget_exhausted()
            return
        self.state.budget.spend_tool()
        self.calls_made += 1
        outcome: dict = {}
        async for ev in skills.invoke_skill(
            self.state, self.rctx,
            skill_key=skill_key, version=grant.version, inputs=dict(call.tool_args or {}),
            invoked_as="coordinator_lane" if self.state.lane_depth else "agent_capability",
            parent_step_key=self.node.key, outcome=outcome,
        ):
            yield ev
        self.last_result = outcome.get("result") or {
            "ok": False, "error_code": "skill_failed", "error": "Skill không chạy", "retryable": False}
        # A Skill that FAILED inside (`skill_failed`: its child run did not come
        # back — a provider 503 is enough) may well work on the next call, so it
        # is never memoised. Found by review. Every other Skill refusal —
        # budget, bad input, not found, disabled — describes the request, and
        # asking again cannot change it.
        if _is_final_refusal(self.last_result) and self.last_result.get("error_code") != "skill_failed":
            self.final_refusals[key] = str(self.last_result.get("error_code") or "refused")

    def _shown(self, result: dict, ref: str | None) -> dict:
        """The copy of a result the MODEL reads. Carries its `evidence_ref` only
        when this step can use one (it holds `compute`) — every other step's
        prompt stays exactly what it was before references existed."""
        if ref and "compute" in self.allowed:
            return {**result, "evidence_ref": ref}
        return result

    def _after(self, call: AgentEvent, result: dict) -> None:
        """Bookkeeping every executed capability shares: view, log, evidence."""
        if result.get("ok"):
            self.view.note_invoked(call.tool_name)
        else:
            self.view.note_rejected(call.tool_name, str(result.get("error_code") or "failed"))
            self.state.tool_log.append(f"{call.tool_name}({result.get('error_code') or 'failed'})")
        self.state.evidence_source = self.node.key
        ref = self.state.record_evidence(result, tool=call.tool_name, args=call.tool_args)
        self.last_result = self._shown(result, ref)

    async def invoke(self, call: AgentEvent) -> AsyncGenerator[AgentEvent, None]:
        """Run one requested call under every rule. Yields the reader's status
        line and the tool_result event; the result is left on `last_result`."""
        state = self.state
        # The reader sees this line. `tool_name` is an internal id (`rank_values`);
        # the registry label is the product's own word for the same thing. The id
        # stays in the trace below.
        yield AgentEvent(
            type="status",
            text=f"Đang dùng {self._status_label(call.tool_name)}…",
        )
        # ARGUMENTS THE PROVIDER COULD NOT PARSE ARE NOT ARGUMENTS.
        #
        # They used to arrive as `{}` and the call went ahead, so the tool failed
        # on a missing required field and the model had to guess at a fault the
        # runtime had already identified. Handing back the parse error instead
        # lets it correct the call on the next round.
        from app.services.agent_flows.runtime.capabilities import FIND_CAPABILITY

        view = self.view
        malformed = (call.extra or {}).get("malformed_args")
        from app.services.agent_flows.contract import skill_key_of_function

        skill_key = skill_key_of_function(call.tool_name or "")
        if getattr(self, "answer_only_round", False):
            # NOTHING WAS OFFERED THIS ROUND — an answer-only round (the budget's
            # last call, the round ceiling, or tools withdrawn). A call the model
            # produced anyway does not run — not a tool, not a Skill, not even
            # discovery. Found by review: it passed `is_visible` and executed.
            result = {"ok": False, "error_code": "tools_withdrawn", "retryable": False,
                      "error": "Lượt này không có công cụ — hãy trả lời bằng những gì đã có."}
            view.note_rejected(call.tool_name, "tools_withdrawn")
            state.tool_log.append(f"{call.tool_name}(tools_withdrawn)")
            self.last_result = result
            yield AgentEvent(type="tool_result", tool_call_id=call.tool_call_id,
                             tool_name=call.tool_name, tool_result=result)
            return
        if view.shortlisted and call.tool_name == FIND_CAPABILITY and not malformed:
            # DISCOVERY. Answered by the view, not the registry: it reads no data
            # and it can only load what this step is already eligible for.
            # Charged like any call and capped per step (`MAX_DISCOVERIES`), so a
            # model can neither search for free nor search forever.
            args = call.tool_args or {}
            need = str(args.get("need") or args.get("query") or "")
            names = args.get("names") if isinstance(args.get("names"), list) else []
            result = view.discover(need, names) if self.tool_room() > 0 else self.budget_exhausted()
            if result.get("ok"):
                state.budget.spend_tool()
                self.calls_made += 1
                view.note_invoked(FIND_CAPABILITY)
                state.tool_log.append(FIND_CAPABILITY)
            else:
                view.note_rejected(FIND_CAPABILITY, str(result.get("error_code")))
                state.tool_log.append(f"{FIND_CAPABILITY}({result.get('error_code')})")
            self.last_result = result
            yield AgentEvent(
                type="tool_result",
                tool_call_id=call.tool_call_id,
                tool_name=call.tool_name,
                tool_result=result,
            )
            return
        if view.shortlisted and not malformed and call.tool_name in view.eligible \
                and call.tool_name not in (self.offered_names or ()):
            # GRANTED, BUT NOT SHOWN THIS TURN. Not run from memory: the model has
            # not seen the schema it is filling in. It IS eligible, so it is loaded
            # for the next round — the correction costs no search. Not charged
            # (nothing ran), and not memoised as a final refusal, because on the
            # next round the same call is legitimate.
            loaded = view.load_on_refusal(call.tool_name)
            result = {
                "ok": False,
                "error_code": "capability_not_visible",
                "error": (
                    f"'{call.tool_name}' chưa có định nghĩa đầy đủ ở lượt này nên chưa "
                    "chạy. Định nghĩa của nó đã được nạp — gọi lại ở lượt tiếp theo với "
                    "tham số đúng theo định nghĩa."
                    if loaded else
                    f"'{call.tool_name}' chưa có định nghĩa ở lượt này và bước đã tự nạp đủ "
                    f"số khả năng cho phép — dùng {FIND_CAPABILITY} để nạp đúng thứ cần."
                ),
                "retryable": True,
            }
            view.note_rejected(call.tool_name, "capability_not_visible")
            state.tool_log.append(f"{call.tool_name}(capability_not_visible)")
            self.last_result = result
            yield AgentEvent(
                type="tool_result",
                tool_call_id=call.tool_call_id,
                tool_name=call.tool_name,
                tool_result=result,
            )
            return
        if skill_key and not malformed:
            result = None
            async for ev in self._invoke_skill(skill_key, call):
                yield ev
            result = self.last_result
            self._after(call, result)
            yield AgentEvent(
                type="tool_result",
                tool_call_id=call.tool_call_id,
                tool_name=call.tool_name,
                tool_result=result,
            )
            return
        if malformed:
            # Still charged: this IS a new attempt by the model, just a broken
            # one. Only a request the runtime has already answered is free.
            state.budget.spend_tool()
            self.calls_made += 1
            result = {
                "ok": False,
                "error_code": "bad_tool_arguments",
                "error": f"tham số gửi kèm không phải JSON hợp lệ ({malformed}). "
                         "Hãy gọi lại công cụ với JSON đúng định dạng.",
            }
        else:
            # THROUGH THE RETRY POLICY, not straight to the registry. A refusal
            # that describes the request — out of scope, not granted, wrong
            # argument type — cannot change by being asked again, and asking again
            # is what burned six of this step's model calls on one guessed chart id.
            result = _call_with_retry_policy(
                call.tool_name, call.tool_args, self.final_refusals, self._execute,
            )
            if result.get("error_code") == "already_refused":
                self.ignored_recoveries += 1
        # DID THE BREAKDOWN THE QUESTION ASKED FOR EVER ARRIVE?
        _note_dimension_outcome(state, result)
        # Named in the run history, success or not. A refused call is the most
        # interesting row in an audit and the easiest one to lose.
        state.tool_log.append(
            call.tool_name if result.get("ok")
            else f"{call.tool_name}({result.get('error_code') or 'failed'})"
        )
        # An agent's OWN tool calls are its own capability answering — named so a
        # grounding rule can tell them from a read step whose question never
        # resolved.
        state.evidence_source = self.node.key
        # Registered with a reference the model is shown, so a formula can name
        # which result feeds it rather than copying a number out of it.
        if result.get("ok"):
            view.note_invoked(call.tool_name)
        else:
            view.note_rejected(call.tool_name, str(result.get("error_code") or "failed"))
        ref = state.record_evidence(result, tool=call.tool_name, args=call.tool_args)
        _collect_citation(state, call.tool_name, call.tool_args, result)
        # What the MODEL is shown carries the reference; the result itself is
        # untouched (it may be a cached object shared with other runs).
        self.last_result = self._shown(result, ref)
        yield AgentEvent(
            type="tool_result",
            tool_call_id=call.tool_call_id,
            tool_name=call.tool_name,
            tool_result=result,
        )
