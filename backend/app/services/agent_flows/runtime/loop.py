"""Run a brain: one step at a time, each step its own tool-calling loop.

WHAT THIS IS NOT
----------------
It is not a second engine. The provider adapters already speak all three vendors
and normalise their tool-call protocols into `AgentEvent`s, so the work here is
orchestration only: give a step its prompt and its allowed tools, run rounds until
the model stops asking for tools, hand the result to the next step.

The function this replaces was 758 lines because a hardcoded way of thinking —
recon injection, plan matching, state evolution, self-critique, verification,
contradiction detection — was interleaved with these thirty. All of that is now
something the author composes, or leaves out.

WHAT REACHES THE VIEWER
-----------------------
Only the last step's text. Earlier steps stream `status`, never `text`: a viewer
watching four agents deliberate would see four answers and believe the first. The
answer is what the chain concluded, not what any one step said.
"""
from __future__ import annotations

import logging
from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import AgentStep, Brain
from app.services.agent_flows.models_catalogue import INHERIT
from app.services.agent_flows.tools import registry as tool_registry
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

#: Hard ceiling per step regardless of what the step asked for. A model that loops
#: on a failing tool would otherwise spend the whole turn's budget on one step and
#: leave nothing for the steps that write the answer.
MAX_ROUNDS = 12


async def run_brain(
    *,
    brain: Brain,
    ctx: Any,
    api_key: str,
    link_provider: str,
    link_model: str | None = None,
    question: str,
    history: list[dict] | None = None,
    web_enabled: bool = False,
    base_system_prompt: str = "",
) -> AsyncGenerator[AgentEvent, None]:
    """Run every step of `brain`, streaming events. The last step answers.

    `link_provider` / `link_model` are what a step inheriting its model falls back
    to — the reason `inherit` is the default is that it keeps a brain usable on a
    link whose vendor its author never chose.
    """
    carried = ""  # the previous step's output, handed forward
    total = len(brain.steps)

    for index, step in enumerate(brain.steps):
        is_last = index == total - 1
        label = step.name or step.key
        yield AgentEvent(
            type="node_started",
            extra={"step": step.key, "name": label, "index": index, "total": total},
        )

        try:
            text = ""
            async for ev in _run_step(
                step=step,
                ctx=ctx,
                api_key=api_key,
                link_provider=link_provider,
                link_model=link_model,
                question=question,
                history=history or [],
                carried=carried,
                web_enabled=web_enabled,
                base_system_prompt=base_system_prompt,
                stream_text=is_last,
            ):
                if ev.type == "text":
                    text += ev.text
                    # Only the answering step's text reaches the viewer; the rest is
                    # working-out, and showing it would read as four answers.
                    if is_last:
                        yield ev
                    continue
                yield ev
            carried = text.strip()
        except Exception:  # noqa: BLE001
            # One failing step must not silence the whole turn: later steps may
            # still produce an answer from what earlier ones found.
            logger.exception("[brain] step '%s' failed", step.key)
            yield AgentEvent(
                type="error",
                text=f"Bước “{label}” gặp lỗi và bị bỏ qua.",
                extra={"step": step.key},
            )

        yield AgentEvent(
            type="node_completed",
            extra={"step": step.key, "chars": len(carried), "index": index},
        )

    if not carried:
        # Reached when every step failed, or the answering step returned nothing.
        # Said plainly rather than closing the stream on silence, which the FE
        # renders as a hung chat.
        yield AgentEvent(
            type="text",
            text="Chưa tạo được câu trả lời cho câu hỏi này.",
        )
    yield AgentEvent(type="done")


