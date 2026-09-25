"""Capability routing — the router controls VISIBILITY; the registry controls AUTHORITY.

THE PROBLEM
-----------
Every capability an Agent step was granted went to the model as a full JSON
schema on every round. The 36 tools are ~28.5k characters of schema; a step
granted a broad set paid for all of it on every round, and the catalogue only
grows (Skills are capabilities too). Context grew linearly with the grant.

The first answer — a fixed-size shortlist with the rest named in the system
prompt — lost answers live (23/30 vs 27/30 shown in full over five A/B runs) and
the model never once used `find_capability`: what it needed was hidden and it did
not know how to ask. Raising the limit above the catalogue made the problem go
away by giving up on it. This module is the second answer.

THE VIEW, PER ROUND
-------------------
    granted    what the author granted this step
    eligible   granted AND admissible here — the registry's own admission rule
               (`registry.admission_refusal`: risk, web, raw rows, availability),
               so nothing certain to be refused is offered or listed
    loaded     full schema this round: the core (every way in to a chart id, and
               compute), everything loaded earlier in the step, and the capabilities
               the QUESTION ranks highest — filled to a schema BUDGET in characters,
               not to a count, so a small grant is shown whole and a large one costs
               about the same as a small one
    catalogue  every other eligible capability, one line each (`name — label`),
               bounded, INSIDE `find_capability`'s own description — the place a
               model looks when it is choosing a tool

WHY THE QUESTION AND NOT THE PROMPT
-----------------------------------
Measured on 48 labelled intents: ranking on "question + node prompt" loaded the
right capability for 27; ranking on the question, with the prompt as a weak
second channel, for 45. An author's generic "you are a BI analyst, answer from the
report" matches half the catalogue a little and outvotes the one word in the
question that matters. Grant NOTES are different: an author who wrote "use this
for margin questions" named when that tool applies, so a note is part of that
tool's own description here.

DISCOVERY IS A LOAD, NOT A SEARCH RESULT TO REMEMBER
----------------------------------------------------
`find_capability(need?, names?)` loads by intent or by a name from the catalogue;
the loaded capabilities have full definitions from the next round. Bounded: at most
`MAX_DISCOVERIES` calls per step, `MAX_LOAD` capabilities per call. A model that
calls an eligible capability it has not been shown is refused for that call — it
has not seen the schema it is filling in — and the capability is loaded for the
next round, so the correction costs no search.

AUTHORITY IS NOT HERE
---------------------
A loaded capability still goes through `registry.execute()` (or the Skill
invoker), which re-checks grant, scope, capability flags, risk and budget. This
module only ever NARROWS what the model is shown, and it can only name what is
eligible: an ungranted or inadmissible capability is never loaded, listed, or
distinguishable from one that does not exist.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

from app.services.agent_flows.tools import registry as tool_registry

FIND_CAPABILITY = "find_capability"

#: Discovery calls one step may make. Each costs a model round anyway; three is
#: enough to look, refine, and look once more — a fourth is a loop.
MAX_DISCOVERIES = 3
#: Capabilities one discovery call may load. A search that loads the whole
#: catalogue is the full-exposure problem again, one round later.
MAX_LOAD = 5
#: How many hits a `need` (as opposed to a name) loads.
NEED_HITS = 3
#: Lines in the catalogue. Past this, the catalogue says how many more exist and
#: that describing the need finds them — so its size is bounded however large the
#: registry grows.
CATALOGUE_LINES = 30
#: A ranked capability is loaded only if it scores at least this fraction of the
#: best match: a tool that shares one incidental word with the question is not
#: worth its schema.
RELATIVE_CUTOFF = 0.25
#: Weight of the node prompt relative to the question when ranking.
PROMPT_WEIGHT = 0.3
#: How many near-duplicate capabilities (description overlap ≥ ALIKE_JACCARD)
#: routing loads for one question; the rest stay in the catalogue.
#: 0.4 by measurement: the two most alike REAL tools (get_chart_data,
#: smart_drilldown) overlap 0.16; same-topic variants of one capability overlap
#: 0.46 and up. The line sits well clear of every real pair.
MAX_ALIKE = 2
ALIKE_JACCARD = 0.4


def _core() -> tuple[str, ...]:
    """Loaded on every round of a routed step, when granted and eligible: the
    tools that hand out the chart ids every analytical tool needs (the contract's
    own `_CHART_LOOKUP_TOOLS` — one definition of "a way in"), and the one that
    computes over what they find.

    MEASURED, NOT ASSUMED. The first core held only the two discover tools; live,
    the shortlisted step answered 3 of 6 because `list_charts` was not there and it
    guessed chart ids.

    And the one that READS what a way in found. Measured on the routing eval: a
    KPI-value question ("tỷ lệ giao đúng hẹn là bao nhiêu?") found its chart and
    then, with no reader loaded, tried `compute` on the lookup result and answered
    "no data" in every routed and stress run, while the full arm read it with
    `get_chart_summary`/`get_chart_data`. `get_chart_summary` is the reader that
    works on any chart without raw-row access."""
    from app.services.agent_flows.contract import _CHART_LOOKUP_TOOLS

    return (*sorted(_CHART_LOOKUP_TOOLS), "get_chart_summary", "compute")


CORE = _core()

_WORD_RE = re.compile(r"[0-9A-Za-zÀ-ỹ]+", re.UNICODE)
_SUFFIXES = ("ations", "ation", "ities", "ity", "ings", "ing", "ions", "ion", "ies",
             "ied", "ers", "ed", "es", "er", "ly", "al", "s", "y", "e")


def default_schema_budget() -> int:
    """Characters of capability schema a routed step is shown per round (policy)."""
    try:
        from app.core.config import settings

        return max(1000, int(getattr(settings, "AGENT_FLOW_CAPABILITY_SCHEMA_BUDGET", 10500)))
    except Exception:                                           # noqa: BLE001
        return 10500


def default_limit() -> int:
    """Hard ceiling on how many capabilities are loaded in full, whatever fits the
    budget. A node's own `visible_capabilities` replaces it (and the budget)."""
    try:
        from app.core.config import settings

        return max(1, int(getattr(settings, "AGENT_FLOW_VISIBLE_CAPABILITIES", 40)))
    except Exception:                                           # noqa: BLE001
        return 40


