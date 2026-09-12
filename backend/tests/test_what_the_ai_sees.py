"""The preview has one job, and it is not to be pretty: it must be TRUE.

The builder shows eleven sections for one AI step and, until this, nothing showed
their result. So authors inferred the execution model from field names — which is
the complaint the product keeps getting, and the reason the previous version was
called too hard to set up.

What the screen delivers is a fact nobody could see before. Measured on the demo
flow: in the answering step the author's 438 characters sit inside 8,976 — five
percent. In a specialist, 445 of 640 — seventy. Same author, same flow, opposite
writing problems, and no way to tell which one you were in.

A preview that drifted from the runtime would be worse than none: an author would
trust it and be wrong. So these tests pin the one property that matters — it
assembles with the SAME functions a run assembles with — rather than the shape of
the payload.
"""
from __future__ import annotations

import types

import pytest

from app.services.agent_flows.runtime.handlers import agent as A


class _Budget:
    max_llm_calls = 12
    max_tool_calls = 40
    max_seconds = 45


class _Ctx:
    def __init__(self):
        self.knowledge_scope = {"doc_ids": [7]}


def _rctx(answer_key="answer", base="BASE CONTRACT " * 40):
    return types.SimpleNamespace(
        inp=types.SimpleNamespace(
            binding=types.SimpleNamespace(
                capabilities=types.SimpleNamespace(web_search=False)),
            runtime=types.SimpleNamespace(budget=_Budget()),
            conversation=types.SimpleNamespace(history=[]),
        ),
        ctx=_Ctx(),
        base_system_prompt=base,
        answer_key=answer_key,
        api_key="",
    )


def _node(key="answer", prompt="Trả lời ngắn gọn.", tools=(), output_format="chat"):
    return types.SimpleNamespace(
        key=key, name=key, type="agent", prompt=prompt,
        output_format=output_format, max_tool_calls=8,
        knowledge=[], tools=[types.SimpleNamespace(tool=t, note="") for t in tools],
        tool_names=lambda: list(tools),
    )


def _patch(monkeypatch, *, system="SYS", messages=None, schemas=None):
    monkeypatch.setattr(A, "_system_prompt", lambda n, s, r: system)
    monkeypatch.setattr(A, "_messages", lambda n, s, r: messages or [
        {"role": "user", "content": "Doanh thu tháng này?"}])
    monkeypatch.setattr(A, "_apply_scope", lambda ctx, node: None)
    monkeypatch.setattr(A, "_resolve_model", lambda n, r: ("openai", "gpt-4o"))
    monkeypatch.setattr(
        A.tool_registry, "definitions_for", lambda names, web_enabled=False: schemas or [])


# ── the property that matters ───────────────────────────────────────────────


def test_the_preview_is_the_runtime_s_own_assembly(monkeypatch):
    """It calls `_system_prompt` and `_messages` — it does not rebuild them.

    This is the whole guarantee. A preview that assembled its own version would be
    a second definition of what a step receives, and a second definition drifts;
    when it drifts, a screen called "what the AI sees" becomes the most expensive
    kind of wrong, because an author would trust it.
    """
    calls = []
    monkeypatch.setattr(A, "_system_prompt",
                        lambda n, s, r: calls.append("system") or "THE SYSTEM PROMPT")
    monkeypatch.setattr(A, "_messages",
                        lambda n, s, r: calls.append("messages") or [
                            {"role": "user", "content": "hỏi"}])
    monkeypatch.setattr(A, "_apply_scope", lambda ctx, node: None)
    monkeypatch.setattr(A, "_resolve_model", lambda n, r: ("openai", "gpt-4o"))
    monkeypatch.setattr(A.tool_registry, "definitions_for", lambda n, web_enabled=False: [])

    out = A.preview(_node(), object(), _rctx())

    assert calls == ["system", "messages"]
    assert out["system_prompt"]["full"] == "THE SYSTEM PROMPT"
    assert [m["content"] for m in out["messages"]] == ["hỏi"]


def test_no_model_is_called(monkeypatch):
    """Free to run, so an author checks as often as they like.

    `_stream` raising here is the assertion: if the preview ever reached for a
    provider, this test fails loudly rather than quietly costing money on a screen
    people open to look around.
    """
    def boom(*_a, **_k):
        raise AssertionError("the preview must never call a provider")

    monkeypatch.setattr(A, "_stream", boom)
    _patch(monkeypatch)

    assert A.preview(_node(), object(), _rctx())["totals"]["tool_count"] == 0


