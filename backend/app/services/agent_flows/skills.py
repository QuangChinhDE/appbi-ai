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
  budget     the child spends the PARENT's budget (`SkillBudget`) and may use
             all of it except what the parent needs to answer afterwards — one
             model call, and the parent's own tool reserve for its answering
             step. A Skill cannot reset any limit.
  stack      (skill_key, version) ancestry, checked on flow-VERSION identity;
             depth ≤ MAX_SKILL_DEPTH. Refused at publish over the pinned graph and
             again at run time.
  trace      the child is its own run row with `parent_run_key`,
             `parent_step_key` and `invoked_as`.
  lifecycle  every version is active, deprecated or disabled (`set_lifecycle`),
             checked at EVERY invocation, pinned or not: a disabled version is
             refused with its reason; a deprecated one runs with a notice and
             cannot be newly pinned. Nothing is ever silently upgraded.
  sharing    re-checked at every invocation against the CALLING flow's owner —
             the same rule that decided whether it could be attached — so an
             unshare stops the next run, not the next publish.
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
from contextlib import contextmanager

from app.services.agent_flows.runtime.state import BudgetExhausted
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

SKILL_FLOW_TYPE = "skill"

ACTIVE = "active"
DEPRECATED = "deprecated"
DISABLED = "disabled"
LIFECYCLES = (ACTIVE, DEPRECATED, DISABLED)
#: Longest text a Skill input may carry — a question or a label, not a document.
MAX_TEXT_INPUT = 2000
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
        #: The child's OWN reservations, for the steps inside the Skill — the same
        #: rule as `Budget.reserve`, one level down.
        self.llm_reserve_stack: list[int] = []
        self.tool_reserve_stack: list[int] = []

    @property
    def started_at(self) -> float:
        return self.parent.started_at

    def elapsed(self) -> float:
        return self.parent.elapsed()

    def tools_left(self, *, answering: bool = False) -> int:
        # The PARENT's reserve for its own answering step is respected: a child is
        # never the parent's answer.
        #
        # A tool whose result no model call is left to read is not worth running.
        if self.max_llm_calls - self.llm_calls <= 0:
            return 0
        return max(0, min(self.parent.tools_left(answering=False),
                          self.max_tool_calls - self.tool_calls) - sum(self.tool_reserve_stack))

    def llm_available(self) -> int:
        """THE CHILD'S LAST MODEL CALL IS ITS ANSWER — by the one rule every step
        follows (`AgentRuntime.ask`: a step whose available calls are down to one
        is offered no tools). Measured on a link funded for 6 model calls before
        this: the Skill got 2, spent both asking for tools and died "hết số lượt gọi
        mô hình" with nothing to hand back."""
        own = self.max_llm_calls - self.llm_calls
        parents = self.parent.max_llm_calls - self.parent.llm_calls
        return max(0, min(own, parents) - sum(self.llm_reserve_stack))

    @contextmanager
    def reserve(self, *, llm: int, tools: int):
        self.llm_reserve_stack.append(max(0, int(llm)))
        self.tool_reserve_stack.append(max(0, int(tools)))
        try:
            yield
        finally:
            self.llm_reserve_stack.pop()
            self.tool_reserve_stack.pop()

    def try_spend_llm(self) -> bool:
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

    def check(self) -> None:
        """Between nodes: the PARENT's ceilings and the shared clock only.

        The child's own caps are enforced where they are SPENT (`spend_llm`,
        `spend_tool`). Checking them here cut off steps that need neither — a
        Skill with no model step and a model cap of 0 died on its first node, and
        a Skill whose last node runs after its last model call never reached it.
        """
        self.parent.check()

    def spend_llm(self) -> None:
        if self.llm_calls >= self.max_llm_calls:
            raise BudgetExhausted("Skill đã dùng hết số lượt gọi mô hình được cấp cho nó")
        self.parent.spend_llm()
        self.llm_calls += 1

    def spend_tool(self) -> None:
        if self.tool_calls >= self.max_tool_calls:
            raise BudgetExhausted("Skill đã dùng hết số lượt gọi công cụ được cấp cho nó",
                                  resource="tools")
        self.parent.spend_tool()
        self.tool_calls += 1


