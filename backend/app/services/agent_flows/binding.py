"""The data contract between one public link and one flow.

THE RULE THIS FILE IMPLEMENTS
-----------------------------
"Define the data BEFORE assigning the flow — not assign it and have the code work
out the limits at run time."

So: a flow declares what it NEEDS (`FlowRequirements`); a binding says what those
needs resolve to on THIS dashboard, and which charts, documents and capabilities
this link exposes. `preflight` refuses the assignment while anything required is
unresolved. At run time nothing is inferred — a link with no valid binding does not
answer, and says so.

THE CEILING, IN ONE LINE
------------------------
    effective = author's CURRENT rights  ∩  binding declaration  ∩  this dashboard

A binding can only ever NARROW. It cannot reach a document the flow's author cannot
read (the delegation ceiling is unchanged), and it cannot name a chart that is not
on its own link's dashboard. Both are enforced here rather than trusted.
"""
from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.models.agent_flow_binding import AgentFlowBinding
from app.models.models import DashboardPublicLink
from app.services.agent_flows.coverage import coverage as coverage_of
from app.services.agent_flows.contract import (
    AgentNode,
    Flow,
    LoopNode,
)
from app.services.agent_flows.envelope import (
    BindingInfo,
    Budget as BudgetEnvelope,
    Capabilities,
    KnowledgeScope,
    ResolvedRef,
)

logger = logging.getLogger(__name__)

#: THE THREE STATES A BINDING CAN BE IN, and no more.
#:
#:   active        preflight passed; this link runs this flow
#:   broken        drift was detected — a chart or a grant it depended on is gone
#:   needs_review  created by migration `20260810_0052` from a pre-binding link,
#:                 never confirmed by a person
#:
#: `draft` was declared here and assigned nowhere. A status that exists in the
#: vocabulary but not in the data is worse than no status: the frontend carried a
#: branch for it, a reader had to work out when it happens, and the answer was
#: never. Removed rather than wired up — nothing wanted it.
ACTIVE, BROKEN, NEEDS_REVIEW = "active", "broken", "needs_review"

#: Rough seconds per model call, by model-name prefix. Measured on this deployment,
#: not taken from a datasheet: the number that matters is how long a VIEWER waits.
#: Reasoning models think before they speak, and that thinking is the wait.
SECONDS_PER_CALL: dict[str, int] = {
    "gpt-5": 18,
    "o1": 20,
    "o3": 20,
    "claude-opus": 12,
    "gemini-2.5-pro": 10,
    "claude-sonnet": 6,
    "gpt-4o": 4,
    "gemini-2.5-flash": 3,
    "gpt-4o-mini": 2,
    "claude-haiku": 2,
}


class BindingError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ChartsScope(_Model):
    """Which charts this link exposes to the flow.

    `all_current` exists ONLY for links migrated from the old single-key setup: it
    reproduces the previous behaviour (every chart on the dashboard) so nothing
    broke on deploy day. New bindings use `allowlist`, and the mode is removed once
    no binding is still `needs_review`.
    """

    mode: Literal["allowlist", "all_current"] = "allowlist"
    ids: list[int] = Field(default_factory=list)


class ResolveEntry(_Model):
    kind: Literal["measure", "dimension", "chart", "document", "dataset", "metric", "value"]
    chart_id: int | None = None
    field: str = ""
    ref: str = ""
    label: str = ""
    #: Fixed values, when the author would rather pin them than have them read from
    #: the data each turn.
    values: list[Any] = Field(default_factory=list)


class KnowledgeContract(_Model):
    """`flow_all` grants everything the flow attached; `subset` narrows it.

    There is no "more" — a binding that could add sources would let whoever manages
    a link borrow the flow author's reading rights for something the author never
    attached.
    """

    mode: Literal["flow_all", "subset"] = "flow_all"
    doc_ids: list[int] = Field(default_factory=list)
    dataset_ids: list[int] = Field(default_factory=list)
    metric_names: list[str] = Field(default_factory=list)


class BudgetContract(_Model):
    max_llm_calls: int = Field(default=12, ge=1, le=60)
    max_tool_calls: int = Field(default=40, ge=1, le=200)
    max_seconds: int = Field(default=45, ge=5, le=120)


