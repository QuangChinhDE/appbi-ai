"""Which models an Agent step may run on.

WHY A CATALOGUE AND NOT A FREE TEXT BOX
---------------------------------------
A model name typed by hand is a silent failure: the provider returns 404 on the
first real question and the viewer sees a dead chat. Worse, the previous module had
a tier vocabulary (`fast`/`balanced`/`deep`) that was looked up in a table holding
different names, so the control did nothing at all and nobody noticed for weeks.
So the models are listed, and a step may only name one of these.

The list is deliberately short — the cheap one, the balanced one and the
reasoning one per vendor. It is not a mirror of every model each vendor ships,
because a picker with forty entries makes the author guess anyway.

WHAT A STEP CHOOSES, AND WHERE ITS KEY COMES FROM
-------------------------------------------------
A step chooses a PROVIDER and one of that provider's MODELS — that is the whole
choice the builder offers. Its key is a stored credential the step references by
id (`services/agent_flows/credentials.py`): encrypted, owned by a user, shareable,
never inside the flow body and never returned by any API.

There is no "inherit the link's model" any more, and no key from the server's
environment. Both were fallbacks that made a step run on something nobody chose
for it — including another vendor's key.
"""
from __future__ import annotations

from typing import Literal

Provider = Literal["openai", "anthropic", "gemini"]

PROVIDERS: tuple[str, ...] = ("openai", "anthropic", "gemini")

#: `label` is what the builder shows; `tier_hint` lets a picker group them without
#: reintroducing the tier vocabulary as a stored value — the step stores the MODEL
#: NAME, so what runs is exactly what the author chose.
#:
#: OpenAI names verified against the live `/v1/models` list on 2026-09-30.
MODELS: dict[str, list[dict[str, str]]] = {
    "openai": [
        {"model": "gpt-4o-mini", "label": "GPT-4o mini", "tier_hint": "fast"},
        {"model": "gpt-4o", "label": "GPT-4o", "tier_hint": "balanced"},
        # The model the reader pilot is certified on (AGENT_FLOW_DEFAULT_MODEL).
        {"model": "gpt-4.1", "label": "GPT-4.1", "tier_hint": "balanced"},
        {"model": "gpt-5", "label": "GPT-5", "tier_hint": "deep"},
    ],
    #: ONE CLAUDE MODEL, ON PURPOSE. Claude Sonnet 5.5 and Opus 5.5 always think,
    #: and a tool loop on them must send each thinking block back unchanged and
    #: never rewrite earlier turns. `stream_anthropic` drops thinking blocks and
    #: flattens the tool history on an agent's final round, so on those models a
    #: step would fail with a 400 on its second round. Haiku 4.5 does not think
    #: unless asked, which is the behaviour the adapter was built and used for.
    #: Adding the 5.5 models is: carry thinking blocks through the tool loop,
    #: then verify with a real key.
    "anthropic": [
        {"model": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "tier_hint": "fast"},
    ],
    "gemini": [
        {"model": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "tier_hint": "fast"},
        {"model": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "tier_hint": "deep"},
    ],
}

LABELS: dict[str, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic (Claude)",
    "gemini": "Google Gemini",
}

#: What a new step, and a stored step written before steps chose their own model,
#: runs on. `gpt-4o-mini` is what every such step actually ran on: the deployment
#: set no `AGENT_FLOW_DEFAULT_MODEL` and the adapter default is this model.
DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-4o-mini"


def known_model(provider: str, model: str) -> bool:
    return any(m["model"] == model for m in MODELS.get(provider, []))


def default_model(provider: str) -> str:
    models = MODELS.get(provider) or []
    return models[0]["model"] if models else ""


def legacy_default_model() -> str:
    """The model a legacy `inherit` step is brought forward to.

    The operator's `AGENT_FLOW_DEFAULT_MODEL` when it names a catalogued OpenAI
    model — that is what those steps ran on — else `gpt-4o-mini`.
    """
    try:
        from app.core.config import settings

        configured = str(getattr(settings, "AGENT_FLOW_DEFAULT_MODEL", "") or "").strip()
    except Exception:  # noqa: BLE001
        configured = ""
    return configured if known_model(DEFAULT_PROVIDER, configured) else DEFAULT_MODEL


def catalogue() -> list[dict]:
    """For the builder's two selects: provider, then that provider's models."""
    return [
        {"provider": prov, "label": LABELS.get(prov, prov), "models": list(models)}
        for prov, models in MODELS.items()
    ]
