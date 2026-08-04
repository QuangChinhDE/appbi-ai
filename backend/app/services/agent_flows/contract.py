"""What an AI Agent brain IS. The runtime contract, written before any UI.

WHY THIS FILE COMES FIRST
-------------------------
The module this replaces was built the other way round: ten node types with
generated forms and a palette, while the executor could only run one of them.
Adding an HTTP node and publishing produced an agent node with an empty prompt —
wrong, and silent. So nothing appears in a builder until the executor here
handles it, and this file is the list of what the executor handles.

WHAT A BRAIN IS
---------------
A named, versioned, SHAREABLE recipe for turning a viewer's question into an
answer. It is a first-class resource, the way a Dataset or a Dashboard is — not a
setting hanging off a public link. Any number of links may point at the same
brain; a brain never knows which link or which report it will serve.

That independence is the whole design, and it has one hard consequence: A BRAIN
MUST NOT NAME A REPORT. The report arrives at run time from the link, and its
charts and filters are read automatically. A prompt written as "đọc báo cáo Olist"
runs correctly in exactly one place and quietly misleads everywhere else, so
prompts address "the report being viewed".

KNOWLEDGE
---------
A brain attaches knowledge that already lives in AppBI — Knowledge documents, a
dataset's Semantic Model, managed metric definitions — from ONE OR MANY sources
mixed freely. A brain with no knowledge at all is legitimate and useful: it reads
the open report and reasons, which works on every report.

Each attachment carries WHEN TO CONSULT IT, and that description is required. It
is the only thing standing between a brain and a report it knows nothing about:
faced with unrelated data, the model reads the description and declines to open
the source. There is no machine check for that — a brain may be pointed at any
report on purpose — so the description is not documentation, it is the guard.

PERMISSIONS
-----------
Two questions, deliberately kept apart, because collapsing them is what produced
a design that blocked the reuse this module exists for:

  authoring  What may I attach?   → my own view/edit rights on that document or
                                     dataset, enforced server-side.
  assigning  Which brain may I use on my link?
                                   → whether the brain is shared with me.

Sharing a brain therefore DELEGATES its author's reading rights. That is stated
rather than hidden: the alternative — intersecting with each assigner's rights —
makes one brain answer differently on two links, and "what does this brain read"
stops having a single answer. Two things keep the delegation honest: nobody can
attach what they cannot themselves read, so a delegation can never exceed the
rights it came from; and the refs are re-checked at RUN time against the author,
so rights lost after publishing take effect immediately.
"""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

#: Where a piece of attached knowledge comes from. All three already exist in the
#: product; there is no fourth, because inventing a knowledge store when the app
#: already has one is how two answers to one question get created.
KnowledgeSourceKind = Literal["document", "semantic", "metric"]

#: How much thinking a step deserves. These are the AUTHORED names; the mapping to
#: rows in `ai_model_policies` lives in one place beside them, because the last
#: time these two vocabularies were kept apart the tier silently resolved to
#: nothing and every step ran on the link's own model.
ModelTier = Literal["fast", "balanced", "deep"]
DEFAULT_TIER: ModelTier = "balanced"

POLICY_ROW_FOR_TIER: dict[str, str] = {
    "fast": "fast_classify",
    "balanced": "compose",
    "deep": "deep_reason",
}

#: Hard cap on chain length. Not a quality opinion — depth is the author's call —
#: but the point past which a per-turn budget could not fund one model call per
#: step anyway.
MAX_STEPS = 12

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