class DataContract(_Model):
    charts: ChartsScope = Field(default_factory=ChartsScope)
    resolve: dict[str, ResolveEntry] = Field(default_factory=dict)
    knowledge: KnowledgeContract = Field(default_factory=KnowledgeContract)
    capabilities: Capabilities = Field(default_factory=Capabilities)
    defaults: dict[str, Any] = Field(default_factory=dict)
    budget: BudgetContract = Field(default_factory=BudgetContract)


#: How many charts a bindingless TEST reads. Not a guess — measured: the ad-hoc
#: contract first shipped with `all_current`, and on a 70-chart report the reading
#: step spent all 40 tool calls and blew the 45-second ceiling before the answering
#: step got a turn. The run came back `failed` on a flow that was fine.
#:
#: Twelve, and the budget stays exactly what a real link gets. Raising the budget
#: for tests would have been the easier fix and the wrong one: the number an author
#: watches while iterating has to be the number a viewer will pay. So the SCOPE
#: shrinks, and the response says by how much.
AD_HOC_TEST_CHARTS = 12


def ad_hoc_contract(flow: "Flow", dashboard: Any = None) -> DataContract:
    """The contract a TEST uses when there is no link yet.

    WHY A TEST MAY SKIP THE LINK, WHEN A RUN MAY NOT.

    A published flow answers viewers through a binding, and that binding exists
    because two links over the same flow resolve their requirements differently —
    "does this flow work" is a question about a flow ON A LINK. But an author
    building a flow has no link yet, and demanding one first made the Test button
    refuse at the moment it was most useful: they had to assign an unfinished flow
    to a live public link to find out whether it worked at all.

    So a test gets a contract with nothing hidden in it:

      charts     the report's first `AD_HOC_TEST_CHARTS`, in tile order — enough to
                 tell whether the flow behaves, small enough to answer quickly.
                 See the constant above for why this is not "all of them".
      knowledge  whatever the FLOW attached, and nothing else. Not widened: the
                 delegation ceiling is the author's own reading rights either way.
      web        OFF. A test must not reach outside the deployment on a surface
                 whose whole purpose is to be run repeatedly while iterating.
      budget     the same defaults a new link gets, so the cost an author sees
                 while testing is the cost a viewer will pay.

    `resolve` stays EMPTY on purpose. Requirements are the one thing a link
    genuinely has to answer, and guessing them here would hand the author a green
    test that a real link then fails. `preflight` reports each one instead, and the
    test panel shows what ran empty — the honest version of the same convenience.
    """
    ids: list[int] = []
    for dc in (getattr(dashboard, "dashboard_charts", None) or []):
        cid = getattr(dc, "chart_id", None)
        if cid and cid not in ids:
            ids.append(cid)
        if len(ids) >= AD_HOC_TEST_CHARTS:
            break

    return DataContract(
        # A report with no charts at all falls back to `all_current`, which then
        # resolves to the empty list anyway — one less special case downstream.
        charts=ChartsScope(mode="allowlist", ids=ids) if ids
        else ChartsScope(mode="all_current", ids=[]),
        resolve={},
        knowledge=KnowledgeContract(mode="flow_all"),
        capabilities=Capabilities(web_search=False, read_rows=True),
        defaults={},
        budget=BudgetContract(),
    )


def ephemeral_binding(flow: "Flow", dashboard: Any) -> AgentFlowBinding:
    """A binding that is never saved, for a test against a bare report.

    Built rather than faked with a stub object so the test travels the SAME code
    path a real run does — `contract_of`, `build_binding_info`, the chart ceiling,
    the knowledge scope. A parallel "test mode" path is how a test comes to pass on
    something production does differently.

    `id` is 0, not None. `BindingInfo.id` in the envelope is a plain `int` by
    design — "a field that is present always has the same type" — and widening it to
    `int | None` would push a null into every consumer to serve one caller. Zero is
    the readable sentinel: no saved binding. `agent_flow_runs.binding_id` IS
    nullable, so the run row stores null there and the Runs tab shows the test like
    any other run, labelled as one.
    """
    return AgentFlowBinding(
        id=0,
        link_id=None,
        dashboard_id=getattr(dashboard, "id", None),
        brain_key=flow.key,
        status=ACTIVE,
        data_contract=ad_hoc_contract(flow, dashboard).model_dump(mode="json"),
        store_question_content=True,
    )