async def _run_step(
    *,
    step: AgentStep,
    ctx: Any,
    api_key: str,
    link_provider: str,
    link_model: str | None,
    question: str,
    history: list[dict],
    carried: str,
    web_enabled: bool,
    base_system_prompt: str,
    stream_text: bool,
) -> AsyncGenerator[AgentEvent, None]:
    """One step: rounds of (ask the model → run the tools it asked for)."""
    provider, model = _resolve_model(step, link_provider, link_model)
    allowed = set(step.tool_names())
    schemas = tool_registry.definitions_for(allowed, web_enabled=web_enabled)

    # The step's own knowledge scope, set on the shared context for the duration of
    # this step. An agent granted `read_document` reaches only what THIS step
    # attached, which is what makes per-step knowledge a boundary and not a hint.
    previous_scope = getattr(ctx, "knowledge_scope", None)
    _apply_scope(ctx, step)

    system = _system_prompt(base_system_prompt, step, carried)
    messages: list[dict] = [*history, {"role": "user", "content": question}]
    if carried:
        messages.append({
            "role": "user",
            "content": f"Kết quả của bước trước:\n\n{carried}",
        })

    calls_made = 0
    try:
        for _round in range(MAX_ROUNDS):
            pending: list[AgentEvent] = []
            assistant_text = ""

            async for ev in _stream(
                provider=provider, api_key=api_key, model=model,
                system_prompt=system, messages=messages, tools=schemas,
            ):
                if ev.type == "tool_call":
                    pending.append(ev)
                    continue
                if ev.type == "text":
                    assistant_text += ev.text
                    if stream_text:
                        yield ev
                    continue
                yield ev

            if not pending:
                if not stream_text and assistant_text:
                    # A non-answering step still needs its text carried forward, and
                    # the caller collects it from `text` events.
                    yield AgentEvent(type="text", text=assistant_text)
                return

            if calls_made >= step.max_tool_calls:
                # Out of tool budget: tell the model so it answers with what it has,
                # rather than cutting the step off mid-thought.
                messages.append({
                    "role": "user",
                    "content": "Hết lượt gọi công cụ. Hãy trả lời bằng những gì đã có.",
                })
                schemas = []
                continue

            messages.append({
                "role": "assistant",
                "content": assistant_text,
                "tool_calls": [
                    {"id": c.tool_call_id, "name": c.tool_name, "arguments": c.tool_args}
                    for c in pending
                ],
            })
            for call in pending:
                calls_made += 1
                yield AgentEvent(type="status", text=f"Đang dùng {call.tool_name}…")
                result = tool_registry.execute(ctx, call.tool_name, call.tool_args, allowed=allowed)
                yield AgentEvent(
                    type="tool_result",
                    tool_call_id=call.tool_call_id,
                    tool_name=call.tool_name,
                    tool_result=result,
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.tool_call_id,
                    "name": call.tool_name,
                    "content": result,
                })
    finally:
        # Restored even when the step raises, or the next step would inherit a scope
        # it was never granted — a silent widening of what the brain may read.
        if previous_scope is not None:
            ctx.knowledge_scope = previous_scope


def _apply_scope(ctx: Any, step: AgentStep) -> None:
    """Narrow the shared context to the sources THIS step attached."""
    doc_ids: list[int] = []
    dataset_ids: list[int] = []
    metric_names: list[str] = []
    for k in step.knowledge:
        if k.source == "document" and k.ref.isdigit():
            doc_ids.append(int(k.ref))
        elif k.source == "semantic" and k.ref.isdigit():
            dataset_ids.append(int(k.ref))
        elif k.source == "metric":
            metric_names.append(k.ref)
    if hasattr(ctx, "knowledge_scope"):
        ctx.knowledge_scope = {
            "doc_ids": doc_ids,
            "dataset_ids": dataset_ids,
            "metric_names": metric_names,
        }


def _resolve_model(step: AgentStep, link_provider: str, link_model: str | None) -> tuple[str, str]:
    """The step's provider/model, or the link's when it inherits."""
    if step.provider != INHERIT and step.model:
        return step.provider, step.model
    return link_provider, link_model or ""


def _system_prompt(base: str, step: AgentStep, carried: str) -> str:
    """Base prompt + the author's instructions + what this step may consult.

    APPENDED, never substituted. The base carries the citation contract, the
    answer-in-the-question's-language rule and the analysis guardrails; a chain of
    replacement prompts would drop all of them with nothing to show it happened.
    """
    parts = [base.strip()] if base.strip() else []
    parts.append(step.prompt.strip())

    notes = [f"- {g.tool}: {g.note.strip()}" for g in step.tools if g.note.strip()]
    if notes:
        parts.append("KHI NÀO DÙNG CÔNG CỤ NÀO\n" + "\n".join(notes))

    sources = [
        f"- [{k.source}] {k.ref} — {k.description}"
        for k in step.knowledge
    ]
    if sources:
        parts.append(
            "NGUỒN TRI THỨC BƯỚC NÀY ĐƯỢC TRA (và khi nào nên tra)\n" + "\n".join(sources)
        )
    if carried:
        parts.append(
            "Bước trước đã làm một phần việc. Dùng kết quả đó, đừng làm lại từ đầu."
        )
    return "\n\n".join(parts)


async def _stream(
    *, provider: str, api_key: str, model: str,
    system_prompt: str, messages: list[dict], tools: list[dict],
) -> AsyncGenerator[AgentEvent, None]:
    """Dispatch to the vendor adapter. The one place a provider name is interpreted."""
    from app.services.dashboard_ai_bot.providers import (
        stream_anthropic,
        stream_gemini_singleshot,
        stream_openai,
    )

    fn = {
        "openai": stream_openai,
        "anthropic": stream_anthropic,
        "gemini": stream_gemini_singleshot,
    }.get((provider or "").strip().lower())
    if fn is None:
        yield AgentEvent(type="error", text=f"Nhà cung cấp không hỗ trợ: {provider}")
        return

    kwargs: dict[str, Any] = {
        "api_key": api_key,
        "system_prompt": system_prompt,
        "messages": messages,
        "tools": tools or None,
    }
    if model:
        kwargs["model"] = model
    async for ev in fn(**kwargs):
        yield ev