def _fold(text: str) -> str:
    from app.core.text_fold import fold_text

    return fold_text(text or "")


def _stem(word: str) -> str:
    """Light suffix stripping, twice: "correlated", "correlation" and "correlate"
    are one idea; so are "seasonality" and "seasonal". Folded Vietnamese words
    almost never carry these endings, and a stem of four letters is the floor."""
    for _ in range(2):
        for suf in _SUFFIXES:
            if word.endswith(suf) and len(word) - len(suf) >= 4:
                word = word[: -len(suf)]
                break
        else:
            break
    return word


def _terms(text: str) -> set[str]:
    """Stemmed words, plus adjacent PAIRS. "dự báo" is one idea; as two separate
    words it matches every description that happens to say "dự" and "báo"."""
    words = [_stem(t) for t in _WORD_RE.findall(_fold(text)) if len(t) > 1]
    return set(words) | {f"{a}_{b}" for a, b in zip(words, words[1:])}


#: How directly a field describes the capability. The label, the example
#: questions and the author's own note are what it IS for; the Vietnamese
#: description explains it; the English model-facing definition is long and full
#: of generic words.
_FIELD_WEIGHTS = (("label", 3.0), ("answers", 3.0), ("note", 3.0),
                  ("description", 2.0), ("definition", 2.0))


def _weighted_terms(spec: Any, note: str = "") -> dict[str, float]:
    definition = getattr(spec, "definition", None) or {}
    returns = getattr(spec, "returns", None) or {}
    fields = {
        "label": " ".join(filter(None, [getattr(spec, "name", "").replace("_", " "),
                                        getattr(spec, "label_vi", ""), getattr(spec, "label_en", "")])),
        "answers": " ".join(getattr(spec, "answers_vi", ()) or ()),
        "note": note or "",
        "description": " ".join(filter(None, [getattr(spec, "description_vi", ""),
                                              *[f"{k} {v}" for k, v in returns.items()]])),
        "definition": str(definition.get("description") or ""),
    }
    out: dict[str, float] = {}
    for fname, weight in _FIELD_WEIGHTS:
        for term in _terms(fields[fname]):
            out[term] = max(out.get(term, 0.0), weight)
    return out


def schema_chars(defs: list[dict]) -> int:
    """How much schema text a round carries — what routing exists to bound."""
    return sum(len(json.dumps(d, ensure_ascii=False)) for d in defs)


@dataclass
class ExtraCapability:
    """A capability that is not a registry tool — today, a published Skill.

    It is ranked, loaded and discovered exactly like a tool; only its execution
    differs (the Skill invoker, not `registry.execute`)."""

    name: str
    definition: dict
    label: str
    does: str
    search: Any  # an object `_weighted_terms` can read