# ═══ Reading ══════════════════════════════════════════════════════════════════
def get_for_link(db: Session, link_id: int) -> AgentFlowBinding | None:
    return (
        db.query(AgentFlowBinding).filter(AgentFlowBinding.link_id == link_id).first()
    )


def list_for_flow(db: Session, brain_key: str) -> list[dict[str, Any]]:
    """Which links this flow serves.

    One indexed query. This used to mean loading EVERY active public link and
    parsing its `appearance_config` JSON, once per call and again per row of the
    flow list.
    """
    rows = (
        db.query(AgentFlowBinding, DashboardPublicLink)
        .join(DashboardPublicLink, DashboardPublicLink.id == AgentFlowBinding.link_id)
        .filter(AgentFlowBinding.brain_key == brain_key)
        .all()
    )
    out: list[dict[str, Any]] = []
    for binding, link in rows:
        cfg = link.appearance_config or {}
        out.append({
            "binding_id": binding.id,
            "link_id": link.id,
            "link_name": link.name,
            "token": link.token,
            "dashboard_id": link.dashboard_id,
            "status": binding.status,
            "pinned_version": binding.pinned_version,
            "bot_enabled": bool(isinstance(cfg, dict) and cfg.get("ai_bot_enabled")),
            "link_active": bool(link.is_active),
            "validated_at": binding.validated_at.isoformat() if binding.validated_at else None,
            "issues": (binding.last_validation or {}).get("errors", []),
            "warnings": (binding.last_validation or {}).get("warnings", []),
        })
    return out


def contract_of(binding: AgentFlowBinding) -> DataContract:
    try:
        return DataContract.model_validate(binding.data_contract or {})
    except Exception:  # noqa: BLE001
        logger.warning("[binding] %s has an unreadable contract", binding.id)
        return DataContract()