# ── the rule the screen exists to teach ─────────────────────────────────────


def test_the_answering_step_is_told_it_gets_the_full_contract(monkeypatch):
    _patch(monkeypatch, system="BASE" * 100 + "Trả lời ngắn gọn.")

    out = A.preview(_node(key="answer"), object(), _rctx(answer_key="answer"))

    assert out["system_prompt"]["base_kind"] == "full"
    assert out["step"]["is_answering"] is True


def test_any_other_step_is_told_it_gets_the_compact_one(monkeypatch):
    """A real rule in `_system_prompt`, deliberate and documented there — and one
    an author had no way to observe. It is the reason the same sentence is 5% of
    one step's prompt and 70% of another's."""
    _patch(monkeypatch, system="short base Trả lời ngắn gọn.")

    out = A.preview(_node(key="cg_so_lieu"), object(), _rctx(answer_key="answer"))

    assert out["system_prompt"]["base_kind"] == "compact"
    assert out["step"]["is_answering"] is False


def test_a_classifier_is_named_as_one(monkeypatch):
    """It gets neither base: its contract is the choice list, nothing else."""
    _patch(monkeypatch)

    out = A.preview(
        _node(key="phan_loai", output_format="choice"), object(), _rctx(answer_key="answer"))

    assert out["system_prompt"]["base_kind"] == "classifier"


def test_the_share_is_computed_from_what_the_step_actually_received(monkeypatch):
    """Not from the base that was AVAILABLE — from the prompt that was built.

    Reading `len(rctx.base_system_prompt)` would report the full contract's size
    for a specialist that never received it, and the number on screen is the whole
    point of the screen.
    """
    _patch(monkeypatch, system="x" * 600 + "Trả lời ngắn gọn.")

    sp = A.preview(_node(prompt="Trả lời ngắn gọn."), object(), _rctx())["system_prompt"]

    assert sp["this_step_chars"] == len("Trả lời ngắn gọn.")
    assert sp["shared_base_chars"] == 600
    assert sp["shared_base_chars"] + sp["this_step_chars"] == len(sp["full"])


# ── it must not disturb anything ────────────────────────────────────────────


def test_the_knowledge_scope_is_restored(monkeypatch):
    """A preview that left the context holding a scope it applied would widen what
    the NEXT caller may read — the same discipline `run` keeps, for the same
    reason, and a leak here would be silent."""
    _patch(monkeypatch)
    rctx = _rctx()
    before = dict(rctx.ctx.knowledge_scope)
    monkeypatch.setattr(
        A, "_apply_scope",
        lambda ctx, node: setattr(ctx, "knowledge_scope", {"doc_ids": [999]}))

    A.preview(_node(), object(), rctx)

    assert rctx.ctx.knowledge_scope == before


def test_tool_arguments_are_surfaced_not_just_names(monkeypatch):
    """"20 of 34 tools need a chart_id" is invisible from a list of names.

    The picker shows what a tool IS; this shows what it will DEMAND, which is the
    half an author needs to see when a step keeps failing on a missing argument.
    """
    _patch(monkeypatch, schemas=[{
        "name": "rank_values",
        "description": "Top/bottom N",
        "input_schema": {
            "type": "object",
            "properties": {"chart_id": {}, "top_n": {}, "measure": {}},
            "required": ["chart_id"],
        },
    }])

    tools = A.preview(_node(tools=("rank_values",)), object(), _rctx())["tools"]

    assert tools[0]["name"] == "rank_values"
    assert tools[0]["required"] == ["chart_id"]
    assert tools[0]["arguments"] == ["chart_id", "measure", "top_n"]


@pytest.mark.parametrize("message,expected", [
    ({"role": "user", "content": "xin chào"}, "xin chào"),
    ({"role": "tool", "name": "x", "result": {"ok": True}}, '{"ok": true}'),
    ({"role": "user", "content": None}, ""),
])
def test_every_message_shape_renders_as_text(message, expected):
    """Tool results ride in `result`, not `content` — a preview that read only
    `content` would show the author an empty block where the evidence goes."""
    assert A._preview_text(message) == expected