#: Model calls the parent keeps for itself when it hands work to a Skill: the
#: round in which it reads the Skill's result and answers.
PARENT_ANSWER_RESERVE = 1


def child_budget(parent: Any, *, reading_round: int = 1) -> SkillBudget:
    """Everything the CALLING step may still spend, minus the round in which it
    reads the Skill's result.

    "May still spend" is `llm_available()`: what is left after the reservation for
    the parent flow's later steps — so a Skill invoked early in a flow can never
    spend the model call its parent's answering step is owed, and a Skill invoked
    by the answering step leaves that step its reading round.

    NOT "HALF", which was the first rule and was measured wrong: on a link funded
    for 6 model calls the Skill got 2 — one tool round and its answer round — ran a
    single `search_business_assets`, and handed back instructions ("bạn có thể sử
    dụng…") instead of a result, recorded `ok`. The parent does not need half; it
    needs the one round in which it reads the result and answers. Tools follow the
    same rule through `tools_left(answering=False)`, which already holds back the
    parent's answer reserve.
    """
    # The soft `answer_reserve` (tools kept for the answering step) holds for a
    # Skill step too: letting a step spend it was tried and reverted — review
    # showed a Skill's deterministic tool steps could then leave the answer none.
    tools_left = parent.tools_left(answering=False)
    llm_left = parent.llm_available() if hasattr(parent, "llm_available") \
        else max(0, parent.max_llm_calls - parent.llm_calls)
    return SkillBudget(parent, tool_cap=tools_left,
                       llm_cap=max(0, llm_left - max(0, int(reading_round))))


# ═══ Resolution ═══════════════════════════════════════════════════════════════

def resolve_skill(db: Any, key: str, version: int | None) -> tuple[Any, Flow] | None:
    """The exact Skill version, or the published one when no version is named.

    A pinned version stays resolvable after the Skill publishes a newer one
    (the old row is archived, not deleted), which is what makes a pin mean
    something. A draft never resolves: drafts are not governed releases.
    """
    from app.services.agent_flows import registry

    if db is None:
        # No database, no governed release to resolve — refused, never guessed.
        return None
    found = registry.resolve_version(db, key, version)
    if not found:
        return None
    row, flow = found
    if getattr(row, "status", "") == "draft" or getattr(row, "flow_type", "") != SKILL_FLOW_TYPE:
        return None
    if flow.skill is None:
        return None
    return row, flow


# ═══ Lifecycle: a pinned version is reproducible, not unstoppable ═════════════

def lifecycle_of(row: Any) -> str:
    """NULL is active: every version written before lifecycles existed."""
    value = str(getattr(row, "lifecycle", "") or "").strip()
    return value if value in LIFECYCLES else ACTIVE


def _lifecycle_label(row: Any) -> str:
    reason = str(getattr(row, "lifecycle_reason", "") or "").strip()
    return f" — {reason}" if reason else ""


def set_lifecycle(db: Any, *, key: str, versions: list[int] | None, state: str,
                  reason: str, actor_email: str) -> list[dict]:
    """Deprecate, disable or re-activate Skill versions (`versions=None`: all).

    Draft versions are refused: a draft is not a governed release, nothing can
    pin it, and there is nothing to stop. A reason is required to deprecate or
    disable — it is what every refused caller will read.
    """
    from datetime import datetime, timezone

    from app.models.agent_brain import AgentBrainVersion
    from app.services.agent_flows.registry import DRAFT, BrainError, _audit

    if state not in LIFECYCLES:
        raise BrainError(422, f"trạng thái phải là một trong {', '.join(LIFECYCLES)}")
    reason = (reason or "").strip()
    if state != ACTIVE and len(reason) < 8:
        raise BrainError(422, "Hãy ghi lý do (ít nhất 8 ký tự) — người gọi Skill sẽ đọc nó.")
    q = db.query(AgentBrainVersion).filter(AgentBrainVersion.brain_key == key)
    rows = q.all()
    if not rows:
        raise BrainError(404, "Không tìm thấy Skill này")
    if any(getattr(r, "flow_type", "") != SKILL_FLOW_TYPE for r in rows):
        raise BrainError(409, "Chỉ flow loại Skill mới có vòng đời phiên bản")
    targets = [r for r in rows if (versions is None or r.version in versions) and r.status != DRAFT]
    if versions is not None and len(targets) != len(set(versions)):
        raise BrainError(409, "Chỉ phiên bản đã phát hành (hoặc đã lưu trữ) mới đổi được vòng đời")
    now = datetime.now(timezone.utc)
    for r in targets:
        r.lifecycle = None if state == ACTIVE else state
        r.lifecycle_reason = None if state == ACTIVE else reason
        r.lifecycle_by = actor_email
        r.lifecycle_at = now
    db.commit()
    _audit(db, "AGENT_FLOW_SKILL_LIFECYCLE", key, actor_email,
           {"versions": sorted(r.version for r in targets), "state": state, "reason": reason})
    return [lifecycle_dict(r) for r in sorted(targets, key=lambda r: r.version)]