# ═══ Preflight — the gate that makes "define first" real ══════════════════════
def preflight(
    db: Session,
    *,
    flow: Flow,
    contract: DataContract,
    dashboard: Any,
    link: DashboardPublicLink | None = None,
) -> dict[str, Any]:
    """Can this flow be assigned to this link with this contract?

    Returns errors (assignment refused), warnings (allowed, but say so), and a
    worst-case cost estimate. The estimate is not decoration: this is a PUBLIC link
    with an unbounded audience, and a Loop multiplies one question by up to 25.
    """
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    chart_ids = {
        dc.chart_id for dc in (getattr(dashboard, "dashboard_charts", None) or []) if dc.chart_id
    }

    # 1 — every REQUIRED requirement must resolve.
    for req in flow.requirements.items:
        entry = contract.resolve.get(req.key)
        if entry is None:
            (errors if req.required else warnings).append({
                "code": "requirement_unresolved",
                "key": req.key,
                "message": (
                    f"Flow cần “{req.label or req.key}” ({req.kind}) nhưng link này "
                    "chưa chỉ ra nó ứng với cái gì."
                ),
            })
            continue
        if entry.chart_id and entry.chart_id not in chart_ids:
            errors.append({
                "code": "chart_not_on_dashboard",
                "key": req.key,
                "message": f"“{req.label or req.key}” trỏ tới biểu đồ {entry.chart_id} "
                           "không thuộc báo cáo của link này.",
            })

    # 2 — the allowlist may only contain charts of THIS dashboard.
    if contract.charts.mode == "allowlist":
        stray = [c for c in contract.charts.ids if c not in chart_ids]
        if stray:
            errors.append({
                "code": "chart_not_on_dashboard",
                "key": "charts",
                "message": f"Biểu đồ không thuộc báo cáo này: {', '.join(map(str, stray))}.",
            })
        if not contract.charts.ids:
            errors.append({
                "code": "no_charts",
                "key": "charts",
                "message": "Chưa chọn biểu đồ nào cho trợ lý đọc.",
            })

    # 3 — knowledge may only NARROW what the flow attached.
    if contract.knowledge.mode == "subset":
        flow_docs = {int(s.ref) for s in flow.bound_sources() if s.source == "document" and s.ref.isdigit()}
        flow_ds = {int(s.ref) for s in flow.bound_sources() if s.source == "semantic" and s.ref.isdigit()}
        flow_metrics = {s.ref for s in flow.bound_sources() if s.source == "metric"}
        for label, chosen, allowed in (
            ("tài liệu", set(contract.knowledge.doc_ids), flow_docs),
            ("bộ dữ liệu", set(contract.knowledge.dataset_ids), flow_ds),
            ("chỉ số", set(contract.knowledge.metric_names), flow_metrics),
        ):
            extra = chosen - allowed
            if extra:
                errors.append({
                    "code": "knowledge_widened",
                    "key": "knowledge",
                    "message": f"Link không thể cấp thêm {label} mà flow chưa gắn: "
                               f"{', '.join(map(str, sorted(extra)))}.",
                })

    # 4 — capabilities the flow will reach for.
    if flow.uses_capability("web_search") and not contract.capabilities.web_search:
        warnings.append({
            "code": "web_disabled",
            "key": "capabilities",
            "message": "Flow có bước tra cứu web nhưng link này đang tắt — bước đó sẽ bị bỏ qua.",
        })

    # 5 — a node pinned to a vendor the link has no key for fails on the first
    #     real question, in front of a viewer. Caught here instead.
    cfg = (link.appearance_config or {}) if link is not None else {}
    link_provider = str((cfg or {}).get("ai_bot_provider") or "").strip().lower()
    for node in flow.agent_nodes():
        if node.provider != "inherit" and not node.api_key_enc:
            if link_provider and node.provider != link_provider:
                warnings.append({
                    "code": "provider_mismatch",
                    "key": node.key,
                    "message": f"Bước “{node.name or node.key}” chạy trên {node.provider} "
                               f"nhưng link cấu hình {link_provider} và bước không có token riêng.",
                })

    # 6 — HOW LONG THIS WILL TAKE, on the model the link actually uses.
    #
    # Reasoning models spend tens of seconds per call before emitting a token. A
    # five-call flow on one of them is a minute and a half, and a viewer — or the
    # chat client's own patience — gives up long before that. Measured, not
    # theoretical: this flow ran in 16s on a fast model and 91s on gpt-5.
    estimate = estimate_cost(flow, chart_count=len(contract.charts.ids))
    link_model = str((cfg or {}).get("ai_bot_model") or "").strip().lower()
    seconds_each = next(
        (s for prefix, s in SECONDS_PER_CALL.items() if link_model.startswith(prefix)), 4
    )
    worst_seconds = estimate["max_llm_calls"] * seconds_each
    if worst_seconds > contract.budget.max_seconds:
        warnings.append({
            "code": "slow_model",
            "key": "runtime",
            "message": (
                f"Link đang dùng “{link_model or 'model mặc định'}”: {estimate['max_llm_calls']} "
                f"lần gọi model ≈ {worst_seconds}s, vượt hạn mức {contract.budget.max_seconds}s "
                "của link. Hãy giảm số vòng lặp, đổi model nhanh hơn, hoặc nâng hạn mức."
            ),
        })

    # 7 — DOES THE BUDGET FIT THE FLOW AT ALL?
    #
    # Two ways it can be too small, and they read very differently to whoever has
    # to fix them:
    #
    #   * the whole flow needs more than the link permits — the obvious case;
    #   * the FIXED reads alone eat the ceiling, so the answering step is refused
    #     even though the flow as designed is affordable. This one is the trap. A
    #     twelve-chart binding with a twelve-call ceiling spends everything inside
    #     the reading node, and the viewer gets "chưa tạo được câu trả lời" for a
    #     question the flow would have answered — with nothing on screen
    #     connecting that to a number typed on the binding form.
    fixed_tools = _fixed_read_cost(flow, per_read=(len(contract.charts.ids) + 2)
                                   if contract.charts.ids else 3)
    if estimate["max_tool_calls"] > contract.budget.max_tool_calls:
        warnings.append({
            "code": "budget_tight",
            "key": "budget",
            "message": (
                f"Flow có thể cần tới {estimate['max_tool_calls']} lượt công cụ "
                f"nhưng link chỉ cho {contract.budget.max_tool_calls}. "
                "Câu hỏi phức tạp sẽ bị cắt giữa chừng."
            ),
        })
    if fixed_tools >= contract.budget.max_tool_calls:
        warnings.append({
            "code": "budget_starves_answer",
            "key": "budget",
            "message": (
                f"Riêng các bước đọc báo cáo đã tốn ~{fixed_tools} lượt công cụ, "
                f"bằng hoặc hơn hạn mức {contract.budget.max_tool_calls} của link — "
                "bước trả lời sẽ không còn lượt nào và người xem sẽ không nhận được "
                f"câu trả lời. Hãy nâng hạn mức lên ít nhất "
                f"{fixed_tools + 4}, hoặc giảm số biểu đồ được cấp."
            ),
        })
    if estimate["max_llm_calls"] > contract.budget.max_llm_calls:
        warnings.append({
            "code": "budget_tight",
            "key": "budget",
            "message": (
                f"Flow có thể cần {estimate['max_llm_calls']} lượt gọi model "
                f"nhưng link chỉ cho {contract.budget.max_llm_calls}."
            ),
        })

    # 8 — authoring warnings travel with the assignment, so whoever assigns sees
    #     what the flow gives up rather than only what it needs.
    for w in flow.warnings():
        warnings.append({"code": "flow_warning", "key": "", "message": w})

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "estimate": {**estimate, "worst_seconds": worst_seconds},
        # WHICH KINDS OF QUESTION THIS FLOW CANNOT ANSWER.
        #
        # Not an error and not a warning — a flow narrowed on purpose is a good
        # flow. But the alternative to saying it here is the bot saying it in
        # production, badly: asked for anomalies with no diagnostic tool granted, it
        # answered "the report does not contain that information", which blamed the
        # data for a gap in the configuration and gave the author nothing to act on.
        "coverage": coverage_of(flow),
        "resolved": sorted(contract.resolve.keys()),
        "unresolved": [
            r.key for r in flow.requirements.items if r.key not in contract.resolve
        ],
    }


