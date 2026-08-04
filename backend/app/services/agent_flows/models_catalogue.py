"""Which model an Agent step may run on, and where its credential comes from.

WHY A CATALOGUE AND NOT A FREE TEXT BOX
---------------------------------------
A model name typed by hand is a silent failure: the provider returns 404 on the
first real question and the viewer sees a dead chat. Worse, the previous module had
a tier vocabulary (`fast`/`balanced`/`deep`) that was looked up in a table holding
different names, so the control did nothing at all and nobody noticed for weeks.
So the models are listed, and a step may only name one of these.

The list is deliberately short — the current flagship, the cheap one, and the
reasoning one per vendor. It is not a mirror of every model each vendor ships,
because a picker with forty entries makes the author guess anyway.

WHERE THE API KEY IS *NOT*
--------------------------
Not in the step, and not in the brain.

A brain is shareable and exportable. If a step carried its own key, sharing a brain
would hand over the key, and exporting one would write it into a file somebody
mails around. So a step names a PROVIDER and a MODEL; the credential is resolved at
run time from what the deployment holds for that provider.

That is a deliberate limit worth stating plainly: two brains cannot bill to two
different OpenAI accounts. If per-brain billing is genuinely wanted, the right shape
is a stored credential resource — encrypted, permissioned, referenced by id, the way
datasource credentials already work here — and NOT a token field on a step. Adding
the field would be quick and would leak keys through the share dialog on the first
day somebody used it.
"""
from __future__ import annotations

from typing import Literal

Provider = Literal["openai", "anthropic", "gemini"]

#: Models this deployment will accept on a step, per provider.
#:
#: `label` is what the builder shows; `tier_hint` lets a picker group them without
#: reintroducing the tier vocabulary as a stored value — the step stores the MODEL
#: NAME, so what runs is exactly what the author chose.
MODELS: dict[str, list[dict[str, str]]] = {
    "openai": [
        {"model": "gpt-4o-mini", "label": "GPT-4o mini", "tier_hint": "fast"},
        {"model": "gpt-4o", "label": "GPT-4o", "tier_hint": "balanced"},
        {"model": "gpt-5", "label": "GPT-5", "tier_hint": "deep"},
    ],
    "anthropic": [
        {"model": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "tier_hint": "fast"},
        {"model": "claude-sonnet-4-5", "label": "Claude Sonnet 4.5", "tier_hint": "balanced"},
        {"model": "claude-opus-4-5", "label": "Claude Opus 4.5", "tier_hint": "deep"},
    ],
    "gemini": [
        {"model": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "tier_hint": "fast"},
        {"model": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "tier_hint": "deep"},
    ],
}

#: What a step gets when the author expresses no preference: whatever the link is
#: already configured with. A brain is reusable across links, so "inherit" is the
#: setting that keeps it reusable — pinning a provider ties the brain to
#: deployments that hold a key for that vendor.
INHERIT = "inherit"


def known_model(provider: str, model: str) -> bool:
    return any(m["model"] == model for m in MODELS.get(provider, []))


def catalogue() -> list[dict]:
    """For the builder's model picker. Includes `inherit` as a first-class choice
    rather than an empty option, because "use the link's model" is a decision an
    author makes on purpose, not the absence of one."""
    out: list[dict] = [{
        "provider": INHERIT,
        "label": "Theo cấu hình của link",
        "models": [],
        "note": "Giữ bộ não dùng lại được trên mọi link, kể cả link dùng nhà cung cấp khác.",
    }]
    labels = {"openai": "OpenAI", "anthropic": "Anthropic (Claude)", "gemini": "Google (Gemini)"}
    for prov, models in MODELS.items():
        out.append({"provider": prov, "label": labels[prov], "models": list(models), "note": ""})
    return out