@dataclass
class CapabilityView:
    """What one Agent step may be shown, and what it was shown, round by round."""

    granted: list[str]
    eligible: list[str]
    #: name → refusal code, for every granted capability left out of `eligible`.
    excluded: dict[str, str]
    #: Count ceiling on loaded capabilities.
    limit: int
    #: Characters of schema a round may carry (0 = the author set a count instead).
    schema_budget: int
    #: False when every eligible capability fits: the step is shown them all and
    #: behaves exactly as it always has.
    shortlisted: bool
    #: Loaded by discovery, by a refused-but-eligible call, or by use — stays loaded.
    sticky: list[str] = field(default_factory=list)
    visible: list[str] = field(default_factory=list)
    rounds: list[list[str]] = field(default_factory=list)
    rounds_chars: list[int] = field(default_factory=list)
    discovered: list[str] = field(default_factory=list)
    discoveries: list[dict[str, Any]] = field(default_factory=list)
    auto_loaded: list[dict[str, Any]] = field(default_factory=list)
    invoked: list[str] = field(default_factory=list)
    rejected: list[dict[str, str]] = field(default_factory=list)
    question: str = ""
    context: str = ""
    _haystacks: dict[str, dict[str, float]] = field(default_factory=dict, repr=False)
    _sizes: dict[str, int] = field(default_factory=dict, repr=False)
    #: The haystacks never change after `build_view`, so neither do the weights.
    _idf: dict[str, float] | None = field(default=None, repr=False)
    _rank_cache: dict[tuple[str, str], list[tuple[str, float]]] = field(default_factory=dict, repr=False)
    extras: dict[str, ExtraCapability] = field(default_factory=dict, repr=False)

    # ── ranking ──────────────────────────────────────────────────────────────
    def _weights(self) -> dict[str, float]:
        if self._idf is None:
            self._idf = self._compute_weights()
        return self._idf

    def _compute_weights(self) -> dict[str, float]:
        """Rarer words count more. "nào", "bao nhiêu" appear in half the
        catalogue's example questions; a term only one capability carries is what
        tells them apart. Computed over the ELIGIBLE set, so it adapts to whatever
        this step was granted — no stop-word list to maintain."""
        df: dict[str, int] = {}
        for terms in self._haystacks.values():
            for t in terms:
                df[t] = df.get(t, 0) + 1
        # BM25's idf: a word every capability carries ("the", "của", "báo cáo")
        # scores ~0 rather than log(2) — the English definitions are long prose,
        # and function words summed over a sentence outvoted the one word that
        # mattered.
        n = max(1, len(self._haystacks))
        return {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def _score(self, terms: set[str], weights: dict[str, float], name: str) -> float:
        hay = self._haystacks.get(name, {})
        return sum(weights.get(t, 0.0) * hay[t] for t in terms if t in hay)

    def rank(self, query: str, *, context: str = "") -> list[tuple[str, float]]:
        """Σ over the query's words and word pairs: rarity × how directly the
        field that matched describes the capability; `context` (the node prompt)
        scales that by at most 1 + `PROMPT_WEIGHT`."""
        key = (query or "", context or "")
        if key in self._rank_cache:
            return list(self._rank_cache[key])
        wanted, around = _terms(query), _terms(context) if context else set()
        weights = self._weights()
        asked = {n: self._score(wanted, weights, n) for n in self.eligible}
        framed = {n: self._score(around, weights, n) for n in self.eligible} if around else {}
        best_frame = max(framed.values(), default=0.0) or 1.0
        # THE QUESTION DECIDES; the prompt only TILTS what the question matched —
        # by at most PROMPT_WEIGHT of the question's own score. Measured: as an
        # additive second channel, a generic Vietnamese prompt ("phân tích… báo
        # cáo") outscored every English question's own match, and the tool the
        # question named was the one left out.
        scored = [(n, asked[n] * (1 + PROMPT_WEIGHT * framed.get(n, 0.0) / best_frame))
                  for n in self.eligible]
        # Stable: ties keep the grant order, which is the author's order.
        ranked = sorted(scored, key=lambda x: -x[1])
        if len(self._rank_cache) < 64:
            self._rank_cache[key] = ranked
        return list(ranked)

    # ── per round ────────────────────────────────────────────────────────────
    def _schema_size(self, name: str) -> int:
        return self._sizes.get(name, 800)

    def refresh(self, query: str | None = None) -> list[str]:
        """The capabilities loaded on the next round."""
        if query is not None:
            self.question = query
        if not self.shortlisted:
            self.visible = list(self.eligible)
        else:
            chosen: list[str] = []
            for name in [*(c for c in CORE if c in self.eligible), *self.sticky]:
                if name not in chosen:
                    chosen.append(name)
            used = sum(self._schema_size(n) for n in chosen)
            ranked = [(n, s) for n, s in self.rank(self.question, context=self.context) if s > 0]
            # THE CUTOFF IS RELATIVE TO THE BEST CANDIDATE, not to the core. The
            # core is loaded whatever it scores; letting a core tool set the bar
            # meant a question that names a metric ("tỷ lệ giao đúng hẹn là bao
            # nhiêu") ranked `search_business_assets` at 83 and cut
            # `total_measure` at 16 — measured live: the routed step then had no
            # way to read a KPI's value and answered "no data".
            candidates = [s for n, s in ranked if n not in chosen]
            top = candidates[0] if candidates else 0.0
            picked: list[str] = []
            for name, score in ranked:
                if len(chosen) >= self.limit or score < top * RELATIVE_CUTOFF:
                    break
                if name in chosen:
                    continue
                # NEAR-DUPLICATES ADD LITTLE. A catalogue grows in clusters —
                # "export revenue by sales rep" for eight departments — and a
                # cluster sharing the question's one common word would otherwise
                # fill the budget with copies. Two of a kind are loaded; the rest
                # stay in the catalogue, one line each, loadable on demand.
                if sum(1 for p in picked if self._similar(name, p)) >= MAX_ALIKE:
                    continue
                size = self._schema_size(name)
                if self.schema_budget and used + size > self.schema_budget:
                    continue  # a smaller one further down may still fit
                chosen.append(name)
                picked.append(name)
                used += size
            self.visible = chosen
        self.rounds.append(list(self.visible))
        return self.visible

    def _similar(self, a: str, b: str) -> bool:
        ta = set(self._haystacks.get(a, {}))
        tb = set(self._haystacks.get(b, {}))
        if not ta or not tb:
            return False
        return len(ta & tb) / len(ta | tb) >= ALIKE_JACCARD

    def catalogue(self) -> list[str]:
        """Eligible capabilities not loaded this round, most relevant first."""
        if not self.shortlisted:
            return []
        loaded = set(self.visible)
        order = [n for n, _ in self.rank(self.question, context=self.context)]
        return [n for n in order if n not in loaded]

    def _label(self, name: str) -> str:
        extra = self.extras.get(name)
        if extra:
            return extra.label
        spec = tool_registry.all_tools().get(name)
        if spec is None:
            return ""
        vi, en = getattr(spec, "label_vi", "") or "", getattr(spec, "label_en", "") or ""
        return f"{vi} ({en})" if vi and en and vi != en else (vi or en)

    def _does(self, name: str) -> str:
        extra = self.extras.get(name)
        if extra:
            return extra.does
        spec = tool_registry.all_tools().get(name)
        text = str(getattr(spec, "description_vi", "") or "")
        return text.split(". ")[0][:200]

    def find_definition(self) -> dict:
        """`find_capability`, with this round's catalogue in its own description."""
        rest = self.catalogue()
        lines = [f"- {n} — {self._label(n)}" for n in rest[:CATALOGUE_LINES]]
        more = len(rest) - len(lines)
        catalogue = "\n".join(lines) if lines else "(none — everything granted is loaded)"
        if more > 0:
            catalogue += f"\n(+{more} more — describe what you need to find them)"
        left = max(0, MAX_DISCOVERIES - len(self.discoveries))
        return {
            "name": FIND_CAPABILITY,
            "description": (
                "Load a capability you are allowed to use but whose full definition is "
                "not loaded yet. Use it BEFORE answering whenever the loaded "
                "capabilities do not fit the task — do not approximate an analysis "
                "(trend, anomaly, forecast, share, comparison…) from raw rows when a "
                "capability for it exists below. Pass `names` from this list, or "
                "describe the `need` in a few words; loaded capabilities are usable "
                f"from your next turn. {left} call(s) left in this step.\n"
                "Not loaded yet:\n" + catalogue
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "need": {"type": "string",
                             "description": "what you need to do, e.g. \"forecast next month\""},
                    "names": {"type": "array", "items": {"type": "string"},
                              "description": "exact capability names from the list"},
                },
            },
        }

    def schemas(self, *, web_enabled: bool) -> list[dict]:
        tools = [n for n in self.visible if n not in self.extras]
        defs = tool_registry.definitions_for(set(tools), web_enabled=web_enabled)
        defs += [self.extras[n].definition for n in self.visible if n in self.extras]
        # In the author's grant order, like every other list here.
        order = {n: i for i, n in enumerate(self.granted)}
        defs.sort(key=lambda d: order.get(d.get("name"), 1_000))
        if self.shortlisted:
            defs.append(self.find_definition())
        self.rounds_chars.append(schema_chars(defs))
        return defs

    def is_visible(self, name: str) -> bool:
        return name in self.visible

    def routing_note(self) -> str:
        """One line for the system prompt of a routed step: the mechanism exists.
        The catalogue itself sits in `find_capability`'s definition."""
        if not self.shortlisted:
            return ""
        hidden = len([n for n in self.eligible if n not in self.visible])
        if not hidden:
            return ""
        return (
            f"KHẢ NĂNG: bước này được cấp {len(self.eligible)} khả năng; {len(self.visible)} "
            f"đang có định nghĩa đầy đủ, {hidden} khả năng còn lại nằm trong danh sách của "
            f"{FIND_CAPABILITY}. Nếu những khả năng đang có chưa làm đúng được việc cần làm "
            f"(xu hướng, bất thường, dự báo, tỷ trọng, so sánh…), gọi {FIND_CAPABILITY} để "
            "nạp khả năng phù hợp TRƯỚC khi trả lời — đừng ước lượng thủ công từ dữ liệu thô."
        )

    # ── discovery ────────────────────────────────────────────────────────────
    def discover(self, need: str = "", names: list[str] | None = None) -> dict:
        """Load by intent or by name. Searches ELIGIBLE capabilities only: that set
        is the whole of what this function can see, so a name that is ungranted,
        inadmissible or nonexistent gets the same answer — not available here."""
        round_no = len(self.rounds)
        if len(self.discoveries) >= MAX_DISCOVERIES:
            return {
                "ok": False, "error_code": "discovery_exhausted", "retryable": False,
                "error": (f"đã tìm khả năng {MAX_DISCOVERIES} lần trong bước này — trả lời "
                          "bằng những gì đã có và nói rõ phần không làm được."),
            }
        names = [str(n) for n in (names or []) if str(n).strip()][:MAX_LOAD]
        loaded: list[str] = []
        already: list[str] = []
        unavailable: list[str] = []
        for name in names:
            if name not in self.eligible:
                unavailable.append(name)
            elif name in self.visible or name in self.sticky:
                already.append(name)
            else:
                loaded.append(name)
        if need.strip() and len(loaded) < MAX_LOAD:
            hits = [n for n, s in self.rank(need) if s > 0]
            top_hits = hits[:NEED_HITS]
            for name in top_hits:
                if name in self.visible or name in self.sticky:
                    if name not in already:
                        already.append(name)
                elif name not in loaded and len(loaded) < MAX_LOAD:
                    loaded.append(name)
        for name in loaded:
            self.sticky.append(name)
            if name not in self.discovered:
                self.discovered.append(name)
        self.discoveries.append({
            "round": round_no, "need": need[:200], "names": names,
            "loaded": list(loaded), "already_loaded": list(already),
            "not_available": list(unavailable),
        })

        def row(n: str) -> dict:
            out = {"name": n, "label": self._label(n) or n, "does": self._does(n)}
            definition = (self.extras[n].definition if n in self.extras
                          else (tool_registry.all_tools()[n].definition or {}))
            schema = definition.get("input_schema") or definition.get("parameters") or {}
            out["needs"] = list(schema.get("required") or [])
            return out

        remaining = len([n for n in self.eligible if n not in self.visible and n not in self.sticky])
        if loaded:
            note = "Đã nạp — định nghĩa đầy đủ có từ lượt tiếp theo; gọi chúng như mọi công cụ khác."
        elif already:
            note = "Những khả năng khớp nhất đã có sẵn — dùng chúng ngay."
        else:
            note = ("Không có khả năng nào được cấp cho bước này khớp với yêu cầu — trả lời "
                    "bằng những gì đã có và nói rõ phần không làm được.")
        return {
            "ok": True,
            "kind": "value",
            "data": {
                "need": need[:200],
                "loaded": [row(n) for n in loaded],
                "already_loaded": [row(n) for n in already],
                "not_available": unavailable,
                "remaining_unloaded": remaining,
                "discoveries_left": max(0, MAX_DISCOVERIES - len(self.discoveries)),
                "note": note,
            },
        }

    def load_on_refusal(self, name: str) -> bool:
        """An eligible capability the model called without having been shown it:
        refused for this call, loaded for the next — at most `MAX_LOAD` per step.
        Found by review: uncapped, a model spraying names grew one round from 6
        loaded capabilities to 29 with no discovery, which is full exposure again
        by another door. Past the cap it is refused and pointed at discovery."""
        if name in self.sticky:
            return True
        if name not in self.eligible or len(self.auto_loaded) >= MAX_LOAD:
            return False
        self.sticky.append(name)
        self.auto_loaded.append({"round": len(self.rounds), "name": name})
        return True

    # ── bookkeeping ──────────────────────────────────────────────────────────
    def note_invoked(self, name: str) -> None:
        if name not in self.invoked:
            self.invoked.append(name)
        if self.shortlisted and name not in self.sticky and name != FIND_CAPABILITY:
            self.sticky.append(name)

    def note_rejected(self, name: str, code: str) -> None:
        self.rejected.append({"name": name, "code": code, "round": len(self.rounds)})

    def to_trace(self) -> dict:
        return {
            "granted": list(self.granted),
            "eligible": list(self.eligible),
            "excluded": dict(self.excluded),
            "limit": self.limit,
            "schema_budget": self.schema_budget,
            "shortlisted": self.shortlisted,
            "initially_visible": list(self.rounds[0]) if self.rounds else [],
            "visible_per_round": [list(r) for r in self.rounds],
            "schema_chars_per_round": list(self.rounds_chars),
            "discovered": list(self.discovered),
            "discoveries": [dict(d) for d in self.discoveries],
            "auto_loaded": [dict(a) for a in self.auto_loaded],
            "invoked": list(self.invoked),
            "rejected": list(self.rejected),
        }