class ToolGrant(BaseModel):
    """One tool this step may call, and when to reach for it.

    Tools are granted PER STEP, from a list the author picks. An earlier design
    bundled them into five fixed agent "kinds", which re-closed the thing worth
    opening. `note` is optional and goes to the model with the tool name, so an
    author can say "only for questions about trends" without writing a prompt
    paragraph about it.
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


class KnowledgeAttachment(BaseModel):
    """One source this step may consult, and WHEN.

    `ref` is the source's id in its own store: a document id, a dataset id, a
    metric machine name. Kept as a string so the three kinds share one shape
    instead of three nullable columns.
    """

    source: KnowledgeSourceKind
    ref: str
    #: Required. An attachment with no description tells the model what it MAY
    #: open and never why, so it opens the wrong source or none — and on a report
    #: this brain was not written for, "or none" is the outcome that matters.
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


class AgentStep(BaseModel):
    """One agent in the chain: how it thinks, what it may call, what it may read."""

    key: str
    name: str = ""
    #: How this agent thinks. APPENDED to the engine's base system prompt, never
    #: substituted for it — the base carries the citation contract, the
    #: answer-in-the-question's-language rule and the analysis guardrails, and a
    #: chain of replacement prompts would drop all of them without a trace.
    #:
    #: Addresses "the report being viewed", never a named report: this brain will
    #: serve links its author never saw.
    prompt: str
    model_tier: ModelTier = DEFAULT_TIER
    tools: list[ToolGrant] = Field(default_factory=list)
    knowledge: list[KnowledgeAttachment] = Field(default_factory=list)
    #: Ceiling on tool calls for this step, checked between rounds.
    max_tool_calls: int = 8

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError(
                "step key must be lowercase letters/digits/underscore, "
                "starting with a letter"
            )
        return v

    @field_validator("prompt")
    @classmethod
    def _has_prompt(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("mỗi bước phải có hướng dẫn cho agent")
        return v

    def tool_names(self) -> list[str]:
        """Deduplicated, order preserved. Validated against the live tool registry
        by the caller — the contract holds names, the registry is the truth about
        which of them this deployment can dispatch."""
        out: list[str] = []
        for g in self.tools:
            if g.tool not in out:
                out.append(g.tool)
        return out


class Brain(BaseModel):
    """A chain of agents. The last step's text is the answer.

    Linear on purpose, for now. Branching, HTTP lookups and a verification step are
    all wanted, and none of them appear here until the executor runs them — that
    ordering is the correction to how the previous module was built.
    """

    key: str
    name: str
    description: str = ""
    steps: list[AgentStep] = Field(default_factory=list)

    @field_validator("key")
    @classmethod
    def _valid_key(cls, v: str) -> str:
        if not _KEY_RE.match(v or ""):
            raise ValueError(
                "brain key must be lowercase letters/digits/underscore, "
                "starting with a letter"
            )
        return v

    @field_validator("steps")
    @classmethod
    def _sane_chain(cls, v: list[AgentStep]) -> list[AgentStep]:
        if not v:
            raise ValueError("bộ não phải có ít nhất một bước")
        if len(v) > MAX_STEPS:
            raise ValueError(f"tối đa {MAX_STEPS} bước")
        keys = [s.key for s in v]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"trùng key bước: {', '.join(sorted(dupes))}")
        return v

    def answering_step(self) -> AgentStep:
        """The step whose text reaches the viewer. Named rather than left implicit,
        because "the last one answers" is a rule the executor and the builder must
        agree on and neither should re-derive."""
        return self.steps[-1]

    def bound_sources(self) -> list[KnowledgeAttachment]:
        """Everything this brain may read, across its steps, deduplicated.

        DERIVED, never declared separately. A second place to record the brain's
        reach is a second place for it to be wrong, and this list is what the
        share dialog shows and what the run-time permission re-check walks.
        """
        seen: set[tuple[str, str]] = set()
        out: list[KnowledgeAttachment] = []
        for step in self.steps:
            for k in step.knowledge:
                ident = (k.source, k.ref)
                if ident not in seen:
                    seen.add(ident)
                    out.append(k)
        return out

    def warnings(self) -> list[str]:
        """What this brain gives up, said plainly rather than prevented.

        There is no mandatory frame any more: no forced screening, no forced
        fact-check, no forced closing step. That was the author's explicit call.
        The honest counterpart is naming the consequence instead of either hiding
        it or quietly re-adding the guarantee.
        """
        out: list[str] = []
        if not self.bound_sources():
            out.append(
                "Bộ não này không gắn tri thức nào — nó chỉ đọc báo cáo đang mở. "
                "Đúng nếu bạn muốn dùng nó cho mọi báo cáo."
            )
        answering = self.answering_step()
        if answering.tools:
            out.append(
                f"Bước cuối “{answering.name or answering.key}” vẫn có công cụ. "
                "Bước viết câu trả lời mà còn gọi được công cụ thì dễ đưa ra số "
                "chưa qua các bước trước."
            )
        for step in self.steps:
            named = _REPORT_NAME_RE.search(step.prompt)
            if named:
                out.append(
                    f"Bước “{step.name or step.key}” nhắc tên một báo cáo cụ thể "
                    f"(“{named.group(1)}”). Bộ não dùng được cho nhiều link, nên "
                    "prompt nên nói “báo cáo đang mở”."
                )
        return out

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


#: A prompt naming a specific report is the failure mode that comes with making
#: brains reusable: it runs correctly on one link and misleads on the rest. Caught
#: as a warning, not an error — an author may genuinely intend a single-report
#: brain, and refusing to save would be deciding that for them.
#: Continues only across CAPITALISED words, so it captures "Olist E-Commerce" and
#: stops. A greedy `[\w\- ]+` swallowed the rest of the sentence and quoted it back
#: at the author, which reads as though the tool misunderstood them.
_REPORT_NAME_RE = re.compile(
    r"(?:báo cáo|report|dashboard)\s+[\"“']?"
    r"([A-Z0-9][\w-]*(?:\s+[A-Z0-9][\w-]*){0,2})"
)
