"""Capability discovery — the router controls VISIBILITY; the registry controls AUTHORITY.

THE PROBLEM
-----------
Every capability an Agent step was granted went to the model as a full JSON
schema on every round. All 36 tools are ~28.5k characters of schema; a step
granted a broad set paid for all of it on every round, and the catalogue only
grows (Skills are capabilities too). Context grew linearly with the grant.

THE VIEW, PER ROUND
-------------------
    granted    what the author granted this step
    eligible   granted AND admissible here — the registry's own admission rule
               (`registry.admission_refusal`: risk, web, raw rows, availability),
               so nothing certain to be refused is offered
    visible    all eligible, when there are no more than `limit`; otherwise the
               core (discovery + compute + find_capability), anything discovered or
               invoked earlier in this step, and the best-ranked for the question,
               up to `limit`

`find_capability` searches ELIGIBLE capabilities only and makes what it finds
visible on the next round. It cannot reveal a capability that is ungranted,
inadmissible, or out of scope — it has nothing else to search.

AUTHORITY IS NOT HERE
---------------------
A visible capability still goes through `registry.execute()` (or, later, the
Skill invoker), which re-checks the grant, scope, capability flags, risk and
budget. The view only ever NARROWS what the model is shown. What the view adds
is one refusal: a model may not invoke a granted capability it has not been
shown this turn (`capability_not_visible`) — it discovers it first. There is no
hidden path by which remembering a name is enough.

When a step's grant fits within `limit`, every eligible capability is visible and
nothing about the step changes — which is every existing flow and the V1 starter.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

from app.services.agent_flows.tools import registry as tool_registry

FIND_CAPABILITY = "find_capability"

#: Offered on every round of a shortlisted step, when granted and eligible: the
#: tools that hand out the chart ids every analytical tool needs (the contract's
#: own `_CHART_LOOKUP_TOOLS` — one definition of "a way in"), and the one that
#: computes over what they find.
#:
#: MEASURED, NOT ASSUMED. The first core held only the two discover tools. Live,
#: on the same 32-capability grant, the shortlisted step answered 3 of 6 questions
#: and the unshortlisted one 6 of 6: with everything shown the model opened with
#: `list_charts`, got real ids and ranked; shortlisted, `list_charts` was not
#: there, so it guessed ids and was refused (`bad_argument`, `chart_out_of_scope`).
def _core() -> tuple[str, ...]:
    from app.services.agent_flows.contract import _CHART_LOOKUP_TOOLS

    return (*sorted(_CHART_LOOKUP_TOOLS), "compute")


CORE = _core()

_WORD_RE = re.compile(r"[0-9A-Za-zÀ-ỹ]+", re.UNICODE)

FIND_DEFINITION = {
    "name": FIND_CAPABILITY,
    "description": (
        "Find a capability you are allowed to use but have not been shown yet. "
        "Describe what you need in a few words (e.g. \"compare two periods\", "
        "\"forecast\", \"share of total\"). Returns matching capabilities; their "
        "full definitions are available from your next turn. Only capabilities "
        "granted to this step can be found."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "what you need to do"}},
        "required": ["query"],
    },
}


def default_limit() -> int:
    try:
        from app.core.config import settings

        return max(1, int(getattr(settings, "AGENT_FLOW_VISIBLE_CAPABILITIES", 12)))
    except Exception:                                           # noqa: BLE001
        return 12


def _fold(text: str) -> str:
    from app.core.text_fold import fold_text

    return fold_text(text or "")


def _terms(text: str) -> set[str]:
    """Words, plus adjacent word PAIRS. "dự báo" is one idea; as two separate
    words it matches every description that happens to say "dự" and "báo"
    somewhere apart."""
    words = [t for t in _WORD_RE.findall(_fold(text)) if len(t) > 1]
    return set(words) | {f"{a}_{b}" for a, b in zip(words, words[1:])}


#: How directly a field describes the capability. The label and the example
#: questions are what it IS for; the Vietnamese description explains it; the
#: English model-facing definition is long and full of generic words.
_FIELD_WEIGHTS = (("label", 3.0), ("answers", 3.0), ("description", 2.0), ("definition", 1.0))


def _weighted_terms(spec: Any) -> dict[str, float]:
    definition = getattr(spec, "definition", None) or {}
    returns = getattr(spec, "returns", None) or {}
    fields = {
        "label": " ".join(filter(None, [getattr(spec, "name", "").replace("_", " "),
                                        getattr(spec, "label_vi", ""), getattr(spec, "label_en", "")])),
        "answers": " ".join(getattr(spec, "answers_vi", ()) or ()),
        "description": " ".join(filter(None, [getattr(spec, "description_vi", ""),
                                              *[f"{k} {v}" for k, v in returns.items()]])),
        "definition": str(definition.get("description") or ""),
    }
    out: dict[str, float] = {}
    for fname, weight in _FIELD_WEIGHTS:
        for term in _terms(fields[fname]):
            out[term] = max(out.get(term, 0.0), weight)
    return out


@dataclass
class ExtraCapability:
    """A capability that is not a registry tool — today, a published Skill.

    It is ranked, shown and discovered exactly like a tool; only its execution
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
    limit: int
    #: False when every eligible capability fits: the step is shown them all and
    #: behaves exactly as it always has.
    shortlisted: bool
    #: Discovered or invoked in this step — stays visible once seen.
    sticky: list[str] = field(default_factory=list)
    visible: list[str] = field(default_factory=list)
    rounds: list[list[str]] = field(default_factory=list)
    discovered: list[str] = field(default_factory=list)
    invoked: list[str] = field(default_factory=list)
    rejected: list[dict[str, str]] = field(default_factory=list)
    _haystacks: dict[str, dict[str, float]] = field(default_factory=dict, repr=False)
    extras: dict[str, ExtraCapability] = field(default_factory=dict, repr=False)

    # ── ranking ──────────────────────────────────────────────────────────────
    def _weights(self) -> dict[str, float]:
        """Rarer words count more. "nào", "bao nhiêu" appear in half the
        catalogue's example questions; a term only one capability carries is what
        actually tells them apart. Computed over the ELIGIBLE set, so it adapts to
        whatever this step was granted — no stop-word list to maintain."""
        df: dict[str, int] = {}
        for terms in self._haystacks.values():
            for t in terms:
                df[t] = df.get(t, 0) + 1
        n = max(1, len(self._haystacks))
        return {t: math.log(1 + n / c) for t, c in df.items()}

    def rank(self, query: str) -> list[tuple[str, float]]:
        """Σ over the query's words and word pairs: rarity × how directly the
        field that matched describes the capability."""
        wanted = _terms(query)
        weights = self._weights()
        scored = []
        for name in self.eligible:
            hay = self._haystacks.get(name, {})
            scored.append((name, sum(weights.get(t, 0.0) * hay[t] for t in wanted if t in hay)))
        # Stable: ties keep the grant order, which is the author's order.
        return sorted(scored, key=lambda x: -x[1])

    # ── per round ────────────────────────────────────────────────────────────
    def refresh(self, query: str) -> list[str]:
        """The capabilities visible on the next round."""
        if not self.shortlisted:
            self.visible = list(self.eligible)
        else:
            chosen: list[str] = []
            for name in [*(c for c in CORE if c in self.eligible), *self.sticky]:
                if name not in chosen:
                    chosen.append(name)
            for name, score in self.rank(query):
                if len(chosen) >= self.limit:
                    break
                if score > 0 and name not in chosen:
                    chosen.append(name)
            self.visible = chosen[: max(self.limit, len(chosen))]
        self.rounds.append(list(self.visible))
        return self.visible

    def schemas(self, *, web_enabled: bool) -> list[dict]:
        defs = tool_registry.definitions_for(set(self.visible), web_enabled=web_enabled)
        defs += [self.extras[n].definition for n in self.visible if n in self.extras]
        # In the author's grant order, like every other list here.
        order = {n: i for i, n in enumerate(self.granted)}
        defs.sort(key=lambda d: order.get(d.get("name"), 1_000))
        if self.shortlisted:
            defs.append(FIND_DEFINITION)
        return defs

    def is_visible(self, name: str) -> bool:
        return name in self.visible

    # ── discovery ────────────────────────────────────────────────────────────
    def discover(self, query: str, *, top: int = 5) -> dict:
        """Search ELIGIBLE capabilities. Never anything else: that set is the
        whole of what this function can see."""
        hits = [(n, s) for n, s in self.rank(query) if s > 0][:top]
        tools = tool_registry.all_tools()
        found = []
        for name, score in hits:
            spec = tools.get(name)
            extra = self.extras.get(name)
            found.append({
                "name": name,
                "label": (extra.label if extra else getattr(spec, "label_vi", "")) or name,
                "does": (extra.does if extra else getattr(spec, "description_vi", "")) or "",
                "already_visible": name in self.visible,
            })
            if name not in self.sticky:
                self.sticky.append(name)
            if name not in self.discovered:
                self.discovered.append(name)
        return {
            "ok": True,
            "kind": "value",
            "data": {
                "query": query,
                "found": found,
                "note": (
                    "Các khả năng trên sẽ có đầy đủ định nghĩa ở lượt tiếp theo."
                    if found else
                    "Không có khả năng nào được cấp cho bước này khớp với yêu cầu — "
                    "trả lời bằng những gì đã có và nói rõ phần không làm được."
                ),
            },
        }

    # ── bookkeeping ──────────────────────────────────────────────────────────
    def note_invoked(self, name: str) -> None:
        if name not in self.invoked:
            self.invoked.append(name)
        if self.shortlisted and name not in self.sticky and name != FIND_CAPABILITY:
            self.sticky.append(name)

    def note_rejected(self, name: str, code: str) -> None:
        self.rejected.append({"name": name, "code": code})

    def to_trace(self) -> dict:
        return {
            "granted": list(self.granted),
            "eligible": list(self.eligible),
            "excluded": dict(self.excluded),
            "limit": self.limit,
            "shortlisted": self.shortlisted,
            "visible_per_round": [list(r) for r in self.rounds],
            "discovered": list(self.discovered),
            "invoked": list(self.invoked),
            "rejected": list(self.rejected),
        }


