"""The publisher's structured guide for a public link's AI Bot (`ai_bot_guide`).

Owner decision 2026-10-28 (docs/features/public-bot-trust-guide): free text mixed a
glossary, formulas, targets, policies and tone, and left the model to decide what to
do with each line. Each section of the guide now has ONE use, and what code can do
is done by code:

  glossary       term -> a field of the link's catalog: a synonym of that field for
                 the planner and the chart ranking
  definitions    a "what is / how is X computed" question about a defined term is
                 answered with the definition, verbatim, no model call (PO decision)
  targets        a measure's target (per period): "attainment / gap" computed by code
                 from the Core's one total
  cause_sources  the charts that hold the reasons ("Hành động khắc phục"): the only
                 place an analysis may take a cause from (post-checked here)
  facts          policies and knowledge no chart holds: the analysis' knowledge
  context/style  the analysis' framing
  out_of_scope   topics refused at once, no model call

The guide is the publisher's; viewers never receive it (stripped like the free-text
note), though answers may quote definitions, facts and targets.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger("app.public_answer")


class GuideContext(BaseModel):
    purpose: str = ""
    audience: str = ""
    unit: str = ""
    period_note: str = ""


class GlossaryEntry(BaseModel):
    term: str = Field(min_length=1)
    ref: str = Field(min_length=3)


class Definition(BaseModel):
    name: str = Field(min_length=1)
    aliases: list[str] = []
    formula: str = Field(min_length=1)
    note: str = ""


class Target(BaseModel):
    ref: str = Field(min_length=3)
    value: float
    period: str = ""
    unit: str = ""
    label: str = ""


class CauseSource(BaseModel):
    chart_id: int
    note: str = ""


class Fact(BaseModel):
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)


class Style(BaseModel):
    length: Literal["short", "normal", "detailed"] = "normal"
    tone: Literal["executive", "operational", "neutral"] = "neutral"
    language: Literal["auto", "vi", "en"] = "auto"


class OutOfScope(BaseModel):
    topic: str = Field(min_length=1)
    reason: str = ""


class PublisherGuide(BaseModel):
    v: int = 1
    context: GuideContext = GuideContext()
    glossary: list[GlossaryEntry] = []
    definitions: list[Definition] = []
    targets: list[Target] = []
    cause_sources: list[CauseSource] = []
    facts: list[Fact] = []
    style: Style = Style()
    out_of_scope: list[OutOfScope] = []

    def is_empty(self) -> bool:
        return not (any(self.context.model_dump().values()) or self.glossary or self.definitions or self.targets
                    or self.cause_sources or self.facts or self.out_of_scope)

    def for_model(self) -> dict:
        """What the analysis is given (the glossary is the planner's; out-of-scope is code's)."""
        out: dict[str, Any] = {}
        ctx = {k: v for k, v in self.context.model_dump().items() if v}
        if ctx:
            out["context"] = ctx
        if self.definitions:
            out["definitions"] = [d.model_dump(exclude_defaults=True) for d in self.definitions]
        if self.targets:
            out["targets"] = [t.model_dump(exclude_defaults=True) for t in self.targets]
        if self.facts:
            out["facts"] = [f.model_dump() for f in self.facts]
        out["style"] = self.style.model_dump()
        return out


def parse(raw: Any) -> PublisherGuide:
    """Strict: the editor's save path (422 on a malformed guide)."""
    return PublisherGuide.model_validate(raw or {})


def load(appearance: Optional[dict]) -> Optional[PublisherGuide]:
    """Tolerant: the turn path. A guide that no longer parses is ignored (logged),
    never an error for a viewer."""
    raw = (appearance or {}).get("ai_bot_guide")
    if not raw:
        return None
    try:
        guide = PublisherGuide.model_validate(raw)
    except ValidationError:
        logger.warning("[public_answer] ignoring a malformed ai_bot_guide")
        return None
    return None if guide.is_empty() else guide


# ── matching ─────────────────────────────────────────────────────────────────

def _fold(text: str) -> str:
    from app.services.data_core.grounding import fold

    return " " + " ".join(re.split(r"[^0-9a-z]+", fold(text or ""))).strip() + " "


def _says(question: str, phrase: str) -> bool:
    """The folded question contains the folded phrase as whole words."""
    p = _fold(phrase).strip()
    return bool(p) and f" {p} " in _fold(question)