def lifecycle_dict(row: Any) -> dict:
    at = getattr(row, "lifecycle_at", None)
    return {
        "version": getattr(row, "version", None),
        "lifecycle": lifecycle_of(row),
        "reason": getattr(row, "lifecycle_reason", None) or "",
        "by": getattr(row, "lifecycle_by", None) or "",
        "at": at.isoformat() if at is not None else None,
    }


def caller_may_use(db: Any, caller_key: str, skill_key: str) -> bool:
    """May the CALLING flow's owner still build on this Skill — now?

    The same rule that decided whether it could be attached (`usable_brains`:
    theirs, or shared with them), re-asked at invocation, so an unshare takes
    effect on the next run rather than the next publish. Fails closed: an owner
    that cannot be resolved may use nothing.
    """
    from app.models.agent_brain import AgentBrainVersion
    from app.services.agent_flows.permissions import _resolve_owner, usable_brains

    caller = (db.query(AgentBrainVersion)
              .filter(AgentBrainVersion.brain_key == caller_key)
              .order_by(AgentBrainVersion.version.desc()).first())
    if caller is None:
        return False
    owner = _resolve_owner(db, caller)
    if owner is None:
        return False
    return usable_brains(db, owner).filter(AgentBrainVersion.brain_key == skill_key).first() is not None


def invocation_refusal(db: Any, rctx: Any, row: Any, skill_key: str) -> dict | None:
    """Why this exact Skill version may not run for this caller now, if it may not.

    Checked at EVERY invocation — Agent capability, Skill step, coordinator lane
    all come through `invoke_skill` — because a pin decides WHICH version runs,
    never WHETHER it may.
    """
    version = getattr(row, "version", None)
    name = getattr(row, "name", None) or skill_key
    if lifecycle_of(row) == DISABLED:
        return _err(f"Skill “{name}” v{version} đã bị vô hiệu hoá{_lifecycle_label(row)}. "
                    "Không chạy phiên bản này; hãy trả lời bằng những gì đã có.", "skill_disabled")
    try:
        allowed = caller_may_use(db, rctx.flow.key, skill_key)
    except Exception:                                           # noqa: BLE001
        logger.warning("[skill] access re-check failed for %s → %s", rctx.flow.key, skill_key,
                       exc_info=True)
        allowed = False
    if not allowed:
        return _err(f"Skill “{name}” không còn được chia sẻ cho chủ của flow này — "
                    "không chạy.", "skill_access_revoked")
    return None