def build_view(
    granted: list[str], ctx: Any, *, web_enabled: bool, limit: int | None = None,
    extras: list[ExtraCapability] | None = None, excluded_extras: dict[str, str] | None = None,
) -> CapabilityView:
    """The capability view for one step: eligibility from the registry's own
    admission rule, shortlisting only when the eligible set exceeds `limit`.

    `shortlisted` is decided on what the step would be shown TODAY
    (`definitions_for`), so a step whose current schema list fits within the
    limit is shown exactly that list, unchanged.
    """
    limit = int(limit or default_limit())
    eligible: list[str] = []
    excluded: dict[str, str] = {}
    tools = tool_registry.all_tools()
    offered_today = {d.get("name") for d in tool_registry.definitions_for(set(granted), web_enabled=web_enabled)}
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
    view = CapabilityView(
        granted=[*tool_grants, *[e.name for e in extras], *list(excluded_extras or {})],
        eligible=eligible, excluded=excluded, limit=limit,
        shortlisted=len(offered_today) + len(extras) > limit,
    )
    view.extras = {e.name: e for e in extras}
    view._haystacks = {
        n: _weighted_terms(view.extras[n].search if n in view.extras else tools[n])
        for n in eligible
    }
    return view


def schema_chars(defs: list[dict]) -> int:
    """How much schema text a round carries — what the shortlist exists to bound."""
    return sum(len(json.dumps(d, ensure_ascii=False)) for d in defs)