def _fixed_read_cost(flow: Flow, *, per_read: int) -> int:
    """What the flow spends before any question-specific work.

    Only the reading nodes at the TOP level: those run on (almost) every turn
    regardless of what was asked, so their cost is the floor an answering step
    has to fit above. Nodes inside a branch are excluded — they are conditional
    by construction, and counting them would make every branching flow look
    starved.
    """
    return sum(
        per_read for n in flow.nodes
        if getattr(n, "type", "") in {"report_read", "knowledge"}
    )


def estimate_cost(flow: Flow, *, chart_count: int = 0) -> dict[str, int]:
    """Worst case for ONE question, walking the tree.

    A loop multiplies its body; a branch takes the most expensive path, because that
    is the one that can happen. Shown at assign time — on a public link the person
    approving this is committing to it for an unbounded audience.

    `chart_count` is how many charts the BINDING allows, because that is what
    decides a `report_read`'s cost: it reads the report chart by chart, so a
    binding of twelve charts is twelve calls, not the flat three this used to
    assume. That undercount had teeth — a flow bound to twelve charts was
    estimated at 3 tool calls, given a ceiling of 12, and spent all twelve inside
    the reading node; the answering step then had nothing left and the viewer got
    "chưa tạo được câu trả lời" for a question the flow could answer perfectly.
    Zero keeps the old flat assumption, for callers validating a flow that is not
    bound to anything yet.
    """
    #: A read costs one call per chart, plus a couple for filters and the chart
    #: list. Falls back to the historical flat figure when nothing says how many
    #: charts are in play — wrong, but wrong in the direction it always was.
    per_read = (chart_count + 2) if chart_count else 3

    def cost(nodes: list[Any]) -> tuple[int, int]:
        llm = tools = 0
        for n in nodes:
            if isinstance(n, AgentNode):
                # ONE CALL PER NODE IS WRONG WHEN THE NODE HAS TOOLS. Every tool
                # round is another model call — ask, run the tool, ask again — so an
                # agent granted N tool calls can cost up to N+1. Counting 1 made a
                # flow estimated at 9 calls actually spend 12 and get cut off before
                # it answered, and an estimate that is wrong DOWNWARD is the one
                # direction that matters: it is what the person assigning a public
                # link is committing to.
                rounds = 1 + (n.max_tool_calls if n.tools else 0)
                llm += rounds
                tools += n.max_tool_calls if n.tools else 0
            elif n.type == "report_read":
                tools += per_read
            elif n.type in {"knowledge", "web"}:
                tools += 3
            if isinstance(n, LoopNode):
                bl, bt = cost(list(n.body))
                llm += bl * n.max_iterations
                tools += bt * n.max_iterations
            elif n.type == "if":
                branches = [cost(list(p.body)) for p in n.paths] or [(0, 0)]
                best = max(branches, key=lambda x: x[0] * 10 + x[1])
                llm += best[0]
                tools += best[1]
            elif n.type == "switch":
                branches = [cost(list(c.body)) for c in n.cases] + [cost(list(n.fallback))]
                best = max(branches or [(0, 0)], key=lambda x: x[0] * 10 + x[1])
                llm += best[0]
                tools += best[1]
        return llm, tools

    llm, tools = cost(list(flow.nodes))
    return {"max_llm_calls": llm, "max_tool_calls": tools}


