# -*- coding: utf-8 -*-
"""Run a flow fixture and reduce the result to what a refactor must not change.

WHY THIS EXISTS
---------------
"This refactor does not change existing behaviour" is a claim until something can
check it. V3 moves the wrapper around every node (V3.3) and the reasoning loop
inside every agent (V3.4); both are changes where a subtle difference shows up as a
wrong answer weeks later, in a flow nobody was looking at.

WHY NOT BYTE-FOR-BYTE
---------------------
Two reasons, and the second is the dangerous one.

A run carries timestamps, durations, ids and token counts. Comparing those makes CI
red because a clock moved, and a suite that cries wolf gets a `--update` flag bolted
on within a week — at which point it protects nothing.

Worse: snapshotting EVERYTHING freezes the current bugs alongside the current
behaviour. Every wrong answer the system produces today would become an acceptance
criterion for every phase after. So the snapshot records the things a person would
call "what the flow did", and deliberately not the things they would call "when".

WHAT IS COMPARED, AND WHY EACH ONE
----------------------------------
    execution_path        which steps ran, in order, and how they ended. A node
                          that changes from `reused` to `ok` is a behaviour change
                          even when the answer is identical — it costs money.
    tool_calls            names in call ORDER. Order is semantic here: reading a
                          chart before listing charts is a different flow.
    tool_args             normalised. `top_n` silently becoming 50 is exactly the
                          class of drift that produces a plausible wrong number.
    step_outputs          what each step published for the next one.
    notice_codes          in order. A notice disappearing means the run stopped
                          admitting something.
    answer_shape          has answer / block count / citation count / figure count.
                          NOT the prose: the stub's text is not the product.
    citations             kind + ref, sorted — collection order is not semantic.
    capability_decisions  every refusal, by code. This is the I5 tripwire: if a
                          gate stops firing, a refusal vanishes here.
    counts                llm_calls / tool_calls. Budget semantics.

WHAT IS DROPPED
---------------
    timestamps · ms / latency · run and DB ids · token estimates · provider
    metadata · cache hit-miss

Token counts are dropped even though the stub makes them deterministic: they are a
property of the stub, not of the flow, and pinning them would make every change to
the stub look like a behaviour change.
"""
from __future__ import annotations

import json
import os
import pathlib
from typing import Any

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import asyncio  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.tools.context import ToolContext  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as agent_handler  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FIXTURE_DIR = HERE / "fixtures" / "agent_flows"
SNAPSHOT_DIR = FIXTURE_DIR / "_snapshots"


# ── the world a fixture runs in ─────────────────────────────────────────────


class _Ctx:
    """Just enough `ToolContext` for the runtime: scope and the chart allowlist.

    Capabilities live here too, because `dispatch` puts them on the context and the
    registry's gate reads them from it — a fixture that withholds `read_rows` has
    to withhold it where the gate will actually look.
    """

    def __init__(self, charts: list[int], *, read_rows: bool = True,
                 web_search: bool = False, knowledge_scope: dict | None = None):
        self.allowed_chart_ids = set(charts)
        self.knowledge_scope = knowledge_scope or {}
        self.read_rows = read_rows
        self.web_search = web_search
        self.dashboard = None
        self.max_result_tokens = 4000
        self.max_rows_per_call = 50

    # THE REAL GUARD, BORROWED — not a reimplementation.
    #
    # A fixture that pins "chart outside the binding is refused" has to exercise
    # the code that refuses it. Writing a lookalike here would pin the harness's
    # opinion instead, and the first version of this file did exactly that: the
    # method was simply missing, the tool raised AttributeError, and the snapshot
    # recorded `internal` — a crash wearing a refusal's clothes.
    assert_chart_in_scope = ToolContext.assert_chart_in_scope


def _scripted_provider(script: dict):
    """A provider that says what the fixture told it to say.

    Echoes the prompt into its answer, as the golden suite's stub does, so an
    unresolved `{{placeholder}}` is visible in the snapshot instead of being
    smoothed over by plausible prose.
    """
    text = str(script.get("text") or "ok")
    fail_times = int(script.get("fail_times") or 0)
    tool_calls = list(script.get("tool_calls") or [])
    state = {"calls": 0}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        state["calls"] += 1
        user = ""
        for m in messages:
            if m.get("role") == "user":
                user = str(m.get("content") or "")
        if state["calls"] <= fail_times:
            raise RuntimeError("vendor tạm thời lỗi")
        # A scripted tool call, on the first round only — enough to exercise the
        # agent's tool path without pretending to be a model.
        if tool_calls and state["calls"] == 1:
            for i, call in enumerate(tool_calls):
                # `tool_name` / `tool_args` are FIELDS on AgentEvent, not `extra`.
                # Put them in `extra` and the handler sees an unnamed call, refuses
                # it as `not_granted`, and the fixture pins the wrong refusal — a
                # green tripwire guarding nothing. Found by checking what the three
                # capability fixtures actually recorded.
                yield AgentEvent(
                    type="tool_call",
                    tool_call_id=f"call_{i}",
                    tool_name=call["name"],
                    tool_args=call.get("args") or {},
                )
        yield AgentEvent(type="text", text=f"{text} :: {user[:200]}")
        yield AgentEvent(type="usage",
                         extra={"prompt_tokens": 100, "completion_tokens": 20})

    return fake


