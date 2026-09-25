"""`tool_calling` — the Agent reasoning strategy AppBI has always had.

Ask the model; run the tools it asked for; feed the results back; repeat until it
answers. This is the loop that lived inside `handlers/agent.py:run`, MOVED here
unchanged: the canonical replay fixtures are the acceptance test, and "zero
intentional semantic drift" is the contract of the move.

WHAT A STRATEGY OWNS, AND WHAT IT MAY NOT TOUCH.
It owns the conversation — what the model is shown, how a result is fed back,
when a round ends, when to stop. It does not own a single rule: the provider
call, the deadline, the budget, the node ceiling, the retry policy, evidence,
scope — all of those are `AgentRuntime` methods. This module imports neither a
provider adapter nor the tool registry, and `test_strategy_is_pure.py` keeps it
that way, so a second strategy cannot quietly grow its own copy of a rule.
"""
from __future__ import annotations

from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import AgentNode
from app.services.agent_flows.runtime.state import RunState
from app.services.dashboard_ai_bot.events import AgentEvent


def evidence_index(state: RunState, *, exclude_step: str = "", limit: int = 20) -> str:
    """Results EARLIER steps produced, by reference — what `compute` can name.

    A step's own tool results arrive with their `evidence_ref`. A result a
    previous step read (the report, a Tool step) reaches this step only as
    projected text, so without this list a formula over report data could only
    be written with typed numbers — which `compute` computes with and never
    certifies. Only offered to a step that holds `compute`: to any other step it
    is noise.
    """
    rows = []
    for ref, entry in list(state.evidence_store.items())[-limit:]:
        if entry.get("source") == exclude_step:
            continue
        result = entry.get("result") or {}
        data = result.get("data")
        if isinstance(data, dict):
            shape = ", ".join(list(map(str, data))[:6])
            if isinstance(data.get("rows"), list):
                shape += f" ({len(data['rows'])} dòng)"
        elif isinstance(data, list):
            shape = f"danh sách {len(data)} phần tử"
        else:
            shape = type(data).__name__
        rows.append(f"- {ref}: {entry.get('tool') or '?'} (bước {entry.get('source') or '?'}) — {shape}")
    if not rows:
        return ""
    return (
        "KẾT QUẢ ĐÃ CÓ TRONG LƯỢT NÀY, dùng làm biến cho `compute` bằng "
        "{\"ref\": \"eN\", \"path\": \"...\"} — đường dẫn đọc bên trong `data`:\n"
        + "\n".join(rows)
    )


#: The `final` phase: the round a step is offered no tools on, because it is the
#: last call its budget or round ceiling allows.
FINAL_ROUND = (
    "This is your last turn in this step: no further tool calls are available. "
    "Answer now with what you already have, and say plainly what you could not "
    "check. Reply in the language of the user's question."
)