# ═══ Writing ══════════════════════════════════════════════════════════════════
def save_binding(
    db: Session,
    *,
    link: DashboardPublicLink,
    dashboard: Any,
    flow: Flow,
    contract: DataContract,
    pinned_version: int | None,
    actor_email: str,
    store_question_content: bool = True,
) -> tuple[AgentFlowBinding, dict[str, Any]]:
    """Validate then write. A contract with errors is REFUSED, not stored as broken.

    Storing it would leave a link pointing at something that cannot run and would
    make "assigned" mean two different things.
    """
    result = preflight(db, flow=flow, contract=contract, dashboard=dashboard, link=link)
    if not result["ok"]:
        raise BindingError(422, result["errors"][0]["message"])

    from datetime import datetime, timezone

    binding = get_for_link(db, link.id)
    if binding is None:
        binding = AgentFlowBinding(link_id=link.id)
        db.add(binding)

    binding.dashboard_id = link.dashboard_id
    binding.brain_key = flow.key
    binding.pinned_version = pinned_version
    binding.data_contract = contract.model_dump(mode="json")
    binding.status = ACTIVE
    binding.last_validation = {"errors": [], "warnings": result["warnings"]}
    binding.validated_at = datetime.now(timezone.utc)
    binding.store_question_content = bool(store_question_content)
    binding.created_by = binding.created_by or actor_email

    # NO MIRROR ON THE LINK. This used to also write
    # `appearance_config.ai_bot_flow_key` so callers written before bindings kept
    # working. There are none left: `dispatch.resolve_for_link` reads the binding
    # and has no fallback, and migration `20260814_0046` removed the stale copies.
    # Writing it again would recreate a second apparent source of truth that
    # nothing consults — the kind of leftover that makes the next reader guess.
    db.commit()
    db.refresh(binding)
    return binding, result


def mark_broken(db: Session, binding: AgentFlowBinding, reason: str) -> None:
    binding.status = BROKEN
    binding.last_validation = {
        "errors": [{"code": "drift", "key": "", "message": reason}],
        "warnings": (binding.last_validation or {}).get("warnings", []),
    }
    db.commit()


def cheap_validate(binding: AgentFlowBinding, dashboard: Any) -> str:
    """The check every run pays for: are the declared charts still there?

    Deliberately cheap — id membership, no queries. A dashboard changes under a
    binding all the time (a chart deleted, a page rebuilt), and the answer to that
    is to STOP, not to quietly read whatever is left.
    """
    contract = contract_of(binding)
    if contract.charts.mode == "all_current":
        return ""
    live = {
        dc.chart_id for dc in (getattr(dashboard, "dashboard_charts", None) or []) if dc.chart_id
    }
    missing = [c for c in contract.charts.ids if c not in live]
    if missing:
        return (
            "Báo cáo đã thay đổi: biểu đồ "
            f"{', '.join(map(str, missing))} không còn nữa."
        )
    for key, entry in contract.resolve.items():
        if entry.chart_id and entry.chart_id not in live:
            return f"Báo cáo đã thay đổi: “{key}” trỏ tới biểu đồ không còn tồn tại."
    return ""