def _scripted_tools(script: dict, *, real: bool):
    """Tool results the fixture dictates — or the real registry when it asks.

    `real=True` is what makes a fixture able to pin a CAPABILITY DECISION: the
    genuine `execute()` runs, the genuine gate refuses, and the refusal lands in
    the snapshot. A stub could only pin the shape of a refusal it invented.
    """
    if real:
        return None
    by_name = dict(script.get("by_name") or {})
    default = script.get("default") or {
        "ok": True, "kind": "table",
        "data": {"columns": ["category", "revenue"], "rows": [["moveis", 1200]]},
    }

    def fake(ctx, name, args, allowed=None, use_cache=True):
        return by_name.get(name, default)

    return fake


# ── running one fixture ─────────────────────────────────────────────────────


def load_fixtures() -> list[dict]:
    out = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        data["_path"] = str(path)
        data.setdefault("name", path.stem)
        out.append(data)
    return out


def _envelope(fixture: dict) -> dict:
    over = fixture.get("envelope") or {}
    base = {
        "request": {"id": "replay", "trigger": "studio_test"},
        "question": {"raw": "Doanh thu thế nào?"},
        "report": {
            "dashboard_id": 67, "name": "Olist",
            "charts": [{"id": 41, "title": "Doanh thu theo danh mục",
                        "chart_type": "BAR",
                        "measures": [{"field": "revenue"}],
                        "dimensions": [{"field": "category"}]}],
        },
        "binding": {
            "id": 1, "flow_version": 1, "allowed_chart_ids": [41],
            "resolved": {},
            "capabilities": {"web_search": False, "read_rows": True},
        },
        "runtime": {
            "provider": "openai", "model": "gpt-4o-mini",
            "budget": {"max_llm_calls": 12, "max_tool_calls": 40, "max_seconds": 60},
        },
    }
    for key, value in over.items():
        base[key] = {**base.get(key, {}), **value} if isinstance(value, dict) else value
    return base


def run_fixture(fixture: dict, monkeypatch) -> dict:
    """Execute one fixture and return the RAW result envelope."""
    body = dict(fixture["flow"])
    # The FILE is numbered so the suite reads in order; a flow key may not start
    # with a digit, so the key is derived rather than borrowed.
    key = "fx_" + fixture["name"].lower().lstrip("0123456789_")
    upgraded = upgrade_body(body, key=key, name=fixture["name"])
    flow = Flow.model_validate({**upgraded, "key": key, "name": fixture["name"]})

    monkeypatch.setattr(agent_handler, "_stream",
                        _scripted_provider(fixture.get("provider") or {}))
    tools_script = fixture.get("tools") or {}
    fake_tools = _scripted_tools(tools_script, real=bool(tools_script.get("real")))
    if fake_tools is not None:
        monkeypatch.setattr(tool_registry, "execute", fake_tools)

    env = _envelope(fixture)
    caps = env["binding"].get("capabilities") or {}
    ctx = _Ctx(
        env["binding"].get("allowed_chart_ids") or [],
        read_rows=bool(caps.get("read_rows", True)),
        web_search=bool(caps.get("web_search", False)),
        knowledge_scope=fixture.get("knowledge_scope") or {},
    )

    async def go():
        out = None
        async for ev in executor.run_flow(
            FlowInput.model_validate(env), flow=flow, ctx=ctx,
            api_key="k", base_system_prompt="BASE",
        ):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out

    return asyncio.run(go()) or {}


# ── canonicalisation ────────────────────────────────────────────────────────

#: Dropped wherever they appear. Volatile, or a property of the harness rather
#: than of the flow.
VOLATILE_KEYS = frozenset({
    "ms", "latency_ms", "duration", "started_at", "finished_at", "created_at",
    "run_id", "id", "prompt_tokens", "completion_tokens", "usd", "cached",
    "fingerprint", "session_key", "trace_id",
})