def build_view(
    granted: list[str], ctx: Any, *, web_enabled: bool, limit: int | None = None,
    extras: list[ExtraCapability] | None = None, excluded_extras: dict[str, str] | None = None,
    schema_budget: int | None = None, notes: dict[str, str] | None = None,
    question: str = "", context: str = "",
) -> CapabilityView:
    """The capability view for one step: eligibility from the registry's own
    admission rule; routing only when the eligible set does not fit.

    Two ways to set the size, and they do not mix: an author's per-node count
    (`limit`, from `visible_capabilities`) — "show this step at most N" — or,
    when the author set none, the deployment's schema budget in characters.
    Either way, a grant whose schemas fit is shown whole, exactly as before.
    """
    author_count = int(limit) if limit else 0
    budget = 0 if author_count else int(schema_budget or default_schema_budget())
    count_cap = author_count or default_limit()
    eligible: list[str] = []
    excluded: dict[str, str] = {}
    tools = tool_registry.all_tools()
    offered_today = {d.get("name"): d for d in
                     tool_registry.definitions_for(set(granted), web_enabled=web_enabled)}
    from app.services.agent_flows.contract import SKILL_GRANT_PREFIX

    extras = list(extras or [])
    tool_grants = [n for n in granted if not n.startswith(SKILL_GRANT_PREFIX)]
    for name in tool_grants:
        if name not in tools:
            excluded[name] = "unknown_tool"
            continue
        if name not in offered_today:
            excluded[name] = "gated"
            continue
        refused = tool_registry.admission_refusal(ctx, name)
        if refused is not None:
            excluded[name] = str(refused.get("error_code") or "refused")
            continue
        eligible.append(name)
    excluded.update(excluded_extras or {})
    eligible += [e.name for e in extras]
    sizes = {n: len(json.dumps(offered_today[n], ensure_ascii=False)) for n in eligible if n in offered_today}
    sizes.update({e.name: len(json.dumps(e.definition, ensure_ascii=False)) for e in extras})
    total = sum(sizes.values())
    fits = (len(eligible) <= author_count) if author_count else \
        (total <= budget and len(eligible) <= count_cap)
    view = CapabilityView(
        granted=[*tool_grants, *[e.name for e in extras], *list(excluded_extras or {})],
        eligible=eligible, excluded=excluded, limit=count_cap, schema_budget=budget,
        shortlisted=not fits, question=question, context=context,
    )
    view.extras = {e.name: e for e in extras}
    view._sizes = sizes
    notes = notes or {}
    view._haystacks = {
        n: _weighted_terms(view.extras[n].search if n in view.extras else tools[n], notes.get(n, ""))
        for n in eligible
    }
    return view