# ═══ Turning a binding into the envelope's `binding` block ════════════════════
def build_binding_info(
    binding: AgentFlowBinding,
    *,
    flow: Flow,
    report: Any,
    link_token: str,
    version: int,
    ctx: Any = None,
) -> BindingInfo:
    """What the run actually gets. The ONE place the ceiling is computed."""
    contract = contract_of(binding)

    live_ids = [c.id for c in report.charts]
    if contract.charts.mode == "all_current":
        allowed = live_ids
    else:
        allowed = [c for c in contract.charts.ids if c in live_ids]

    if contract.knowledge.mode == "flow_all":
        knowledge = KnowledgeScope(
            doc_ids=[int(s.ref) for s in flow.bound_sources() if s.source == "document" and s.ref.isdigit()],
            dataset_ids=[int(s.ref) for s in flow.bound_sources() if s.source == "semantic" and s.ref.isdigit()],
            metric_names=[s.ref for s in flow.bound_sources() if s.source == "metric"],
        )
    else:
        knowledge = KnowledgeScope(
            doc_ids=list(contract.knowledge.doc_ids),
            dataset_ids=list(contract.knowledge.dataset_ids),
            metric_names=list(contract.knowledge.metric_names),
        )

    resolved: dict[str, ResolvedRef] = {}
    needs_values = _requirements_looped_over(flow)
    for key, entry in contract.resolve.items():
        ref = ResolvedRef(
            kind=entry.kind,
            chart_id=entry.chart_id,
            field=entry.field,
            label=entry.label,
            ref=entry.ref,
            values=list(entry.values),
        )
        if not ref.values and key in needs_values and entry.kind == "dimension" and ctx is not None:
            ref.values = _distinct_values(ctx, entry)
        resolved[key] = ref

    return BindingInfo(
        id=binding.id,
        link_token=link_token,
        flow_version=version,
        resolved=resolved,
        unresolved=[r.key for r in flow.requirements.items if r.key not in resolved],
        allowed_chart_ids=allowed,
        knowledge=knowledge,
        capabilities=Capabilities.model_validate(contract.capabilities.model_dump()),
        defaults=dict(contract.defaults),
    )


def _requirements_looped_over(flow: Flow) -> set[str]:
    """Which requirements a Loop walks.

    Only these need their values fetched. Reading distinct values for every mapped
    dimension on every turn would be a warehouse query per requirement per question,
    to populate variables most flows never iterate.
    """
    import re

    out: set[str] = set()
    for n in flow.all_nodes():
        if isinstance(n, LoopNode):
            for m in re.finditer(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}", n.over or ""):
                out.add(m.group(1).split(".")[0])
    return out


def _distinct_values(ctx: Any, entry: ResolveEntry) -> list[Any]:
    """Read the values a Loop will walk, through the normal chart-data path.

    Not a bespoke query: the same tool an agent would call, so the report's public
    filters are already merged in — a loop over segments must walk the segments the
    VIEWER can see, not every segment in the warehouse.
    """
    if not entry.chart_id or not entry.field:
        return []
    try:
        from app.services.agent_flows.tools import registry as tool_registry

        result = tool_registry.execute(
            ctx, "get_chart_data", {"chart_id": entry.chart_id, "top_n": 200}, allowed=None
        )
        return _column_values((result or {}).get("data"), entry.field)[:50]
    except Exception:  # noqa: BLE001
        logger.warning("[binding] could not read values for %s", entry.field)
        return []


def _column_values(data: Any, field: str) -> list[Any]:
    """Pull one column out of a chart-data payload, WHICHEVER SHAPE IT ARRIVES IN.

    `get_chart_data` returns columnar data — `{"columns": [...], "rows": [[...]]}` —
    while other paths in this codebase return a list of row dicts. Reading only the
    dict shape produced no values at all here, and an empty list then fell back to
    the requirement's LABEL: a Loop over `{{segments}}` iterated the single string
    "Danh mục" and the flow analysed the name of the field instead of the data in
    it, reporting a clean "Loop×1" while doing so.
    """
    if isinstance(data, dict):
        columns = data.get("columns")
        rows = data.get("rows")
        if isinstance(columns, list) and isinstance(rows, list):
            try:
                idx = columns.index(field)
            except ValueError:
                # Fall back to the unqualified name: a binding may store
                # `table.col` while the payload labels the column `col`.
                leaf = field.split(".")[-1]
                idx = next(
                    (i for i, c in enumerate(columns) if str(c).split(".")[-1] == leaf),
                    -1,
                )
            if idx < 0:
                return []
            out: list[Any] = []
            for row in rows:
                if not isinstance(row, (list, tuple)) or idx >= len(row):
                    continue
                v = row[idx]
                if v is not None and v not in out:
                    out.append(v)
            return out
        data = data.get("data")

    if isinstance(data, list):
        out2: list[Any] = []
        leaf = field.split(".")[-1]
        for row in data:
            if not isinstance(row, dict):
                continue
            v = row.get(field, row.get(leaf))
            if v is not None and v not in out2:
                out2.append(v)
        return out2
    return []