def _normalise_args(args: Any) -> Any:
    """Tool arguments with key order removed and volatile values dropped.

    Values are KEPT — `top_n` quietly becoming 50 is precisely the drift that
    produces a plausible wrong number, and dropping the value to make the diff
    quiet would hide it.
    """
    if isinstance(args, dict):
        return {k: _normalise_args(v) for k, v in sorted(args.items())
                if k not in VOLATILE_KEYS}
    if isinstance(args, list):
        return [_normalise_args(v) for v in args]
    return args


def _tool_entry(raw: str) -> dict:
    """`tool_log` records either `name` or `name(error_code)`."""
    if raw.endswith(")") and "(" in raw:
        name, _, code = raw.partition("(")
        return {"tool": name, "refused": code.rstrip(")")}
    return {"tool": raw}


def canonicalise(result: dict, *, name: str) -> dict:
    """Reduce a result envelope to the shape a refactor must preserve."""
    trace = (result or {}).get("trace") or {}
    steps = trace.get("steps") or []

    path = [
        {"key": s.get("key"), "type": s.get("type"), "status": s.get("status")}
        for s in steps
    ]

    calls: list[dict] = []
    for step in steps:
        for raw in step.get("tool_calls") or []:
            entry = _tool_entry(str(raw))
            entry["step"] = step.get("key")
            calls.append(entry)

    answer = (result or {}).get("answer") or {}
    blocks = answer.get("blocks") or []
    citations = (result or {}).get("citations") or []

    return {
        "fixture": name,
        "status": result.get("status"),
        "execution_path": path,
        # ORDER IS SEMANTIC. Reading a chart before listing charts is a different
        # flow from listing first, even when both answer the question.
        "tool_calls": calls,
        # WHAT EACH STEP PUBLISHED. The result envelope carries no `variables`
        # block — checked, not assumed — so the observable record of what a step
        # handed the next one is its `output_preview`. Truncated by the runtime and
        # deterministically so, which is fine: this pins that the value did not
        # change, not what every byte of it was.
        "step_outputs": {
            s.get("key"): s.get("output_preview") for s in steps
        },
        # What the run asked to be remembered for the next turn. A behaviour.
        "memory_set_keys": sorted((result.get("memory_delta") or {}).get("set") or {}),
        # Order is semantic: a notice appears when the thing it describes happened.
        "notice_codes": [n.get("code") for n in (result.get("notices") or [])],
        "answer_shape": {
            "has_answer": bool(blocks),
            "block_count": len(blocks),
            "citation_count": len(citations),
            "figure_count": len(answer.get("figures") or []),
        },
        # Collection order is NOT semantic — the read order is already pinned by
        # `tool_calls` — so this is sorted to stop it flapping.
        "citations": sorted(
            ({"kind": c.get("kind"), "ref": str(c.get("ref"))} for c in citations),
            key=lambda c: (c["kind"] or "", c["ref"] or ""),
        ),
        # Budget semantics. Token COUNTS are deliberately absent: they are a
        # property of the stub provider, not of the flow.
        "counts": {
            "llm_calls": (result.get("usage") or {}).get("llm_calls"),
            "tool_calls": len(calls),
            "steps": len(steps),
        },
    }


def replay(fixture: dict, monkeypatch) -> dict:
    return canonicalise(run_fixture(fixture, monkeypatch), name=fixture["name"])


# ── snapshots on disk ───────────────────────────────────────────────────────


def snapshot_path(name: str) -> pathlib.Path:
    return SNAPSHOT_DIR / f"{name}.json"


def read_snapshot(name: str) -> dict | None:
    path = snapshot_path(name)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_snapshot(name: str, data: dict) -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    with open(snapshot_path(name), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def diff(expected: dict, actual: dict, path: str = "") -> list[str]:
    """Every semantic difference, named by where it is.

    Returns paths rather than a dump: "tool_calls[1].tool" tells a reader what
    changed; two pretty-printed JSON blobs do not.
    """
    out: list[str] = []
    if type(expected) is not type(actual):
        return [f"{path or '<root>'}: {type(expected).__name__} → {type(actual).__name__}"]
    if isinstance(expected, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in expected:
                out.append(f"{path}.{key}: thêm mới = {actual[key]!r}")
            elif key not in actual:
                out.append(f"{path}.{key}: biến mất (trước là {expected[key]!r})")
            else:
                out += diff(expected[key], actual[key], f"{path}.{key}")
        return out
    if isinstance(expected, list):
        if len(expected) != len(actual):
            out.append(f"{path}: {len(expected)} phần tử → {len(actual)}")
        for i, (e, a) in enumerate(zip(expected, actual)):
            out += diff(e, a, f"{path}[{i}]")
        return out
    if expected != actual:
        out.append(f"{path or '<root>'}: {expected!r} → {actual!r}")
    return out
