"""Skills — a published flow, invoked by another flow as a governed capability.

WHAT A SKILL IS
---------------
A flow whose author published it with a contract (`Flow.skill`: typed inputs,
what it returns, when to use it). Another flow reaches it three ways — an Agent
granted `skill:<key>`, a Skill step, a Skill step inside a coordinator lane —
and all three go through `invoke_skill` below. ONE invocation path, so version
pinning, authority, budget, cycle and depth rules, child-run recording and trace
cannot differ by surface.

WHAT A SKILL IS NOT
-------------------
Not a `ToolSpec.fn` (V3 §3.4): a tool is one invocation; a Skill is a child
FlowRun with its own steps, its own version and its own trace.

THE RULES
---------
  version    a published parent names an EXACT Skill version (pinned at the
             parent's publish, `pin_skill_versions`); a draft resolves the latest
             published version and the trace says so.
  authority  the child runs on the CALLER's context — the parent run's charts,
             row and web capability, excluded columns and actor — and on its own
             nodes' grants, so its reach is caller ∩ Skill. The caller's knowledge
             scope becomes the child's ceiling (`bounded_scope`). The Skill owner's
             own rights are never a runtime source: they matter only when the
             Skill was published.
  inputs     the ONLY data that crosses: nothing of the parent's variables,
             requirements, conversation or memory reaches the child.
  budget     the child spends the PARENT's budget (`SkillBudget`); a per-invocation
             ceiling of half of what is left keeps one Skill from starving the
             step that answers. A Skill cannot reset any limit.
  stack      (skill_key, version) ancestry, checked on flow-VERSION identity;
             depth ≤ MAX_SKILL_DEPTH. Refused at publish over the pinned graph and
             again at run time.
  trace      the child is its own run row with `parent_run_key`,
             `parent_step_key` and `invoked_as`.
"""
from __future__ import annotations

import copy
import logging
import uuid
from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import (
    MAX_SKILL_DEPTH,
    SKILL_GRANT_PREFIX,
    Flow,
    SkillContract,
    raw_child_groups,
    skill_function_name,
    skill_key_of_grant,
)
from app.services.agent_flows.runtime.state import BudgetExhausted
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

SKILL_FLOW_TYPE = "skill"
INVOKED_AS = ("agent_capability", "skill_node", "coordinator_lane")


# ═══ Budget: the child spends the parent's ═══════════════════════════════════

class SkillBudget:
    """A child run's view of its PARENT's budget.

    Every call and second is charged to the parent; the child additionally stops
    at its own ceiling. Duck-types `Budget` — the executor and runtime cannot
    tell the difference, which is the point: no child code path learns a second
    way to account.
    """

    def __init__(self, parent: Any, *, tool_cap: int, llm_cap: int) -> None:
        self.parent = parent
        self.max_tool_calls = max(0, int(tool_cap))
        self.max_llm_calls = max(0, int(llm_cap))
        self.max_seconds = parent.max_seconds
        self.answer_reserve = 0
        self.tool_calls = 0
        self.llm_calls = 0

    @property
    def started_at(self) -> float:
        return self.parent.started_at

    def elapsed(self) -> float:
        return self.parent.elapsed()

    def tools_left(self, *, answering: bool = False) -> int:
        # The PARENT's reserve for its own answering step is respected: a child is
        # never the parent's answer.
        return max(0, min(self.parent.tools_left(answering=False),
                          self.max_tool_calls - self.tool_calls))

    def check(self) -> None:
        self.parent.check()
        if self.llm_calls >= self.max_llm_calls:
            raise BudgetExhausted("Skill đã dùng hết số lượt gọi mô hình được cấp cho nó")
        if self.tool_calls >= self.max_tool_calls:
            raise BudgetExhausted("Skill đã dùng hết số lượt gọi công cụ được cấp cho nó")

    def spend_llm(self) -> None:
        if self.llm_calls >= self.max_llm_calls:
            raise BudgetExhausted("Skill đã dùng hết số lượt gọi mô hình được cấp cho nó")
        self.parent.spend_llm()
        self.llm_calls += 1

    def spend_tool(self) -> None:
        if self.tool_calls >= self.max_tool_calls:
            raise BudgetExhausted("Skill đã dùng hết số lượt gọi công cụ được cấp cho nó")
        self.parent.spend_tool()
        self.tool_calls += 1


