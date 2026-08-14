"""The contract between the AI Bot and the Flow engine. ONE shape in, ONE shape out.

WHY THIS FILE EXISTS
--------------------
The engine used to be called like this:

    run_brain(brain=, ctx=, api_key=, link_provider=, link_model=, question=,
              history=, web_enabled=, base_system_prompt=)
    ctx.knowledge_scope = run_scope(...)     # patched mid-flight, in the caller

Nine loose arguments plus a shared mutable object the caller reached into while the
run was being set up. That IS an envelope — just spread out, undocumented, and
impossible to store, replay or hand to a second caller. This file makes it a value.

FOUR RULES. Each one is a failure this codebase has already paid for.

  L1  ABSENT MEANS ABSENT, NEVER A DIFFERENT SHAPE.
      A field may be missing or null. A field that is PRESENT always has the same
      type. `get_chart_data` once returned `list[dict]` in one path and
      `{"columns": [...], "rows": [...]}` in another, and the bot broke on the
      second one — optional is fine, polymorphic is not.

  L2  ADDITIVE ONLY, AND CONSUMERS IGNORE WHAT THEY DON'T KNOW.
      `schema_version` is mandatory. Adding a field is free; removing one or
      changing its type bumps the version. Every model here is `extra="ignore"` so
      a newer producer never breaks an older consumer.

  L3  EVERYTHING THE FLOW NEEDS IS IN HERE.
      No reaching into the DB for context, no globals, no mutating a shared object
      halfway through. This is what makes a test a POSTed envelope, and a replay a
      stored one — see `docs/Intelligence/agent_flow_io_envelope_v1.md`.

  L4  SAFE TO STORE.
      The input envelope is written to the runs table so a run can be replayed
      against a later version. So it carries a provider NAME and never a key. The
      credential is resolved by the runtime, beside the call, and never travels.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

#: Bumped only for a breaking change (field removed, or its type changed).
SCHEMA_VERSION = 1


class _Model(BaseModel):
    """Base for every envelope model: unknown fields are dropped, not rejected (L2)."""

    model_config = ConfigDict(extra="ignore")


# ═══════════════════════════════════════════════════════════════════════════════
# INPUT
# ═══════════════════════════════════════════════════════════════════════════════
Trigger = Literal["public_chat", "studio_test", "node_test", "replay", "scheduled"]


class RequestInfo(_Model):
    """Who is asking, when, and on whose behalf this run happens."""

    id: str
    at: str = ""
    locale: str = "vi"
    #: Author's own trial. Test runs are recorded but EXCLUDED from every statistic —
    #: without this flag the first week of a flow's numbers is mostly its author.
    is_test: bool = False
    trigger: Trigger = "public_chat"


class QuestionInfo(_Model):
    raw: str
    #: Guard-normalised form. Falls back to `raw` so a caller that has no normaliser
    #: still produces a valid envelope.
    normalized: str = ""
    turn_index: int = 0

    def text(self) -> str:
        return (self.normalized or self.raw or "").strip()


class Turn(_Model):
    role: Literal["user", "assistant"]
    content: str = ""


class ConversationInfo(_Model):
    session_key: str = ""
    history: list[Turn] = Field(default_factory=list)


class FieldRef(_Model):
    """One measure or dimension as the report itself describes it."""

    field: str
    label: str = ""


class ChartInfo(_Model):
    id: int
    title: str = ""
    chart_type: str = ""
    description: str = ""
    measures: list[FieldRef] = Field(default_factory=list)
    dimensions: list[FieldRef] = Field(default_factory=list)


class PageInfo(_Model):
    id: str
    name: str = ""
    chart_ids: list[int] = Field(default_factory=list)


class ReportInfo(_Model):
    """The report BEING VIEWED, described rather than named.

    A flow reads this; it never asks for a report by name. That is the whole reason
    one flow can serve links its author never saw.
    """

    dashboard_id: int
    name: str = ""
    description: str = ""
    charts: list[ChartInfo] = Field(default_factory=list)
    pages: list[PageInfo] = Field(default_factory=list)

    def chart(self, chart_id: int) -> ChartInfo | None:
        for c in self.charts:
            if c.id == chart_id:
                return c
        return None


class AppliedFilter(_Model):
    field: str
    op: str = "in"
    values: list[Any] = Field(default_factory=list)
    scope: str = ""


class FiltersInfo(_Model):
    applied: list[AppliedFilter] = Field(default_factory=list)
    #: Stable hash of what is applied. Part of the memory fingerprint, so a viewer
    #: changing a slicer invalidates facts derived under the old one.
    fingerprint: str = ""


class ResolvedRef(_Model):
    """One of the flow's requirements, ALREADY resolved against THIS link's report.

    The flow says "I need a revenue measure". The binding says "on this dashboard
    that is chart 41, field `total_revenue`". This is the answer, carried in.
    Without it `{{revenue}}` only works on a dashboard that happens to spell the
    field the same way — the same trap the workboard template importer had to fix.
    """

    kind: Literal["measure", "dimension", "chart", "document", "dataset", "metric", "value"]
    chart_id: int | None = None
    field: str = ""
    label: str = ""
    ref: str = ""
    #: Pre-resolved distinct values, when the binding could compute them cheaply.
    #: A Loop over `{{segments}}` needs the list, not the field name.
    values: list[Any] = Field(default_factory=list)


class Capabilities(_Model):
    web_search: bool = False
    read_rows: bool = True
    max_rows_per_call: int = 5000
    #: The most tokens ONE tool result may carry, before it reaches a prompt.
    #:
    #: A single fixed number was the first version of this and it was wrong in
    #: both directions: high enough to let a public link burn a fortune, low
    #: enough to block an internal digest that legitimately needs a wide read.
    #: The right ceiling is a property of the DEPLOYMENT, not of the code — a
    #: public link answering viewer questions and a scheduled analysis over the
    #: same data want different numbers — so it belongs beside the other things a
    #: binding declares before a flow is assigned.
    #:
    #: 25,000 is the default because the largest legitimate result measured
    #: across every dashboard here (a 70-chart `list_charts` in full detail) is
    #: ~15,600, so it clears real work with room and still refuses the
    #: 2,979,000-token result that prompted the guard.
    max_result_tokens: int = 25_000


class KnowledgeScope(_Model):
    doc_ids: list[int] = Field(default_factory=list)
    dataset_ids: list[int] = Field(default_factory=list)
    metric_names: list[str] = Field(default_factory=list)


class BindingInfo(_Model):
    """The data contract of ONE link: what was defined BEFORE the flow was assigned.

    Nothing here is inferred at run time. If a value is missing the run is refused —
    that is the point. A flow that quietly widens its own reach because a field was
    absent is the failure this whole design exists to prevent.
    """

    id: int
    link_token: str = ""
    flow_version: int = 0
    resolved: dict[str, ResolvedRef] = Field(default_factory=dict)
    #: Optional requirements the binding could not satisfy. Named rather than
    #: dropped, so a flow can branch on "no benchmark available" instead of failing.
    unresolved: list[str] = Field(default_factory=list)
    #: The CEILING on what any tool may read. Intersected into
    #: `ToolContext.allowed_chart_ids` before the first node runs.
    allowed_chart_ids: list[int] = Field(default_factory=list)
    knowledge: KnowledgeScope = Field(default_factory=KnowledgeScope)
    capabilities: Capabilities = Field(default_factory=Capabilities)
    defaults: dict[str, Any] = Field(default_factory=dict)


class MemoryInfo(_Model):
    """What this session already established, carried into the next turn.

    SERVER-OWNED. It never comes from a request body: `ai_chat_sessions.conv_state`
    is client-supplied on a public unauthenticated endpoint, so putting flow
    variables there would let a viewer set `{{revenue}}` and have it flow into
    prompts, branch conditions and tool arguments.
    """

    fingerprint: str = ""
    vars: dict[str, Any] = Field(default_factory=dict)
    #: Node keys whose stored output is still valid for this fingerprint. A node
    #: with `run_policy != every_turn` listed here is reused instead of re-run.
    reusable_nodes: list[str] = Field(default_factory=list)


class Budget(_Model):
    """Ceilings for the whole run, not per step.

    Per-step `max_tool_calls` stopped being a bound the moment Loop existed: a loop
    of 25 over one agent is 25 model calls and 200 tool calls for ONE question.
    """

    max_llm_calls: int = 12
    max_tool_calls: int = 40
    max_seconds: int = 45


class RuntimeInfo(_Model):
    """What a step that inherits its model falls back to. Never a credential (L4)."""

    provider: str = ""
    model: str = ""
    budget: Budget = Field(default_factory=Budget)


class FlowInput(_Model):
    """Everything a flow run needs, and nothing it must reach outside for."""

    schema_version: int = SCHEMA_VERSION
    request: RequestInfo
    question: QuestionInfo
    conversation: ConversationInfo = Field(default_factory=ConversationInfo)
    report: ReportInfo
    filters: FiltersInfo = Field(default_factory=FiltersInfo)
    binding: BindingInfo
    memory: MemoryInfo = Field(default_factory=MemoryInfo)
    runtime: RuntimeInfo = Field(default_factory=RuntimeInfo)

    def seed_vars(self) -> dict[str, Any]:
        """The variables a run starts with, lowest precedence first.

        defaults → resolved requirements → session memory. Memory wins because it is
        this session's own established fact; a default that overwrote it would make
        the second turn contradict the first.
        """
        out: dict[str, Any] = dict(self.binding.defaults)
        for key, ref in self.binding.resolved.items():
            if ref.kind == "dimension":
                # A dimension IS its set of values. Falling back to the label when
                # none were read made `{{segments}}` the string "Danh mục", and a
                # Loop over it then ran once over the NAME of the field — a flow
                # that looked like it worked and analysed nothing.
                out[key] = list(ref.values)
            else:
                out[key] = ref.values if ref.values else (ref.label or ref.field or ref.ref)
            out[f"{key}__ref"] = ref.model_dump(mode="json")
        out.update(self.memory.vars)
        out["question"] = self.question.text()
        out["available_metrics"] = sorted(
            {m.field for c in self.report.charts for m in c.measures}
        )
        out["available_dimensions"] = sorted(
            {d.field for c in self.report.charts for d in c.dimensions}
        )
        return out


# ═══════════════════════════════════════════════════════════════════════════════
# OUTPUT — typed blocks, because the bot has to RENDER this, not print it
# ═══════════════════════════════════════════════════════════════════════════════
class SourceRef(_Model):
    chart_id: int | None = None
    doc_id: int | None = None
    metric: str = ""


class TextBlock(_Model):
    type: Literal["text"] = "text"
    markdown: str = ""


class Delta(_Model):
    value: float
    format: str = "percent"
    direction: Literal["up", "down", "flat"] = "flat"


class MetricBlock(_Model):
    type: Literal["metric"] = "metric"
    label: str = ""
    value: Any = None
    format: str = "number"
    delta: Delta | None = None
    source: SourceRef | None = None


class Column(_Model):
    key: str
    label: str = ""
    format: str = "text"


class TableBlock(_Model):
    type: Literal["table"] = "table"
    columns: list[Column] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    source: SourceRef | None = None


class Highlight(_Model):
    field: str = ""
    values: list[Any] = Field(default_factory=list)


class ChartRefBlock(_Model):
    """Point at a chart the viewer ALREADY has on screen, and highlight the part
    being discussed.

    The most valuable block and the easiest to forget: the bot is answering ON the
    dashboard, so the best answer is usually not a re-drawn number — it is "look at
    this chart, this segment".
    """

    type: Literal["chart_ref"] = "chart_ref"
    chart_id: int
    highlight: Highlight | None = None
    caption: str = ""


class CalloutBlock(_Model):
    type: Literal["callout"] = "callout"
    level: Literal["info", "warning", "danger"] = "info"
    text: str = ""


class FollowupsBlock(_Model):
    type: Literal["followups"] = "followups"
    items: list[str] = Field(default_factory=list)


#: SEVEN block types in v1, on purpose. Every new type is frontend work, so one is
#: added when there is a screen that renders it — not in advance.
Block = Annotated[
    Union[
        TextBlock,
        MetricBlock,
        TableBlock,
        ChartRefBlock,
        CalloutBlock,
        FollowupsBlock,
    ],
    Field(discriminator="type"),
]


class Citation(_Model):
    kind: Literal["chart", "document", "metric", "dataset", "web"]
    ref: str
    label: str = ""
    used: list[str] = Field(default_factory=list)
    quote: str = ""
    url: str = ""


class Notice(_Model):
    """Something the viewer should be told about the ANSWER ITSELF.

    `memory_reset` is the one that matters: when the fingerprint changes the numbers
    are recomputed, and silently showing a different figure from the one given two
    minutes ago is how a bot loses trust it cannot win back.
    """

    code: str
    text: str = ""


class MemoryDelta(_Model):
    """What the run wants remembered for the next turn. Applied by the runtime to
    the SERVER-side store; never echoed to the client."""

    set: dict[str, Any] = Field(default_factory=dict)
    unset: list[str] = Field(default_factory=list)
    fingerprint: str = ""


class TraceStep(_Model):
    key: str
    type: str = ""
    name: str = ""
    #: `reused` is a first-class outcome, not a flavour of ok. A Runs table that
    #: reports a reused node as "ran" is lying about what the turn cost.
    status: Literal["ok", "error", "skipped", "reused", "blocked"] = "ok"
    ms: int = 0
    branch: str = ""
    iteration: int | None = None
    tool_calls: list[str] = Field(default_factory=list)
    #: What this node was HANDED — the variables it could read when it started.
    #: Kept beside the output because a step that answered badly and a step that
    #: was given nothing to answer from are indistinguishable from the output
    #: alone, and telling those apart is the whole point of opening a run.
    input_preview: str = ""
    output_preview: str = ""
    error: str = ""
    #: What this node cost. Recorded per node because a turn's total says a flow is
    #: expensive without saying WHICH step made it so — and the answer is usually
    #: one node pasting a large context it did not need.
    prompt_tokens: int = 0
    completion_tokens: int = 0


class Trace(_Model):
    path: str = ""
    steps: list[TraceStep] = Field(default_factory=list)


class Usage(_Model):
    llm_calls: int = 0
    tool_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    ms: int = 0


class Answer(_Model):
    blocks: list[Block] = Field(default_factory=list)

    def plain_text(self) -> str:
        """The answer as text, for logs and for clients that cannot render blocks."""
        out: list[str] = []
        for b in self.blocks:
            if isinstance(b, TextBlock):
                out.append(b.markdown)
            elif isinstance(b, CalloutBlock):
                out.append(b.text)
            elif isinstance(b, MetricBlock):
                out.append(f"{b.label}: {b.value}")
        return "\n\n".join(x for x in out if x).strip()


RunStatus = Literal["ok", "partial", "blocked", "failed"]


class FlowOutput(_Model):
    """What the bot receives and turns into a screen.

    `answer.blocks` is the ONLY part a viewer ever sees. `trace`, `usage` and
    `memory_delta` are for the Runs tab and the session store, and a client that
    renders them is a bug.
    """

    schema_version: int = SCHEMA_VERSION
    run_id: str = ""
    status: RunStatus = "ok"
    answer: Answer = Field(default_factory=Answer)
    citations: list[Citation] = Field(default_factory=list)
    notices: list[Notice] = Field(default_factory=list)
    memory_delta: MemoryDelta = Field(default_factory=MemoryDelta)
    trace: Trace = Field(default_factory=Trace)
    usage: Usage = Field(default_factory=Usage)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


# ═══════════════════════════════════════════════════════════════════════════════
# Constructors — so no caller hand-builds a shape and gets it subtly wrong
# ═══════════════════════════════════════════════════════════════════════════════
def text_answer(markdown: str) -> Answer:
    """Wrap plain prose as the one-block answer.

    This is what keeps the simple case simple: an author who writes an ordinary
    prompt gets a valid structured answer for free, and only opts into blocks when
    they actually want a table or a chart reference.
    """
    return Answer(blocks=[TextBlock(markdown=markdown or "")])


def blocked(run_id: str, message: str, code: str = "not_configured") -> FlowOutput:
    """A run that never started, said plainly.

    Deliberately NOT an error and NOT an empty answer: a viewer facing a bot that
    was never configured deserves a sentence, and the operator deserves a row in
    Runs saying why.
    """
    return FlowOutput(
        run_id=run_id,
        status="blocked",
        answer=text_answer(message),
        notices=[Notice(code=code, text=message)],
    )


def failed(run_id: str, message: str) -> FlowOutput:
    return FlowOutput(
        run_id=run_id,
        status="failed",
        answer=text_answer(message),
        notices=[Notice(code="run_failed", text=message)],
    )
