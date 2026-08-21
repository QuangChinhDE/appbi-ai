"""What an Agent Flow IS. The runtime contract, written before any UI.

WHY THIS FILE COMES FIRST
-------------------------
The module this replaces was built the other way round: ten node types with
generated forms and a palette, while the executor could only run one of them.
Adding an HTTP node and publishing produced an agent node with an empty prompt —
wrong, and silent. So nothing appears in a builder until the executor handles it,
and this file is the list of what the executor handles.

WHAT A FLOW IS
--------------
A named, versioned, SHAREABLE recipe for turning a viewer's question into an
answer. It is a first-class resource, the way a Dataset or a Dashboard is — not a
setting hanging off a public link. Any number of links may point at the same flow;
a flow never knows which link or which report it will serve.

That independence has one hard consequence: A FLOW MUST NOT NAME A REPORT. It
declares what it NEEDS (`requirements`), and the link's binding says what those
needs resolve to on that dashboard. A prompt written as "đọc báo cáo Olist" runs
correctly in exactly one place and quietly misleads everywhere else.

WHY A TREE AND NOT A NODE+EDGE GRAPH
------------------------------------
Branches are nested bodies, and a branch that ends simply continues with the next
sibling. Merging is therefore implicit and UNREPRESENTABLE-WRONG: there is no
dangling edge, no orphan node, no accidental cycle, so none of those need
validating or rendering. The price is that there are no arbitrary jumps — which
the builder does not offer either.

KNOWLEDGE
---------
A flow attaches knowledge that already lives in AppBI — Knowledge Documents, a
Dataset's Semantic Model, and Governed KPI definitions. Each attachment carries WHEN
TO CONSULT IT, and that description is required: faced with a report the flow was
never written for, the model reads the description and declines to open the source.

PERMISSIONS
-----------
  authoring   What may I attach?      → my own rights, enforced server-side.
  assigning   Which flow on my link?  → whether the flow is shared with me.
  running     What may it read?       → author's CURRENT rights ∩ the binding.

Sharing a flow DELEGATES its author's reading rights; the binding can only ever
narrow them further. Both halves are re-checked at run time, so rights lost after
publishing take effect immediately.
"""
from __future__ import annotations

import logging
import re
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.agent_flows.models_catalogue import INHERIT, MODELS, known_model

logger = logging.getLogger(__name__)

#: Where a piece of attached knowledge comes from. Every kind here already exists
#: in the product; none was invented for this contract, because standing up a new
#: knowledge store when the app already has one is how two answers to one question
#: get created.
#:
#: `term` WAS MISSING, and the comment that used to sit here said there was no
#: fourth store. There is: `glossary_terms`, the company's own vocabulary. Its
#: absence meant an author could attach the DOCUMENT that mentions a term and the
#: METRIC that measures it, but never the definition itself — so "what do we mean
#: by GMV" was the one question the knowledge node could not be pointed at.
KnowledgeSourceKind = Literal["document", "semantic", "metric", "term"]

#: Total nodes anywhere in the tree. Not a quality opinion — depth is the author's
#: call — but the point past which one turn's budget could not fund the flow.
MAX_NODES = 40

#: How deeply bodies may nest (an IF inside a Loop inside an IF is depth 3).
#: Past this the canvas stops being readable and the cost stops being predictable.
MAX_DEPTH = 4

#: Ceiling on one Loop's iterations. The single most expensive number in the
#: contract: a loop of N over an agent is N model calls for ONE question.
MAX_LOOP_ITERATIONS = 25

#: Ceiling on one node's tool-call budget. Exported so the builder bounds its input
#: to the same number instead of guessing one and discovering the difference as a 422.
MAX_TOOL_CALLS = 30

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