def child_budget(parent: Any) -> SkillBudget:
    """Half of what the parent has left, so the parent can still answer."""
    tools_left = parent.tools_left(answering=False)
    llm_left = max(0, parent.max_llm_calls - parent.llm_calls)
    return SkillBudget(parent, tool_cap=max(0, tools_left // 2) or min(1, tools_left),
                       llm_cap=max(0, llm_left // 2) or min(1, llm_left))


# ═══ Resolution ═══════════════════════════════════════════════════════════════

def resolve_skill(db: Any, key: str, version: int | None) -> tuple[Any, Flow] | None:
    """The exact Skill version, or the published one when no version is named.

    A pinned version stays resolvable after the Skill publishes a newer one
    (the old row is archived, not deleted), which is what makes a pin mean
    something. A draft never resolves: drafts are not governed releases.
    """
    from app.services.agent_flows import registry

    found = registry.resolve_version(db, key, version)
    if not found:
        return None
    row, flow = found
    if getattr(row, "status", "") == "draft" or getattr(row, "flow_type", "") != SKILL_FLOW_TYPE:
        return None
    if flow.skill is None:
        return None
    return row, flow


def skill_graph_problems(db: Any, flow: Flow, *, self_key: str) -> list[str]:
    """Why this flow's Skill references cannot be published, if they cannot.

    Walks the PINNED graph (versions as they will run). A reference to this flow
    itself, at any version, is refused; any other repeat is refused on
    (key, version) identity; the chain may be at most MAX_SKILL_DEPTH deep.
    """
    problems: list[str] = []

    def walk(f: Flow, path: tuple, depth: int) -> None:
        for key, version, node_key in f.skill_refs():
            if key == self_key:
                problems.append(f"Bước “{node_key}” gọi Skill “{key}” — chính flow này; "
                                "một Skill không thể gọi lại chính nó.")
                continue
            found = resolve_skill(db, key, version)
            if found is None:
                problems.append(f"Bước “{node_key}” dùng Skill “{key}”"
                                f"{f' v{version}' if version else ''} — không tìm thấy bản đã "
                                "phát hành của Skill này.")
                continue
            row, child = found
            ident = (key, row.version)
            if ident in path:
                chain = " → ".join(f"{k}@v{v}" for k, v in (*path, ident))
                problems.append(f"Vòng lặp Skill: {chain}.")
                continue
            if depth + 1 > MAX_SKILL_DEPTH:
                problems.append(f"Chuỗi Skill sâu quá {MAX_SKILL_DEPTH} cấp tại “{key}”.")
                continue
            walk(child, (*path, ident), depth + 1)

    walk(flow, (), 0)
    return problems


def pin_skill_versions(db: Any, body: dict) -> dict:
    """Write the EXACT published version into every unpinned Skill reference.

    Run at publish, on the raw body that becomes the immutable published row, so a
    published flow never follows a newer Skill on its own. A reference that
    already names a version keeps it.
    """
    body = copy.deepcopy(body)

    def pin(nodes: list) -> None:
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "skill" and not node.get("version"):
                found = resolve_skill(db, str(node.get("skill_key") or ""), None)
                if found:
                    node["version"] = found[0].version
            if node.get("type") == "agent":
                for grant in node.get("tools") or []:
                    key = skill_key_of_grant(str((grant or {}).get("tool") or ""))
                    if key and not grant.get("version"):
                        found = resolve_skill(db, key, None)
                        if found:
                            grant["version"] = found[0].version
            for group in raw_child_groups(node):
                pin(group)

    pin(body.get("nodes") or [])
    return body


def publish_problems(db: Any, row: Any, flow: Flow) -> list[str]:
    """What stops this version from being published, as far as Skills go.

    Not acknowledgeable: a cycle or a too-deep chain cannot run, and a Skill with
    no contract has nothing an Agent could be shown."""
    problems: list[str] = []
    if str(getattr(row, "flow_type", "") or "") == SKILL_FLOW_TYPE and flow.skill is None:
        problems.append("Flow loại Skill phải khai báo đầu vào, kết quả và khi nào nên dùng.")
    problems += skill_graph_problems(db, flow, self_key=str(getattr(row, "brain_key", "") or flow.key))
    return problems


def attach_problems(db: Any, user: Any, flow: Flow) -> list[str]:
    """Skills this author may not build on. Same rule as any attachment: it must be
    a published Skill shared with them (or theirs)."""
    refs = flow.skill_refs()
    if not refs:
        return []
    from app.services.agent_flows.permissions import usable_brains

    usable = {r.brain_key for r in usable_brains(db, user).all()}
    problems: list[str] = []
    for key, version, node_key in refs:
        if resolve_skill(db, key, version) is None:
            problems.append(f"Bước “{node_key}”: “{key}” không phải một Skill đã phát hành.")
        elif key not in usable:
            problems.append(f"Bước “{node_key}”: Skill “{key}” chưa được chia sẻ cho bạn.")
    return problems


def list_attachable(db: Any, user: Any) -> list[dict]:
    """Published Skills this user may attach: what the builder's picker lists."""
    from app.services.agent_flows.permissions import usable_brains
    from app.services.agent_flows.registry import PUBLISHED, parse_flow

    out: list[dict] = []
    rows = [r for r in usable_brains(db, user).all()
            if getattr(r, "status", "") == PUBLISHED and getattr(r, "flow_type", "") == SKILL_FLOW_TYPE]
    for r in sorted(rows, key=lambda x: (x.name or x.brain_key).lower()):
        flow = parse_flow(r)
        if flow is None or flow.skill is None:
            continue
        out.append({
            "key": r.brain_key,
            "name": r.name or r.brain_key,
            "version": r.version,
            "description": r.description or "",
            "grant": f"{SKILL_GRANT_PREFIX}{r.brain_key}",
            "contract": flow.skill.model_dump(mode="json"),
        })
    return out


# ═══ The capability an Agent is shown ════════════════════════════════════════

def capability_definition(key: str, name: str, contract: SkillContract) -> dict:
    """A Skill as a model sees it: its contract, as a function."""
    props: dict[str, dict] = {}
    required: list[str] = []
    for i in contract.inputs:
        props[i.name] = {
            "type": "number" if i.type == "number" else "string",
            "description": i.description or i.name,
        }
        if i.required:
            required.append(i.name)
    return {
        "name": skill_function_name(key),
        "description": (
            f"Skill “{name}”: {contract.when_to_use}"
            + (f" Returns: {contract.output}" if contract.output else "")
            + " Runs as its own governed sub-flow; pass every input it needs — it "
              "sees nothing else of this conversation."
        ),
        "input_schema": {"type": "object", "properties": props, "required": required},
    }


def search_text(key: str, name: str, contract: SkillContract) -> str:
    return " ".join(filter(None, [
        key, key.replace("_", " "), name, contract.when_to_use, contract.output,
        *[f"{i.name} {i.description}" for i in contract.inputs],
    ]))


# ═══ Invocation — the one path ═══════════════════════════════════════════════

def _err(message: str, code: str) -> dict:
    return {"ok": False, "error_code": code, "error": message, "retryable": False}


def _validate_inputs(contract: SkillContract, inputs: dict) -> tuple[dict, str]:
    out: dict[str, Any] = {}
    for spec in contract.inputs:
        value = (inputs or {}).get(spec.name)
        if value is None or (isinstance(value, str) and not value.strip()):
            if spec.required:
                return {}, f"thiếu input bắt buộc “{spec.name}” ({spec.description or spec.type})"
            continue
        if spec.type == "number":
            try:
                value = float(value)
            except (TypeError, ValueError):
                return {}, f"input “{spec.name}” phải là một con số"
        out[spec.name] = value
    return out, ""


async def invoke_skill(
    state: Any,
    rctx: Any,
    *,
    skill_key: str,
    version: int | None,
    inputs: dict,
    invoked_as: str,
    parent_step_key: str,
    outcome: dict,
) -> AsyncGenerator[AgentEvent, None]:
    """Run one Skill as a child FlowRun of this run. Result left in `outcome["result"]`.

    Yields only status events: a child's prose never streams to the reader —
    what the parent does with the Skill's answer is the parent's decision.
    """
    from app.services.agent_flows import runs as runs_service
    from app.services.agent_flows.envelope import (
        ConversationInfo,
        FlowInput,
        FlowOutput,
        MemoryInfo,
        QuestionInfo,
        RequestInfo,
    )
    from app.services.agent_flows.runtime import executor

    db = getattr(rctx, "db", None)
    found = resolve_skill(db, skill_key, version)
    if found is None:
        outcome["result"] = _err(f"không tìm thấy bản đã phát hành của Skill “{skill_key}”",
                                 "skill_not_found")
        return
    row, skill_flow = found
    ident = (skill_key, row.version)
    stack = tuple(getattr(rctx, "skill_stack", ()) or ())

    # ── ancestry, on flow-version identity ───────────────────────────────────
    if skill_key == rctx.flow.key or ident in stack or any(k == skill_key for k, _ in stack):
        chain = " → ".join(f"{k}@v{v}" for k, v in (*stack, ident))
        outcome["result"] = _err(f"vòng lặp Skill bị chặn: {chain}", "skill_cycle")
        return
    if len(stack) >= MAX_SKILL_DEPTH:
        outcome["result"] = _err(f"Skill lồng quá {MAX_SKILL_DEPTH} cấp", "skill_depth_exceeded")
        return

    clean, problem = _validate_inputs(skill_flow.skill, inputs)
    if problem:
        outcome["result"] = _err(problem, "bad_argument")
        return

    budget = child_budget(state.budget)
    if budget.max_tool_calls <= 0 and budget.max_llm_calls <= 0:
        outcome["result"] = _err("không còn ngân sách cho Skill ở lượt này", "budget_exhausted")
        return

    # ── the child's authority: the CALLER's context, and nothing wider ───────
    child_ctx = copy.copy(rctx.ctx)
    try:
        child_ctx.knowledge_ceiling = dict(getattr(rctx.ctx, "knowledge_scope", None) or {})
    except Exception:                                           # noqa: BLE001
        pass

    # ── the child's input: its inputs, and nothing of the parent's context ───
    parent_inp = rctx.inp
    question = str(clean.get("question") or "")
    child_inp = parent_inp.model_copy(update={
        "request": RequestInfo(
            id=f"sk-{uuid.uuid4().hex[:24]}", at=parent_inp.request.at,
            locale=parent_inp.request.locale, is_test=parent_inp.request.is_test,
            trigger="skill",
        ),
        "question": QuestionInfo(raw=question, normalized=question),
        "conversation": ConversationInfo(session_key="", history=[]),
        "memory": MemoryInfo(),
        "binding": parent_inp.binding.model_copy(update={"defaults": {}, "resolved": {}, "unresolved": []}),
    })

    holder: dict[str, Any] = {}

    def keep_state(child_state: Any) -> None:
        holder["state"] = child_state
        child_state.vars["input"] = dict(clean)

    yield AgentEvent(type="status", text=f"Đang chạy Skill {row.name or skill_key}…")
    envelope: dict = {}
    async for ev in executor.run_flow(
        child_inp, flow=skill_flow, ctx=child_ctx, api_key=rctx.api_key,
        base_system_prompt=rctx.base_system_prompt, db=db,
        budget=budget, skill_stack=(*stack, ident), on_state=keep_state,
    ):
        if ev.type == "result":
            envelope = ev.extra.get("envelope") or {}
    child_state = holder.get("state")
    child_out = FlowOutput.model_validate(envelope) if envelope else None

    # ── recorded as its own run, linked to its parent ─────────────────────────
    if db is not None and child_out is not None:
        runs_service.record(
            db, inp=child_inp, out=child_out, brain_key=skill_key, version=row.version,
            binding_id=parent_inp.binding.id or None,
            parent_run_key=parent_inp.request.id, parent_step_key=parent_step_key,
            invoked_as=invoked_as if invoked_as in INVOKED_AS else "agent_capability",
        )

    # ── what the parent inherits: the child's TRUSTED evidence, not its words ─
    if child_state is not None:
        state.evidence.extend(child_state.evidence)
        state.evidence_labels |= child_state.evidence_labels
        state.evidence_sources.add(f"skill:{skill_key}")
        state.prompt_tokens += child_state.prompt_tokens
        state.completion_tokens += child_state.completion_tokens
        for c in child_state.citations:
            if not any(x.ref == c.ref and x.kind == c.kind for x in state.citations):
                state.citations.append(c)
    state.tool_log.append(f"{SKILL_GRANT_PREFIX}{skill_key}@v{row.version}")

    answer = child_out.answer.plain_text().strip() if child_out else ""
    status = child_out.status if child_out else "failed"
    notices = [n.code for n in (child_out.notices if child_out else [])]
    if status not in ("ok", "partial") or not answer:
        outcome["result"] = _err(
            f"Skill “{skill_key}” v{row.version} không trả về kết quả ({status})", "skill_failed")
        outcome["child_run_key"] = child_inp.request.id
        return
    outcome["child_run_key"] = child_inp.request.id
    outcome["result"] = {
        "ok": True,
        "kind": "value",
        "data": {
            "skill": skill_key,
            "version": row.version,
            "answer": answer,
            "status": status,
            "notices": notices,
            "child_run_key": child_inp.request.id,
        },
    }