def pinned_by(db: Any, skill_key: str, version: int) -> list[str]:
    """Published or archived flows whose body pins this exact Skill version."""
    from app.models.agent_brain import AgentBrainVersion
    from app.services.agent_flows.registry import DRAFT, parse_flow

    out: list[str] = []
    rows = db.query(AgentBrainVersion).filter(AgentBrainVersion.status != DRAFT).all()
    for r in rows:
        if r.brain_key == skill_key:
            continue
        flow = parse_flow(r)
        if flow is None:
            continue
        if any(k == skill_key and v == version for k, v, _ in flow.skill_refs()):
            out.append(f"{r.brain_key} v{r.version}")
    return out


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
            if lifecycle_of(row) == DISABLED:
                problems.append(f"Bước “{node_key}” dùng Skill “{key}” v{row.version} — phiên "
                                f"bản này đã bị vô hiệu hoá{_lifecycle_label(row)}.")
                continue
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

    def pinnable(key: str) -> int | None:
        # NOTHING NEW PINS A STOPPED VERSION: deprecation means "do not build on
        # this", so an unpinned reference to a deprecated or disabled release is
        # left unpinned — and refused by `publish_problems`, which names it.
        found = resolve_skill(db, key, None)
        if found and lifecycle_of(found[0]) == ACTIVE:
            return found[0].version
        return None

    def pin(nodes: list) -> None:
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "skill" and not node.get("version"):
                version = pinnable(str(node.get("skill_key") or ""))
                if version:
                    node["version"] = version
            if node.get("type") == "agent":
                for grant in node.get("tools") or []:
                    key = skill_key_of_grant(str((grant or {}).get("tool") or ""))
                    if key and not grant.get("version"):
                        version = pinnable(key)
                        if version:
                            grant["version"] = version
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
    if flow.skill is not None and flow.skill.returns == "number":
        keys = {getattr(n, "key", "") for n in flow.all_nodes()}
        if flow.skill.value_step not in keys:
            problems.append(f"Skill trả về một con số từ bước “{flow.skill.value_step}”, nhưng flow "
                            "không có bước đó.")
    problems += skill_graph_problems(db, flow, self_key=str(getattr(row, "brain_key", "") or flow.key))
    for key, version, node_key in flow.skill_refs():
        if version is None:
            found = resolve_skill(db, key, None)
            if found and lifecycle_of(found[0]) != ACTIVE:
                problems.append(f"Bước “{node_key}”: Skill “{key}” v{found[0].version} đang "
                                f"{'ngừng khuyến nghị' if lifecycle_of(found[0]) == DEPRECATED else 'bị vô hiệu hoá'}"
                                f"{_lifecycle_label(found[0])} — không ghim được phiên bản mới vào nó.")
    # Structural bound on multi-agent, refused at the same door — including a
    # coordinator reached THROUGH a Skill from inside a coordinator lane.
    problems += flow.nested_coordinator_problems()
    problems += coordinator_through_skill_problems(db, flow)
    return problems


def deprecated_pins(db: Any, flow: Flow) -> list[str]:
    """Pinned Skill versions that are deprecated: allowed to keep running, but
    republishing onto them is a decision the author acknowledges, not a default."""
    out: list[str] = []
    for key, version, node_key in flow.skill_refs():
        if version is None:
            continue
        found = resolve_skill(db, key, version)
        if found and lifecycle_of(found[0]) == DEPRECATED:
            out.append(f"Bước “{node_key}” ghim Skill “{key}” v{version} — phiên bản này đã "
                       f"ngừng khuyến nghị{_lifecycle_label(found[0])}.")
    return out


def _reaches_coordinator(db: Any, flow: Flow, depth: int = 0) -> bool:
    """Does this flow run a coordinator — itself, or through any Skill it pins,
    transitively? Bounded by `MAX_SKILL_DEPTH`, like every Skill chain."""
    if any(getattr(n, "type", "") == "coordinate" for n in flow.all_nodes()):
        return True
    if depth >= MAX_SKILL_DEPTH:
        return False
    for key, version, _ in flow.skill_refs():
        found = resolve_skill(db, key, version)
        if found and _reaches_coordinator(db, found[1], depth + 1):
            return True
    return False