_MEANING = re.compile(
    r"(là gì|nghĩa là|định nghĩa|công thức|cách tính|tính (?:như )?thế nào|tính ra sao|được tính|gồm những gì|"
    r"what is|what does .* mean|how is .* (?:calculated|computed|defined)|definition|formula)", re.IGNORECASE)


def out_of_scope(guide: Optional[PublisherGuide], question: str) -> Optional[OutOfScope]:
    for item in (guide.out_of_scope if guide else []):
        if _says(question, item.topic):
            return item
    return None


def definition(guide: Optional[PublisherGuide], question: str) -> Optional[Definition]:
    """A question asking what a DEFINED term means / how it is computed."""
    if not guide or not guide.definitions or not _MEANING.search(question or ""):
        return None
    best = None
    for d in guide.definitions:
        names = [d.name, *d.aliases]
        hit = max((len(_fold(n)) for n in names if _says(question, n)), default=0)
        if hit and (best is None or hit > best[0]):
            best = (hit, d)
    return best[1] if best else None


def synonyms(guide: Optional[PublisherGuide]) -> dict[str, list[str]]:
    """ref -> the publisher's terms for it."""
    out: dict[str, list[str]] = {}
    for g in (guide.glossary if guide else []):
        out.setdefault(g.ref, [])
        if g.term not in out[g.ref]:
            out[g.ref].append(g.term)
    return out


# ── targets ──────────────────────────────────────────────────────────────────

def _values(cond: Any) -> set[str]:
    """The folded values one filter condition holds (a date range: its first day)."""
    if not isinstance(cond, dict):
        return set()
    value = cond.get("value")
    values = [value.get("from")] if isinstance(value, dict) else value if isinstance(value, list) else [value]
    return {_fold(str(v)).strip() for v in values if v not in (None, "")}


def target_for(guide: Optional[PublisherGuide], plan: Optional[dict], core: dict,
               context_filters: Optional[list] = None) -> Optional[dict]:
    """The target block beside the Core's ONE total, computed by code; None when the
    answer is a breakdown, no target names its measure, or the answer's scope is not
    the target's. Every filter in force counts - the question's and the link's /
    viewer's (`context_filters`): a target with no period is the whole report's, so it
    is compared only with an unfiltered total; a target for period T08 only with a total
    whose every filter is that period. Live 2026-10-28: the company target was set
    against the West region's revenue ("đạt 0,73%")."""
    if not guide or not guide.targets or not isinstance(plan, dict):
        return None
    measures = plan.get("measures") or []
    rows = core.get("rows") or []
    columns = core.get("columns") or []
    if len(measures) != 1 or len(rows) != 1 or any(c.get("role") == "dimension" for c in columns):
        return None
    ref = measures[0]
    col = next((c["name"] for c in columns if c.get("ref") == ref), None)
    actual = rows[0].get(col) if col else None
    if not isinstance(actual, (int, float)) or isinstance(actual, bool):
        return None
    in_force = [v for v in (_values(c) for c in [*(plan.get("filters") or {}).values(), *(context_filters or [])]) if v]

    def same_scope(t: Target) -> bool:
        period = _fold(t.period).strip() if t.period else ""
        # a period target needs the answer to BE that period (an unfiltered total is every period)
        return bool(in_force) and all(v == {period} for v in in_force) if period else not in_force

    candidates = [t for t in guide.targets if t.ref == ref and same_scope(t)]
    target = ([t for t in candidates if t.period] or candidates or [None])[0]
    if target is None or not target.value:
        return None
    gap = actual - target.value
    return {"measure": target.label or ref.rsplit(".", 1)[-1], "period": target.period or None,
            "target": target.value, "actual": actual, "gap": round(gap, 4),
            "attainment_pct": round(actual / target.value * 100, 2), "unit": target.unit or None}


# ── causes ───────────────────────────────────────────────────────────────────

_CAUSE_VI = re.compile(r"(?<![\wÀ-ỹ])(nguyên nhân|lý do|bởi vì|bởi|vì|do|dẫn đến|xuất phát từ|nhờ)(?![\wÀ-ỹ])",
                       re.IGNORECASE)