# ═══ Pieces shared by several node types ══════════════════════════════════════
class ToolGrant(_Model):
    """One tool this node may call, and when to reach for it.

    Tools are granted PER NODE, from a list the author picks. An earlier design
    bundled them into five fixed agent "kinds", which re-closed the thing worth
    opening. `note` goes to the model with the tool name, so an author can say
    "only for questions about trends" without writing a prompt paragraph about it.
    """

    tool: str
    note: str = ""

    @field_validator("tool")
    @classmethod
    def _named(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("tool name is required")
        return v


class KnowledgeAttachment(_Model):
    """One source this node may consult, and WHEN.

    `ref` is the source's id in its own store: a document id, a dataset id, a metric
    machine name, a glossary term's FQN (`bộ-từ-điển.thuật-ngữ`). One string for
    every kind, rather than a nullable column each.
    """

    source: KnowledgeSourceKind
    ref: str
    #: Required. An attachment with no description tells the model what it MAY open
    #: and never why — so on a report this flow was not written for, it opens the
    #: wrong source or none.
    description: str

    @field_validator("ref")
    @classmethod
    def _ref_present(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("knowledge ref is required")
        return v

    @field_validator("description")
    @classmethod
    def _described(cls, v: str) -> str:
        v = (v or "").strip()
        if len(v) < 10:
            raise ValueError(
                "mỗi nguồn tri thức phải nói rõ nó chứa gì và khi nào nên tra"
            )
        return v


#: The operators a branch condition may use. STRUCTURED on purpose: the builder
#: renders field / operator / value, so there is no free-form expression to
#: sandbox, nothing to inject, and testing a condition is pure evaluation.
ConditionOp = Literal[
    "contains", "not_contains",
    "equals", "not_equals",
    "gt", "gte", "lt", "lte",
    "is_empty", "is_not_empty",
    "matches", "in_list",
]


class Condition(_Model):
    """`left <op> right`, where both sides may be templates (`{{var}}`)."""

    left: str
    op: ConditionOp = "equals"
    right: str = ""

    @field_validator("left")
    @classmethod
    def _left_present(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("điều kiện phải có vế trái")
        return v


class RetryPolicy(_Model):
    """Retry is a PROPERTY of a node, not a node of its own.

    A "Retry node" in a palette has to name what it retries, which is a second place
    to record the graph and a second thing to keep in step with it.
    """

    max_attempts: int = Field(default=2, ge=1, le=5)
    backoff_seconds: float = Field(default=1.0, ge=0, le=30)
    on: Literal["error", "empty", "either"] = "error"


#: How often a node runs across the turns of ONE conversation.
#:
#: Explicit rather than inferred from "does the variable already have a value".
#: Inferred skipping is control flow that does not appear on the canvas, and the
#: only way to debug it is to guess.
RunPolicy = Literal["every_turn", "once_per_session", "when_stale"]

#: How much of the conversation a node's model sees. The engine used to hand the
#: FULL history to EVERY step: a ten-node flow paid for the transcript ten times,
#: and a switch condition does not need the pleasantries.
ContextPolicy = Literal["none", "question", "last_3", "full"]


# ═══ Nodes ════════════════════════════════════════════════════════════════════
class BaseNode(_Model):
    key: str
    name: str = ""
    #: Where this node's result is published for later nodes to read as `{{var}}`.
    #: Empty means the result is still available as `{{outputs.<key>}}` but is not
    #: given a friendly name.
    output_var: str = ""
    run_policy: RunPolicy = "every_turn"
    context_policy: ContextPolicy = "none"
    retry: RetryPolicy | None = None
    #: What happens when this node raises. `continue` matches the old hardcoded
    #: behaviour (log and carry on); `stop` ends the run with what it has.
    on_error: Literal["continue", "stop"] = "continue"
    #: Author's note. Never sent to a model — this is for the next human.
    comment: str = ""

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError(
                "node key phải là chữ thường/số/gạch dưới và bắt đầu bằng chữ"
            )
        return v

    @field_validator("output_var")
    @classmethod
    def _valid_var(cls, v: str) -> str:
        v = (v or "").strip()
        if v and not _KEY_RE.match(v):
            raise ValueError(
                f"tên biến '{v}' không hợp lệ — dùng chữ thường/số/gạch dưới"
            )
        return v

    @model_validator(mode="after")
    def _memory_needs_somewhere_to_live(self) -> "BaseNode":
        """A node that is meant to be reused across turns must publish something.

        Without an `output_var` there is nothing to remember, so the policy would
        silently mean "run every turn" — a setting that reads as configured and does
        nothing is worse than no setting.
        """
        if self.run_policy != "every_turn" and not self.output_var:
            raise ValueError(
                f"bước “{self.name or self.key}” đặt chế độ nhớ qua lượt thì phải có "
                "Output variable — không có biến thì không có gì để nhớ"
            )
        return self


class AgentNode(BaseNode):
    """One LLM agent: how it thinks, what it may call, what it may read."""

    type: Literal["agent"] = "agent"
    #: APPENDED to the engine's base system prompt, never substituted for it — the
    #: base carries the citation contract, the answer-in-the-question's-language rule
    #: and the analysis guardrails, and a chain of replacement prompts would drop all
    #: of them without a trace.
    prompt: str
    provider: str = INHERIT
    model: str = ""
    #: THIS NODE'S OWN CREDENTIAL. Three fields for one secret, because a secret the
    #: server never gives back needs more than one field to be editable at all.
    #:
    #:   api_key        WRITE-ONLY plaintext from the builder; encrypted on save.
    #:   api_key_enc    What is persisted: Fernet ciphertext (`_enc:` prefix).
    #:   api_key_clear  Remove the stored key — because "left empty" has to mean
    #:                  KEEP (the builder cannot resend a value it was never shown),
    #:                  so erasing needs a separate word.
    api_key: str = ""
    api_key_enc: str = ""
    api_key_clear: bool = False
    tools: list[ToolGrant] = Field(default_factory=list)
    knowledge: list[KnowledgeAttachment] = Field(default_factory=list)
    max_tool_calls: int = Field(default=8, ge=1, le=MAX_TOOL_CALLS)
    #: `chat` streams prose (the default, and what keeps authoring simple).
    #: `json` asks the model for typed answer blocks — richer, but not streamable,
    #: because a half-written JSON object cannot be rendered.
    #: `choice` is a CLASSIFIER: the step must answer with one of `choices` and
    #: nothing else, and the runtime enforces that rather than asking for it.
    output_format: Literal["chat", "json", "choice"] = "chat"
    #: The only answers a `choice` step may give.
    #:
    #: A classifier feeding a Switch used to be built by writing "reply with exactly
    #: one of: a, b, c" in the prompt and hoping. When the model answered in prose
    #: instead — which it does, especially when the engine's own base prompt has
    #: told it to explain itself when data is missing — no case matched, the branch
    #: ran nothing, and the run still reported ok. Prompts are requests; this is the
    #: constraint, checked in code after the model speaks.
    choices: list[str] = Field(default_factory=list)
    #: What each choice MEANS, keyed by the choice. Optional, and the reason it
    #: exists is measured rather than assumed.
    #:
    #: A classifier used to be handed the bare list — `tra_so`, `so_sanh`,
    #: `bat_thuong`, `du_bao`, `dinh_nghia` — and nothing else. Those are variable
    #: names, not descriptions, and on a 13-node harness the model sent "GMV toàn kỳ
    #: là bao nhiêu?" (a plain lookup) down the FORECAST branch, while the lookup
    #: case never fired once across four questions. The routing was wrong and the
    #: answer that came back was still fluent, which is the failure mode branching
    #: makes possible and the hardest one for an author to notice.
    #:
    #: A description per choice is the cheapest possible fix: a dozen words each, on
    #: a step whose whole output is one token.
    choice_hints: dict[str, str] = Field(default_factory=dict)
    context_policy: ContextPolicy = "question"

    @model_validator(mode="after")
    def _choice_has_options(self) -> "AgentNode":
        """A `choice` step with no options can never produce a legal answer, so it
        would fail on every question. Refused at save time, where an author is
        looking at the node, rather than at run time in front of a viewer."""
        if self.output_format == "choice":
            cleaned = [str(c).strip() for c in self.choices if str(c).strip()]
            if len(cleaned) < 2:
                raise ValueError(
                    "bước phân loại phải có ít nhất 2 lựa chọn để chọn giữa"
                )
            if len(set(cleaned)) != len(cleaned):
                raise ValueError("các lựa chọn của bước phân loại phải khác nhau")
            object.__setattr__(self, "choices", cleaned)
            # A hint for a choice that does not exist is a typo, and silently
            # ignoring it means the author never learns why their description had
            # no effect. Dropped, not raised: a stale hint left over from renaming a
            # choice should not make the flow unsaveable.
            hints = {
                k: str(v).strip()
                for k, v in (self.choice_hints or {}).items()
                if k in set(cleaned) and str(v).strip()
            }
            object.__setattr__(self, "choice_hints", hints)
        return self

    @field_validator("prompt")
    @classmethod
    def _has_prompt(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("mỗi bước AI phải có hướng dẫn cho agent")
        return v

    @model_validator(mode="after")
    def _model_is_real(self) -> "AgentNode":
        """A model no provider serves is a 404 on the first real question, and the
        viewer sees a dead chat rather than an error. Refused at save time."""
        if self.provider == INHERIT:
            if self.model:
                raise ValueError("bước theo cấu hình của link thì không đặt model riêng")
            return self
        if self.provider not in MODELS:
            raise ValueError(f"nhà cung cấp không hỗ trợ: {self.provider}")
        if not known_model(self.provider, self.model):
            allowed = ", ".join(m["model"] for m in MODELS[self.provider])
            raise ValueError(
                f"model '{self.model}' không có trong danh sách của {self.provider}. "
                f"Chọn một trong: {allowed}"
            )
        return self

    @model_validator(mode="after")
    def _credential_is_usable(self) -> "AgentNode":
        """A node-level key with no provider named cannot be dispatched safely: the
        link's vendor is unknown when the author pastes the token, and sending an
        Anthropic key to whichever vendor a link happens to use fails in front of a
        viewer. Refused at save time instead."""
        if (self.api_key or self.api_key_enc) and self.provider == INHERIT:
            raise ValueError(
                "bước có token riêng thì phải chọn nhà cung cấp cụ thể "
                "(token của OpenAI không dùng được trên link chạy Gemini)"
            )
        return self

    def resolved_api_key(self) -> str:
        """The node's own key in the clear, or "" when it has none.

        Decryption failure returns "" rather than raising: a rotated ENCRYPTION_KEY
        must degrade to "this node falls back to the link's key", not to a traceback
        inside a streaming answer.
        """
        if not self.api_key_enc:
            return ""
        try:
            from app.core.crypto import decrypt_value

            return decrypt_value(self.api_key_enc) or ""
        except Exception:  # noqa: BLE001
            logger.warning("[flow] node '%s' credential will not decrypt", self.key)
            return ""

    def tool_names(self) -> list[str]:
        out: list[str] = []
        for g in self.tools:
            if g.tool not in out:
                out.append(g.tool)
        return out


class ReportReadNode(BaseNode):
    """Read the report being viewed — WITHOUT a model.

    Everything this does is a deterministic call the engine can make itself, so it
    costs no tokens and cannot hallucinate. It exists because "look at the charts"
    was previously only expressible as an agent with tools, which meant paying a
    model to decide to do the obvious thing.

    It never names a dashboard: the charts it may touch are the binding's allowlist.
    """

    type: Literal["report_read"] = "report_read"
    #: Which chart ids to read. Empty means every chart the binding allows.
    chart_ids: list[int] = Field(default_factory=list)
    include_summary: bool = True
    include_data: bool = True
    include_filters: bool = True
    max_rows: int = Field(default=200, ge=1, le=5000)
    #: How much of each chart to carry forward.
    #:
    #: `index` carries only what a chart IS — id, name, type, what it measures and
    #: how it is grouped, plus the value when the chart is a single figure. No rows
    #: and no per-column statistics. It is the right level when the answering step
    #: has computing tools (`rank_values`, `total_measure`, `share_of`): those
    #: reach exact figures over every row on demand, so pasting a sample of the
    #: data into the prompt buys nothing and is paid for on every model round. The
    #: step reads the index, picks the chart, calls the tool.
    #:
    #: `compact` keeps what a question is normally answered from — the columns, the
    #: row count, and each numeric column's total/min/max/avg — and drops the parts
    #: that are long without being informative (a per-value frequency list of every
    #: category, repeated in full inside every prompt that references this node).
    #: On a three-chart read that is ~4,300 tokens down to a few hundred, paid once
    #: per node that quotes it. Right when the step has NO tools and must answer
    #: from what it was handed.
    #:
    #: `full` is the old behaviour, for a flow that really does need every row.
    detail: Literal["index", "compact", "full"] = "compact"
    run_policy: RunPolicy = "when_stale"


class KnowledgeNode(BaseNode):
    """Retrieval against attached sources, without a model deciding to do it."""

    type: Literal["knowledge"] = "knowledge"
    #: What to look for. Templated, so it can search for what an earlier node found.
    query: str = "{{question}}"
    knowledge: list[KnowledgeAttachment] = Field(default_factory=list)
    top_k: int = Field(default=5, ge=1, le=20)


class WebNode(BaseNode):
    """Reach outside AppBI. Runs only where the link allows it."""

    type: Literal["web"] = "web"
    query: str = "{{question}}"
    #: Empty means no restriction. A non-empty list is enforced on every fetch, not
    #: merely suggested to the model.
    allowed_domains: list[str] = Field(default_factory=list)
    fetch_pages: bool = True
    top_k: int = Field(default=5, ge=1, le=20)


class SetVarNode(BaseNode):
    type: Literal["set_var"] = "set_var"
    #: The variable being written. Distinct from `output_var` on purpose: this node
    #: IS the assignment, so its target is not optional.
    var: str
    value: str = ""
    value_type: Literal["text", "number", "object", "list", "bool"] = "text"

    @field_validator("var")
    @classmethod
    def _valid(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError("tên biến phải là chữ thường/số/gạch dưới")
        return v


class TransformNode(BaseNode):
    """Reshape data between nodes. A FIXED set of operations, not code.

    Free-form code here would need a sandbox, a review story and a way to reason
    about what a flow can do — for three operations the builder already renders as
    dropdowns.
    """

    type: Literal["transform"] = "transform"
    operation: Literal["append_to_list", "map_fields", "format_object", "join_text", "pick"]
    source: str = ""
    target: str = ""
    mapping: dict[str, str] = Field(default_factory=dict)
    separator: str = "\n"


class StopNode(BaseNode):
    """End the run early.

    `emit` is what makes this useful inside a branch: a path that has decided the
    answer does not have to fall through the rest of the flow to deliver it.
    """

    type: Literal["stop"] = "stop"
    emit: bool = True
    message: str = ""


class DelayNode(BaseNode):
    """Wait, in seconds, inside the turn.

    BOUNDED AT 30 SECONDS ON PURPOSE. A public link answers over one streaming
    response to a viewer who is watching; a five-minute wait means either holding
    that connection (which the deployment cannot afford per viewer) or persisting
    the run and resuming later — and after five minutes there is no longer anywhere
    to deliver the answer to, because the tab is closed.

    Longer waits belong to a background execution mode, which is a product decision
    and not a node. Shipping a node that cannot work is what the previous module
    did.
    """

    type: Literal["delay"] = "delay"
    seconds: float = Field(default=1.0, ge=0, le=30)


class FilterNode(BaseNode):
    """Stop this branch unless the conditions hold. IF with one path and no else."""

    type: Literal["filter"] = "filter"
    match: Literal["all", "any"] = "all"
    conditions: list[Condition] = Field(default_factory=list)


class Path(_Model):
    """One branch of an IF, with the rule that selects it and the body it runs."""

    key: str
    name: str = ""
    #: `rules` evaluates `conditions`; `always` runs unconditionally; `fallback` runs
    #: only when no earlier path matched.
    kind: Literal["rules", "always", "fallback"] = "rules"
    match: Literal["all", "any"] = "all"
    conditions: list[Condition] = Field(default_factory=list)
    body: list["Node"] = Field(default_factory=list)

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError("path key phải là chữ thường/số/gạch dưới")
        return v

    @model_validator(mode="after")
    def _rules_have_rules(self) -> "Path":
        if self.kind == "rules" and not self.conditions:
            raise ValueError(
                f"nhánh “{self.name or self.key}” đặt loại Custom rules thì phải có "
                "ít nhất một điều kiện"
            )
        return self


class IfNode(BaseNode):
    """Branch into named paths. The paths merge implicitly at the next sibling."""

    type: Literal["if"] = "if"
    paths: list[Path] = Field(default_factory=list)

    @field_validator("paths")
    @classmethod
    def _sane_paths(cls, v: list[Path]) -> list[Path]:
        if len(v) < 2:
            raise ValueError("IF phải có ít nhất 2 nhánh")
        keys = [p.key for p in v]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"trùng key nhánh: {', '.join(sorted(dupes))}")
        if sum(1 for p in v if p.kind == "fallback") > 1:
            raise ValueError("chỉ được một nhánh Fallback")
        return v


class Case(_Model):
    key: str
    label: str = ""
    op: ConditionOp = "equals"
    value: str = ""
    body: list["Node"] = Field(default_factory=list)

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError("case key phải là chữ thường/số/gạch dưới")
        return v


class SwitchNode(BaseNode):
    """Route on one value. `first_match` is the default because "run every matching
    case" is rarely what an author means and always more expensive."""

    type: Literal["switch"] = "switch"
    value: str
    mode: Literal["first_match", "all_match"] = "first_match"
    cases: list[Case] = Field(default_factory=list)
    fallback: list["Node"] = Field(default_factory=list)
    has_fallback: bool = True

    @field_validator("cases")
    @classmethod
    def _sane_cases(cls, v: list[Case]) -> list[Case]:
        if not v:
            raise ValueError("Switch phải có ít nhất một case")
        keys = [c.key for c in v]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"trùng key case: {', '.join(sorted(dupes))}")
        return v


class LoopNode(BaseNode):
    """Run a body once per item of a list.

    THE MOST EXPENSIVE NODE IN THE CONTRACT. A loop of 25 over one agent is 25 model
    calls for a single question, so `max_iterations` is bounded here and the whole
    run carries its own budget on top.
    """

    type: Literal["loop"] = "loop"
    #: The list to walk. A template, usually a binding-resolved requirement such as
    #: `{{segments}}`.
    over: str
    item_var: str = "item"
    index_var: str = ""
    max_iterations: int = Field(default=10, ge=1, le=MAX_LOOP_ITERATIONS)
    body: list["Node"] = Field(default_factory=list)
    #: Collect each iteration's result into this list variable. Saves every flow from
    #: needing a Transform node just to accumulate.
    collect_into: str = ""

    @field_validator("item_var")
    @classmethod
    def _valid_item(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError("tên biến item phải là chữ thường/số/gạch dưới")
        return v


Node = Annotated[
    Union[
        AgentNode,
        ReportReadNode,
        KnowledgeNode,
        WebNode,
        SetVarNode,
        TransformNode,
        StopNode,
        DelayNode,
        FilterNode,
        IfNode,
        SwitchNode,
        LoopNode,
    ],
    Field(discriminator="type"),
]

Path.model_rebuild()
Case.model_rebuild()
IfNode.model_rebuild()
SwitchNode.model_rebuild()
LoopNode.model_rebuild()


# ═══ What a flow needs from whatever link runs it ══════════════════════════════
class Requirement(_Model):
    """One thing the flow needs the report to have.

    PREFER `metric`. `GovernMetric.name` is a unique machine name, so a metric
    requirement resolves on every dashboard without being re-mapped. A `chart`
    requirement is positional and has to be re-mapped by hand on each link — which
    is why the builder warns about it rather than treating the kinds as equals.
    """

    key: str
    kind: Literal["metric", "dimension", "measure", "chart", "document", "dataset", "value"]
    label: str = ""
    hint: str = ""
    required: bool = True

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError("requirement key phải là chữ thường/số/gạch dưới")
        return v


#: Tools whose arguments are keyed by `chart_id`. A step granted one of these has
#: to name a chart, and the only place chart ids appear is the output of a
#: `report_read` step — so a step holding these tools and reading no read-step
#: variable is guessing.
#:
#: Kept as a literal set rather than derived from the registry: `contract.py` is the
#: schema layer and importing the tool registry here would make the shape of a flow
#: depend on which packs happen to be installed.
_CHART_KEYED_TOOLS = frozenset({
    "total_measure", "rank_values", "share_of", "get_chart_summary",
    "get_chart_data", "aggregate_chart_data", "get_chart_glossary",
    "compare_to_target", "compare_periods", "compare_segments", "segment_compare",
    "explain_change", "detect_anomaly", "smart_drilldown", "describe_distribution",
    "project_to_period_end", "detect_seasonality", "analyze_trend",
    "forecast_measure",
})




class FlowRequirements(_Model):
    """The flow's interface. This is the half of "define before you assign" that
    lives on the FLOW; the binding is the half that lives on the link."""

    items: list[Requirement] = Field(default_factory=list)
    #: Capabilities the flow expects the link to grant, e.g. `web_search`. Named so
    #: preflight can warn at assign time instead of the node silently doing nothing.
    capabilities: list[str] = Field(default_factory=list)

    def required_keys(self) -> list[str]:
        return [r.key for r in self.items if r.required]

    @field_validator("items")
    @classmethod
    def _unique(cls, v: list[Requirement]) -> list[Requirement]:
        keys = [r.key for r in v]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"trùng requirement: {', '.join(sorted(dupes))}")
        return v


# ═══ The flow ═════════════════════════════════════════════════════════════════
class Flow(_Model):
    """A tree of nodes. One node's text becomes the answer."""

    key: str
    name: str
    description: str = ""
    #: Bumped when the stored shape changes. 1 = the old linear `steps` list, which
    #: `upgrade_body` rewrites into `nodes` on read. Named `schema_version` and not
    #: `schema` because the latter shadows a BaseModel attribute.
    schema_version: int = 2
    requirements: FlowRequirements = Field(default_factory=FlowRequirements)
    nodes: list[Node] = Field(default_factory=list)
    #: The node whose text reaches the viewer. Empty means "the last top-level node",
    #: which is what a linear flow means anyway. Named rather than left implicit
    #: because with branches "the last one" stopped having an answer.
    answer_node: str = ""

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError("flow key phải là chữ thường/số/gạch dưới")
        return v

    @model_validator(mode="after")
    def _sane_tree(self) -> "Flow":
        if not self.nodes:
            raise ValueError("flow phải có ít nhất một bước")

        keys: list[str] = []
        depth_seen = 0
        loops_on_path: list[int] = []

        def walk(nodes: list[Any], depth: int, in_loop: bool) -> None:
            nonlocal depth_seen
            depth_seen = max(depth_seen, depth)
            for n in nodes:
                keys.append(n.key)
                if n.run_policy != "every_turn" and in_loop:
                    # Each iteration is a different item, so "remember it across
                    # turns" cannot mean anything coherent here.
                    raise ValueError(
                        f"bước “{n.name or n.key}” nằm trong Loop nên không dùng được "
                        "chế độ nhớ qua lượt"
                    )
                if isinstance(n, IfNode):
                    for p in n.paths:
                        walk(p.body, depth + 1, in_loop)
                elif isinstance(n, SwitchNode):
                    for c in n.cases:
                        walk(c.body, depth + 1, in_loop)
                    walk(n.fallback, depth + 1, in_loop)
                elif isinstance(n, LoopNode):
                    loops_on_path.append(depth)
                    if in_loop:
                        raise ValueError(
                            "chưa hỗ trợ Loop lồng trong Loop — chi phí nhân lên "
                            "theo cấp số nhân"
                        )
                    walk(n.body, depth + 1, True)

        walk(list(self.nodes), 1, False)

        if len(keys) > MAX_NODES:
            raise ValueError(f"tối đa {MAX_NODES} bước trong một flow")
        if depth_seen > MAX_DEPTH:
            raise ValueError(f"lồng nhau tối đa {MAX_DEPTH} cấp")
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"trùng key bước: {', '.join(sorted(dupes))}")

        if self.answer_node and self.answer_node not in {n.key for n in self.nodes}:
            raise ValueError(
                f"bước trả lời “{self.answer_node}” phải là một bước ở cấp ngoài cùng"
            )
        return self

    # ── Reading the tree ──────────────────────────────────────────────────────
    def all_nodes(self) -> list[Any]:
        """Every node anywhere in the tree, in document order."""
        out: list[Any] = []

        def walk(nodes: list[Any]) -> None:
            for n in nodes:
                out.append(n)
                if isinstance(n, IfNode):
                    for p in n.paths:
                        walk(p.body)
                elif isinstance(n, SwitchNode):
                    for c in n.cases:
                        walk(c.body)
                    walk(n.fallback)
                elif isinstance(n, LoopNode):
                    walk(n.body)

        walk(list(self.nodes))
        return out

    def agent_nodes(self) -> list[AgentNode]:
        return [n for n in self.all_nodes() if isinstance(n, AgentNode)]

    def node(self, key: str) -> Any | None:
        for n in self.all_nodes():
            if n.key == key:
                return n
        return None

    def writes_prose(self, key: str) -> bool:
        """Would this step's output read as a sentence to a viewer? THE one rule.

        WRITTEN IN TWO PLACES AND ONE OF THEM WAS OUT OF DATE.
        `executor._final_answer` falls back to the last step that produced prose
        when the answering step fails, and its test was `step.type == "agent"`. The
        comment there explains exactly why the restriction exists — "a Set Variable
        holding 'none' became the viewer's answer; a variable is not a sentence" —
        and a `choice` agent is the same category of thing: a classifier emits one
        token, `tra_so` or `du_bao`, chosen from a fixed list. `handlers/agent.py`
        has known `choice` is special since it was added; the fallback never learned,
        so a failed answering step could reply to a viewer with the word "du_bao".

        `json` counts: those steps emit answer blocks, which is prose with structure
        and is exactly what the viewer is shown when they succeed.
        """
        n = self.node(key)
        if not isinstance(n, AgentNode):
            return False
        return n.output_format != "choice"

    def answering_key(self) -> str:
        """The node whose text reaches the viewer.

        `answer_node` when set, else the last TOP-LEVEL node — never simply "the last
        node", which under branching is whichever leaf happened to be written last.
        """
        return self.answer_node or (self.nodes[-1].key if self.nodes else "")

    def steps_missing_credentials(self) -> list[str]:
        """Agent nodes that would have to borrow the link's token. Empty means this
        flow is self-sufficient, which is what lets a link run it with no key."""
        return [n.key for n in self.agent_nodes() if not n.api_key_enc]

    def bound_sources(self) -> list[KnowledgeAttachment]:
        """Everything this flow may read, across its nodes, deduplicated.

        DERIVED, never declared separately. A second place to record the flow's reach
        is a second place for it to be wrong, and this list is what the share dialog
        shows and what the run-time permission re-check walks.
        """
        seen: set[tuple[str, str]] = set()
        out: list[KnowledgeAttachment] = []
        for n in self.all_nodes():
            for k in getattr(n, "knowledge", []) or []:
                ident = (k.source, k.ref)
                if ident not in seen:
                    seen.add(ident)
                    out.append(k)
        return out

    def uses_capability(self, name: str) -> bool:
        if name == "web_search":
            return any(isinstance(n, WebNode) for n in self.all_nodes()) or any(
                t.tool in {"web_search", "fetch_url", "benchmark_compare"}
                for n in self.agent_nodes()
                for t in n.tools
            )
        return name in (self.requirements.capabilities or [])

    def referenced_vars(self) -> set[str]:
        """Every `{{name}}` mentioned anywhere. Used by preflight to catch a flow
        reading a variable nothing ever writes — which at run time is an empty string
        threaded silently into a prompt."""
        found: set[str] = set()
        for n in self.all_nodes():
            found |= node_referenced_vars(n)
        return found

    def produced_vars(self) -> set[str]:
        out: set[str] = set()
        for n in self.all_nodes():
            if getattr(n, "output_var", ""):
                out.add(n.output_var)
            if isinstance(n, SetVarNode):
                out.add(n.var)
            if isinstance(n, LoopNode):
                out.add(n.item_var)
                if n.index_var:
                    out.add(n.index_var)
                if n.collect_into:
                    out.add(n.collect_into)
            if isinstance(n, TransformNode) and n.target:
                out.add(n.target.replace("[]", "").strip())
        return out

    def warnings(self) -> list[str]:
        """What this flow gives up, said plainly rather than prevented.

        There is no mandatory frame: no forced screening, no forced fact-check, no
        forced closing step. That was the author's explicit call. The honest
        counterpart is naming the consequence instead of hiding it or quietly
        re-adding the guarantee.
        """
        out: list[str] = []
        if not self.bound_sources():
            out.append(
                "Flow này không gắn tri thức nào — nó chỉ đọc báo cáo đang mở. "
                "Đúng nếu bạn muốn dùng nó cho mọi báo cáo."
            )
        answering = self.node(self.answering_key())
        if isinstance(answering, AgentNode) and answering.tools:
            out.append(
                f"Bước trả lời “{answering.name or answering.key}” vẫn có công cụ. "
                "Bước viết câu trả lời mà còn gọi được công cụ thì dễ đưa ra số "
                "chưa qua các bước trước."
            )
        # A STEP THAT MUST NAME A CHART, AND WAS NEVER SHOWN ONE.
        #
        # The measure, compare, diagnose and project tools all take a `chart_id`, and
        # the only place those ids exist is a `report_read` step's output. A step
        # granted those tools whose prompt reads no read-step variable has to invent
        # an id, and it does.
        #
        # Measured on a nine-node flow: every branch agent was granted the right
        # tools and handed no index. Seven consecutive calls came back
        # `chart_out_of_scope`, the tool budget was spent on them, and the viewer was
        # told the report contained no GMV — on a report whose GMV is 15,843,553.24.
        # Adding `{{ctx}}` to those four prompts took the same flow to zero failed
        # calls and the correct figure.
        read_vars = {
            n.output_var for n in self.all_nodes()
            if isinstance(n, ReportReadNode) and n.output_var
        }
        if read_vars:
            for n in self.agent_nodes():
                keyed = sorted({t.tool for t in n.tools} & _CHART_KEYED_TOOLS)
                if not keyed:
                    continue
                if node_referenced_vars(n) & read_vars:
                    continue
                out.append(
                    f"Bước “{n.name or n.key}” được cấp công cụ cần chart_id "
                    f"({', '.join(keyed[:3])}…) nhưng prompt không đọc "
                    + " hoặc ".join("{{" + v + "}}" for v in sorted(read_vars))
                    + " — nó sẽ phải đoán chart_id và gọi công cụ thất bại."
                )

        for n in self.agent_nodes():
            named = _REPORT_NAME_RE.search(n.prompt)
            if named:
                out.append(
                    f"Bước “{n.name or n.key}” nhắc tên một báo cáo cụ thể "
                    f"(“{named.group(1)}”). Flow dùng được cho nhiều link, nên prompt "
                    "nên nói “báo cáo đang mở”."
                )
        for req in self.requirements.items:
            if req.kind == "chart":
                out.append(
                    f"Yêu cầu “{req.label or req.key}” gắn theo biểu đồ. Mỗi link sẽ "
                    "phải map lại tay — nếu được, hãy dùng chỉ số (metric) để dùng "
                    "chung cho mọi báo cáo."
                )
        # Requirement keys are supplied by the BINDING at run time, so they are
        # produced — just not by a node. Leaving them out of this subtraction made
        # every correctly-declared flow warn about its own inputs.
        supplied = {r.key for r in self.requirements.items}
        missing = self.referenced_vars() - self.produced_vars() - supplied - _BUILTIN_VARS
        for v in sorted(missing):
            out.append(
                f"Biến {{{{{v}}}}} được dùng nhưng không bước nào tạo ra nó, và cũng "
                "không phải requirement — lúc chạy nó sẽ rỗng."
            )
        # Named even when it is not the answering step: a node parked below a Stop
        # is invisible on the canvas — it looks exactly like a node that runs.
        dead = self.unreachable_nodes()
        if dead:
            out.append(
                "Các bước sau một bước Stop ở cấp ngoài cùng sẽ không bao giờ chạy: "
                + ", ".join(dead)
                + ". Stop không có điều kiện — muốn dừng có điều kiện thì đặt nó "
                "trong một nhánh IF hoặc sau một Filter."
            )
        return out

    def unreachable_nodes(self) -> list[str]:
        """Top-level nodes that can never run, because a Stop above them always does.

        A `stop` node has no condition — `emit` and `message` are all it carries — so
        a Stop at the TOP level ends every run that reaches it. Anything after it is
        dead, and a Stop meant to fire only sometimes belongs inside an IF path or
        behind a Filter.

        Measured on a nine-node harness: a Stop sat two nodes above the designated
        answering step, so the answering step never ran on any turn, the viewer
        received an intermediate step's text, and `validate` returned ok with no
        blocking problem — while still warning about the tools granted to the node
        that could not run. Every part of that was working as written.

        Only top-level nodes are considered. A Stop inside a branch or a loop body is
        conditional by construction: the branch may not be taken.
        """
        out: list[str] = []
        stopped_by = ""
        for node in self.nodes:
            if stopped_by:
                out.append(node.key)
                continue
            if node.type == "stop":
                stopped_by = node.key
        return out

    def blocking_problems(self) -> list[str]:
        """The subset of `warnings()` that is a DEFECT rather than a trade-off.

        Most warnings describe a choice: no knowledge attached, a report named in a
        prompt, a chart-shaped requirement. An author can read those and decide they
        meant it.

        A `{{variable}}` that no step produces is not a choice. At run time it
        resolves to an empty string, so the prompt that reads it is silently
        missing the thing it was written around — and the step still reports ok,
        which is the whole family of failure this module keeps finding. The warning
        was computed and shown, and nothing ever stopped: a flow could go live with
        it and answer viewers from a prompt with a hole in it.
        """
        supplied = {r.key for r in self.requirements.items}
        missing = sorted(
            self.referenced_vars() - self.produced_vars() - supplied - _BUILTIN_VARS
        )
        out = [
            f"Biến {{{{{v}}}}} được dùng nhưng không bước nào tạo ra nó — lúc chạy "
            "nó sẽ rỗng, và bước đọc nó sẽ chạy thiếu đúng phần dữ liệu đó."
            for v in missing
        ]
        # A FLOW THAT CANNOT REACH ITS OWN ANSWER IS NOT A TRADE-OFF.
        #
        # Unreachable nodes in general are a warning — an author may have parked a
        # step below a Stop on purpose. The answering node is different: the run
        # ends, `_final_answer` falls back to whatever an intermediate step left
        # behind, and the viewer is handed working notes. Blocking, so it is caught
        # at save time rather than by a reader.
        dead = self.unreachable_nodes()
        answer_key = self.answer_node or (self.nodes[-1].key if self.nodes else "")
        if answer_key and answer_key in dead:
            out.append(
                f"Bước trả lời “{answer_key}” nằm sau một bước Stop nên không bao "
                "giờ chạy — người xem sẽ nhận kết quả của một bước trung gian. "
                "Chuyển Stop vào trong một nhánh, hoặc bỏ nó đi."
            )
        return out

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


#: Alias kept because `resource_shares`, the registry and the permission layer all
#: speak of brains. The stored resource did not change; only its shape did.
Brain = Flow


# ═══ Reading bodies written before nodes existed ══════════════════════════════
def upgrade_body(body: dict[str, Any], *, key: str = "", name: str = "") -> dict[str, Any]:
    """Bring a stored body up to the current schema.

    v1 was `{"steps": [ ...agent... ]}` — a linear chain of agents and nothing else.
    Every one of those is a valid v2 tree of `agent` nodes, so the upgrade is a
    rename plus a type tag. Done on READ so no migration has to touch JSONB, and so
    a body written by an older deployment still opens.
    """
    if not isinstance(body, dict):
        return {"key": key, "name": name, "schema_version": 2, "nodes": []}
    out = dict(body)
    if out.get("nodes") is None and isinstance(out.get("steps"), list):
        nodes: list[dict] = []
        for step in out["steps"]:
            if not isinstance(step, dict):
                continue
            s = dict(step)
            s.setdefault("type", "agent")
            # v1 stored a tier that nothing ever read; dropping it here keeps it out
            # of the upgraded body rather than carrying a dead field forward.
            s.pop("model_tier", None)
            nodes.append(s)
        out["nodes"] = nodes
    out.pop("steps", None)
    out.pop("schema", None)
    out["schema_version"] = 2
    if key:
        out["key"] = key
    if name:
        out["name"] = name
    return out


_TEMPLATE_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}")

#: Variables the runtime always provides, so referencing them is not a warning.
_BUILTIN_VARS = {
    "question", "available_metrics", "available_dimensions",
    "previous", "outputs", "item", "index", "loop",
}


def node_referenced_vars(node: Any) -> set[str]:
    """Every `{{name}}` ONE node reads, as the bare root name.

    PUBLIC AND SHARED ON PURPOSE. This existed three times — here, in the
    runtime, and again in the run inspector — each with its own copy of the regex
    and its own idea of which fields are templated. The inspector's copy scanned
    six attributes and missed `message`, IF/Switch conditions, Switch case values
    and Transform mappings, so a flow whose only reference to a missing variable
    sat in an IF condition was reported clean. One function, one field list: the
    three cannot drift because there is no longer anything to drift from.
    """
    found: set[str] = set()
    for text in _templated_strings(node):
        for m in _TEMPLATE_RE.finditer(text or ""):
            found.add(m.group(1).split(".")[0].strip())
    return found


def _templated_strings(node: Any) -> list[str]:
    """Every field of a node that gets `{{...}}` substitution."""
    out: list[str] = []
    for attr in ("prompt", "query", "value", "over", "message", "source", "target"):
        v = getattr(node, attr, None)
        if isinstance(v, str):
            out.append(v)
    for cond in getattr(node, "conditions", []) or []:
        out.extend([cond.left, cond.right])
    if isinstance(node, IfNode):
        for p in node.paths:
            for cond in p.conditions:
                out.extend([cond.left, cond.right])
    if isinstance(node, SwitchNode):
        for c in node.cases:
            out.append(c.value)
    if isinstance(node, TransformNode):
        out.extend(list(node.mapping.keys()) + list(node.mapping.values()))
    return out


#: A prompt naming a specific report is the failure mode that comes with making
#: flows reusable: it runs correctly on one link and misleads on the rest. Caught as
#: a warning, not an error — an author may genuinely intend a single-report flow,
#: and refusing to save would be deciding that for them.
_REPORT_NAME_RE = re.compile(
    r"(?:báo cáo|report|dashboard)\s+[\"“']?"
    r"([A-Z0-9][\w-]*(?:\s+[A-Z0-9][\w-]*){0,2})"
)