class ToolCallingStrategy:
    name = "tool_calling"

    def __init__(self, node: AgentNode, state: RunState, rctx: Any, *, max_rounds: int) -> None:
        self.node = node
        self.state = state
        self.rctx = rctx
        self.max_rounds = max_rounds
        self.system = ""
        self.messages: list[dict] = []
        #: Every round's prose, concatenated — the step's raw text.
        self.collected = ""
        self._reminder: dict | None = None

    # ── context ──────────────────────────────────────────────────────────────
    def build_request(self) -> None:
        """The system prompt and conversation this node's model is shown.

        The SAME two functions "What the AI sees" calls, so the preview and the run
        cannot drift (`handlers/agent.py:preview`).
        """
        from app.services.agent_flows.runtime.handlers import agent as context

        self.system = context._system_prompt(self.node, self.state, self.rctx)
        self.messages = context._messages(self.node, self.state, self.rctx)
        index = evidence_index(self.state, exclude_step=self.node.key) \
            if "compute" in set(self.node.tool_names()) else ""
        if index:
            self.system = f"{self.system}\n\n{index}"

    def _language_reminder(self) -> str:
        from app.services.agent_flows.runtime.handlers import agent as context

        return context._language_reminder(self.rctx)

    # ── instructions, each on the round it governs ───────────────────────────
    #
    # AN INSTRUCTION THE MODEL READS AFTER IT HAS DECIDED IS NOT AN INSTRUCTION.
    #
    # Every instruction this strategy adds has a PHASE, and is placed so that the
    # round it is meant to govern is the round that reads it:
    #
    #   system       every round — base, node prompt, grants' notes, sources,
    #                routing note, evidence index (`build_request`, `run`)
    #   after_tools  the round that reads a batch of tool results — the language
    #                reminder, right after the results it competes with; one copy,
    #                moved forward each round rather than piling up
    #   final        the round offered no tools — "answer now with what you have"
    #   correction   a verifier's own round (`handlers/agent._retry_*`), which
    #                reuses `messages` and so also reads the latest reminder
    #
    # The language reminder used to be appended AFTER the loop: the model that
    # wrote the answer never read it, only the correction calls did.
    def _after_tools(self) -> None:
        reminder = {"role": "user", "content": self._language_reminder()}
        if self._reminder is not None:
            try:
                self.messages.remove(self._reminder)
            except ValueError:
                pass
        self.messages.append(reminder)
        self._reminder = reminder

    def _final(self) -> None:
        self.messages.append({"role": "user", "content": FINAL_ROUND})

    # ── the loop ─────────────────────────────────────────────────────────────
    async def run(self, rt: Any) -> AsyncGenerator[AgentEvent, None]:
        """Drive the step. `rt` is the `AgentRuntime`: the only way out of here."""
        self.build_request()
        # A ROUTED step is told that more is available and how to load it — the
        # view is the runtime's; saying it to the model is the strategy's. The
        # catalogue itself travels in `find_capability`'s own definition.
        note = rt.view.routing_note() if getattr(rt, "view", None) else ""
        if note:
            self.system = f"{self.system}\n\n{note}"
        node, messages = self.node, self.messages
        # Only the answering node's prose reaches the viewer, and only when it IS
        # prose: a half-written JSON object cannot be rendered.
        stream_text = rt.is_answering and node.output_format == "chat"

        for _round in range(self.max_rounds):
            last = _round == self.max_rounds - 1
            if _round and not rt.can_ask():
                # What is left belongs to later steps; this step has spoken.
                break
            if rt.next_round_is_final(last=last):
                self._final()
            async for ev in rt.ask(self.system, messages, stream_text=stream_text, last=last):
                yield ev
            reply = rt.last_reply
            if reply.timed_out:
                break

            self.collected += reply.text
            if not reply.tool_calls:
                break

            room = rt.tool_room()
            if room <= 0:
                # Out of budget: tell the model so it answers with what it has,
                # rather than cutting it off mid-thought.
                messages.append({
                    "role": "user",
                    "content": (
                        "No tool calls remain for this step. Answer with what "
                        "you already have, and say plainly what you could not "
                        "check. Reply in the language of the user's question."
                    ),
                })
                rt.withdraw_tools()
                continue

            pending = reply.tool_calls
            runnable, refused = pending[:room], pending[room:]
            messages.append({
                "role": "assistant",
                "content": reply.text,
                # `args` — the key BOTH provider adapters read and the one their
                # own docstrings document. Sending `arguments` meant every tool
                # call this engine replayed reached the next round as `{}`: the
                # model could not see what it had just asked for, so it re-asked,
                # spending a second round to learn what it already knew.
                "tool_calls": [
                    {"id": c.tool_call_id, "name": c.tool_name, "args": c.tool_args}
                    for c in pending
                ],
            })
            # THE PROTOCOL OWES A RESULT TO EVERY CALL IT ANNOUNCED.
            #
            # A tool_call with no matching tool message makes OpenAI reject the
            # whole request, so a refused call must still be answered — with the
            # reason, which is also the more useful thing for the model to read.
            for call in refused:
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.tool_call_id,
                    "name": call.tool_name,
                    "result": rt.budget_exhausted(),
                })

            for call in runnable:
                # THE ROOM IS RE-READ PER CALL, not once per batch: a Skill in the
                # batch spends its child's share, and the next call's room is what
                # is left after that (found by review: the batch overshot the run
                # ceiling and the step died before the answer).
                if rt.tool_room() <= 0:
                    messages.append({
                        "role": "tool", "tool_call_id": call.tool_call_id,
                        "name": call.tool_name, "result": rt.budget_exhausted(),
                    })
                    continue
                async for ev in rt.invoke(call):
                    yield ev
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.tool_call_id,
                    "name": call.tool_name,
                    # `result`, which is the key the provider adapters document and
                    # read. Sending `content` meant every tool output this engine
                    # produced reached the model as `{}` — the agent was answering
                    # about a report it had never actually been shown.
                    "result": rt.last_result,
                })
            # THE LANGUAGE CONSTRAINT SITS NEXT TO THE RESULTS IT COMPETES WITH.
            # A tool result is a large English payload, and next to a ten-word
            # Vietnamese question the model follows the payload.
            if runnable:
                self._after_tools()

            # A RECOVERY THE MODEL WILL NOT READ IS NOT A RECOVERY.
            #
            # After the runtime has explained the same dead request twice and been
            # ignored, the tools come off the table and the model is asked to
            # answer with what it has. The runtime decides WHEN (it owns the
            # breaker); the strategy says it to the model.
            if rt.recoveries_ignored and rt.tools_offered:
                messages.append({
                    "role": "user",
                    "content": (
                        "You have repeated a request that was already refused "
                        "for a reason that will not change. No further tool "
                        "calls are available for this step. Answer with what you "
                        "already have, and say plainly what you could not check "
                        "and why. Reply in the language of the user's question."
                    ),
                })
                rt.withdraw_tools()