def coordinator_through_skill_problems(db: Any, flow: Flow) -> list[str]:
    """No coordinator inside a coordinator lane — also when the inner one is a
    Skill's. The runtime refuses it too (`invoke_skill`); this says it at publish."""
    problems: list[str] = []
    for node in flow.all_nodes():
        if getattr(node, "type", "") != "coordinate":
            continue
        for spec in getattr(node, "specialists", []) or []:
            lane = Flow.model_construct(key="lane", name="lane", nodes=list(spec.body))
            for key, version, node_key in lane.skill_refs():
                found = resolve_skill(db, key, version)
                if found and _reaches_coordinator(db, found[1], 1):
                    problems.append(f"Chuyên gia “{spec.key}” gọi Skill “{key}” có bước điều phối "
                                    "bên trong — không lồng điều phối trong điều phối.")
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
        if flow is None or flow.skill is None or lifecycle_of(r) == DISABLED:
            continue
        out.append({
            "key": r.brain_key,
            "name": r.name or r.brain_key,
            "version": r.version,
            "description": r.description or "",
            "grant": f"{SKILL_GRANT_PREFIX}{r.brain_key}",
            "contract": flow.skill.model_dump(mode="json"),
            "lifecycle": lifecycle_dict(r),
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
    returns = (" — one verified number (its result carries an evidence_ref for compute)"
               if contract.returns == "number" else "")
    return {
        "name": skill_function_name(key),
        "description": (
            f"Skill “{name}”: {contract.when_to_use}"
            + (f" Returns: {contract.output}{returns}." if contract.output or returns else "")
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

def _err(message: str, code: str, recovery: str = "") -> dict:
    out = {"ok": False, "error_code": code, "error": message, "retryable": False}
    if recovery:
        out["recovery"] = recovery
    return out


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
        elif spec.type == "chart_ref":
            try:
                value = int(value)
            except (TypeError, ValueError):
                return {}, f"input “{spec.name}” phải là mã biểu đồ (số nguyên)"
        elif spec.type == "date":
            import re as _re

            value = str(value).strip()
            if not _re.fullmatch(r"\d{4}(-\d{2}(-\d{2})?)?", value):
                return {}, f"input “{spec.name}” phải là ngày dạng YYYY, YYYY-MM hoặc YYYY-MM-DD"
        else:
            value = str(value)
            if len(value) > MAX_TEXT_INPUT:
                return {}, f"input “{spec.name}” dài quá {MAX_TEXT_INPUT} ký tự"
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
    caller_reads_result: bool = True,
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

    refused = invocation_refusal(db, rctx, row, skill_key)
    if refused is not None:
        outcome["result"] = refused
        return
    # A COORDINATOR REACHED THROUGH A SKILL is still a coordinator inside a lane.
    if getattr(state, "lane_depth", 0) and _reaches_coordinator(db, skill_flow, len(stack) + 1):
        outcome["result"] = _err(f"Skill “{skill_key}” có bước điều phối — không chạy trong "
                                 "một làn chuyên gia (không lồng điều phối).", "nested_coordinator")
        return
    if lifecycle_of(row) == DEPRECATED:
        from app.services.agent_flows.envelope import Notice

        if not any(n.code == "skill_deprecated" and n.facts.get("skill") == skill_key
                   for n in state.notices):
            state.notices.append(Notice(
                code="skill_deprecated", audience="author", severity="warning",
                node_key=parent_step_key,
                text=f"Skill “{row.name or skill_key}” v{row.version} đã ngừng khuyến nghị"
                     f"{_lifecycle_label(row)}.",
                facts={"skill": skill_key, "version": row.version},
            ))

    clean, problem = _validate_inputs(skill_flow.skill, inputs)
    if problem:
        outcome["result"] = _err(problem, "bad_argument")
        return

    # An AGENT that called the Skill needs one more round to read what it
    # returns; a Skill STEP does not — the steps after it are already covered by
    # the executor's reservation. Charging a Skill step for a reading round that
    # never happens is how a mandatory verifier was refused on the minimum budget.
    budget = child_budget(state.budget,
                          reading_round=PARENT_ANSWER_RESERVE if caller_reads_result else 0)
    if budget.max_tool_calls <= 0 and budget.max_llm_calls <= 0:
        outcome["result"] = _err("không còn ngân sách cho Skill ở lượt này", "budget_exhausted")
        return
    if caller_reads_result:
        # NOT STARTED rather than started to fail: a Skill handed less than one
        # tool round answers from nothing. Refused before the Skill runs or spends
        # a model call, so the calling step keeps those for its own tools or its
        # answer. The call itself is counted like any refused call; asked again
        # with the same inputs it is answered free (the runtime's retry policy).
        # (A Skill STEP is funded by the executor's reservation instead: the
        # author put it in the structure, and the preflight checked the link.)
        from app.services.agent_flows.runtime import reserve

        need_llm, need_tools = reserve.working_minimum(
            list(skill_flow.nodes), skill_lookup=reserve.skill_lookup_for(db))
        if budget.max_llm_calls < need_llm or budget.max_tool_calls < need_tools:
            outcome["result"] = _err(
                f"không đủ ngân sách để chạy Skill “{skill_key}”: cần ít nhất {need_llm} lượt gọi "
                f"mô hình và {need_tools} lượt gọi công cụ, bước này chỉ còn "
                f"{budget.max_llm_calls} và {budget.max_tool_calls} cho nó",
                "budget_exhausted",
                recovery=("Không gọi lại Skill này trong lượt hỏi này — ngân sách không tăng thêm. "
                          "Dùng trực tiếp công cụ cần thiết nếu còn lượt, hoặc trả lời bằng những gì "
                          "đã có và nói rõ phần chưa làm được."),
            )
            return

    # ── the child's authority: the CALLER's context, and nothing wider ───────
    child_ctx = copy.copy(rctx.ctx)
    try:
        # Always set, even when EMPTY: an empty caller scope is still a ceiling
        # (the report's entitlement), not the absence of one.
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
        store_content=bool(getattr(rctx, "store_content", True)),
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
            # The CALLER's privacy choice, not the default. Found by review: a link
            # with `store_question_content=False` still had its question and answer
            # stored — under the Skill, where the Skill's sharees could read them.
            store_content=bool(getattr(rctx, "store_content", True)),
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
    outcome["child_run_key"] = child_inp.request.id
    contract = skill_flow.skill
    if status not in ("ok", "partial") or (contract.returns == "text" and not answer):
        outcome["result"] = _err(
            f"Skill “{skill_key}” v{row.version} không trả về kết quả ({status})", "skill_failed")
        return
    data: dict[str, Any] = {
        "skill": skill_key,
        "version": row.version,
        "lifecycle": lifecycle_of(row),
        "returns": contract.returns,
        "answer": answer,
        "status": status,
        "notices": notices,
        "child_run_key": child_inp.request.id,
        # Vouches for NO number itself: the child's trusted ledger was merged
        # above, figure by figure. Harvesting this payload would certify an
        # answer string that happens to parse as a number — and so would a
        # formula pointed at `answer` (`evidence_paths` says: no field).
        "evidence_values": [],
        "evidence_paths": [],
    }
    if contract.returns == "number":
        # THE DECLARED TYPE, OR NOTHING. Read by the runtime from the ONE result the
        # declared step produced in the CHILD's run — the same resolver `compute`
        # uses, so taint and identifier refusal cross the boundary intact.
        from app.services.agent_flows.tools import compute as compute_tool

        store = getattr(child_state, "evidence_store", None) or {}
        try:
            _ref, value, origin = compute_tool.resolve_step_reference(
                store, contract.value_step, contract.value_path)
        except compute_tool._Refused as exc:
            outcome["result"] = _err(
                f"Skill “{skill_key}” v{row.version} không trả về đúng kiểu đã khai báo (một con "
                f"số từ bước “{contract.value_step}”): {exc}", "skill_output_invalid")
            return
        trusted = bool(origin.pop("trusted", True))
        figure = compute_tool._round(value)
        data.update({
            "value": figure,
            "provenance": "referenced" if trusted else "unreferenced",
            "source": {"step": contract.value_step, "path": contract.value_path,
                       "tool": origin.get("tool") or ""},
            # A figure the child certified is certified here; one it built on a
            # typed number is not — by provenance, never by matching values.
            "evidence_values": [figure] if trusted else [],
            "evidence_paths": ["value"] if trusted else [],
        })
        if not trusted:
            data["note"] = "Con số này được Skill tính từ một số chưa được xác thực."
    outcome["result"] = {"ok": True, "kind": "value", "data": data}