_NOT_CAUSE_VI = re.compile(r"(do đó|do vậy|vì vậy|vì thế|bởi vậy)", re.IGNORECASE)
_CAUSE_EN = re.compile(r"\b(because|due to|driven by|caused by|as a result of|thanks to|owing to)\b", re.IGNORECASE)
_STOP = set("""
cac cua co la va voi cho nhung mot trong khi tai theo nay do vi boi nhan nguyen ly dan den xuat phat tu nho
duoc da dang se rat hon nhat cung the nhu tren duoi ve thang nam quy ky so lieu bao cao
the a an and of to in for by on is are was were be this that with from as at it its
""".split())
NO_CAUSE = "Chưa ghi nhận nguyên nhân trong dữ liệu báo cáo."


def _words(text: str) -> set[str]:
    return {w for w in _fold(text).split() if len(w) > 2 and w not in _STOP and not w.isdigit()}


def states_a_cause(text: str) -> bool:
    """The text says why (a causal marker that is not a mere "therefore")."""
    for sentence in re.split(r"(?<=[.!?])\s+|\n", text or ""):
        low = sentence.lower()
        if _CAUSE_EN.search(low) or (_CAUSE_VI.search(low) and not _NOT_CAUSE_VI.search(low)):
            return True
    return False


def check_causes(text: str, corpus: str) -> str:
    """Remove a sentence that states a cause no source holds. A sentence carrying a
    causal marker is kept only when most of the words of its cause clause are in the
    corpus (the cause-source charts' rows, the guide's facts and context); otherwise
    it goes and "Chưa ghi nhận nguyên nhân…" is said once. A sentence with no causal
    marker is never touched."""
    known = _words(corpus)
    kept, dropped = [], False
    for line in (text or "").split("\n"):
        out_sentences = []
        for sentence in re.split(r"(?<=[.!?])\s+", line):
            low = sentence.lower()
            m = None if _NOT_CAUSE_VI.search(low) and not _CAUSE_EN.search(low) else (
                _CAUSE_VI.search(low) or _CAUSE_EN.search(low))
            if m is None:
                out_sentences.append(sentence)
                continue
            clause = _words(sentence[m.end():])
            if clause and len(clause & known) * 2 >= len(clause):
                out_sentences.append(sentence)
            else:
                dropped = True
        joined = " ".join(s for s in out_sentences if s.strip())
        if joined.strip() and joined.strip() not in ("-", "*", "•"):
            kept.append(joined)
    result = "\n".join(kept).strip()
    if dropped:
        result = f"{result}\n{NO_CAUSE}".strip()
    return result


# ── unverified figures ───────────────────────────────────────────────────────

def mark_unverified(text: str, figures: list[str]) -> str:
    """Each unverified figure is wrapped ⟦…⟧ where it stands, so the reader sees it
    flagged in the sentence (not only in a list under it)."""
    for fig in sorted({f for f in figures if f}, key=len, reverse=True):
        text = re.sub(rf"(?<![\w⟦]){re.escape(fig)}(?![\w⟧])", f"⟦{fig}⟧", text)
    return text


# ── the editor's catalog ─────────────────────────────────────────────────────

def catalog_payload(scope) -> dict:
    """The charts and fields the bot reads for this link (`PublishedReportScope`),
    for the editor's pickers - the same catalog, never a second approximation."""
    charts, fields = [], {}
    for entry in scope.catalog():
        chart = scope.chart(entry.explore_id)
        charts.append({"chart_id": entry.explore_id, "name": chart.name if chart else entry.label,
                       "pages": chart.pages if chart else []})
        for f in entry.fields:
            if f.kind not in ("dimension", "measure"):
                continue
            item = fields.setdefault(f.ref, {"ref": f.ref, "label": f.label, "kind": f.kind,
                                             "aggregation": f.type if f.kind == "measure" else None, "charts": []})
            item["charts"].append(entry.explore_id)
    return {"charts": charts, "fields": list(fields.values())}


def invalid_entries(guide: PublisherGuide, catalog: dict) -> list[str]:
    """Entries naming a field or chart this link does not publish."""
    refs = {f["ref"] for f in catalog.get("fields") or []}
    measures = {f["ref"] for f in catalog.get("fields") or [] if f["kind"] == "measure"}
    charts = {c["chart_id"] for c in catalog.get("charts") or []}
    bad = [f"glossary:{g.term}" for g in guide.glossary if g.ref not in refs]
    bad += [f"targets:{t.ref}" for t in guide.targets if t.ref not in measures]
    bad += [f"cause_sources:{c.chart_id}" for c in guide.cause_sources if c.chart_id not in charts]
    return bad
