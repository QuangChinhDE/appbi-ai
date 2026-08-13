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

Provider = Literal["openai"]

#: ONE VENDOR, DECIDED BY THE OPERATOR.
#:
#: The catalogue listed OpenAI, Anthropic and Gemini. The operator's decision is
#: that this product runs on OpenAI and the deployment supplies the token from
#: its own environment, so the other two are removed rather than left visible and
#: unusable — a picker offering a vendor nobody will ever hold a key for is a
#: 404 waiting for the first real question.
#:
#: This is NOT the same thing as hiding an option because today's server lacks a
#: key; that would break brain portability and is why `has_key` exists below
#: instead. This is the allowlist of what the product supports at all, which is
#: what this table has always been.
#:
#: Restoring a vendor is: put its entry back here and give the deployment a key.
#: Checked before removing — no stored flow pinned anything but `inherit`, so
#: nothing existing had to be migrated.
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
}

#: What a step gets when the author expresses no preference: whatever the link is
#: already configured with. A brain is reusable across links, so "inherit" is the
#: setting that keeps it reusable — pinning a provider ties the brain to
#: deployments that hold a key for that vendor.
INHERIT = "inherit"


def known_model(provider: str, model: str) -> bool:
    return any(m["model"] == model for m in MODELS.get(provider, []))


def _deployment_has_key(provider: str) -> bool:
    """Does THIS deployment hold a credential for that vendor right now?

    The token is the operator's, set in the server's environment — never on a
    step and never on a brain, for the reason in this module's docstring. So this
    is the single thing that decides whether any Agent step can run at all.
    """
    try:
        from app.core.config import settings

        attr = {"openai": "OPENAI_API_KEY"}.get(provider)
        return bool(attr and (getattr(settings, attr, "") or "").strip())
    except Exception:  # noqa: BLE001 — the picker must render without settings
        return False


def catalogue() -> list[dict]:
    """For the builder's model picker. Includes `inherit` as a first-class choice
    rather than an empty option, because "use the link's model" is a decision an
    author makes on purpose, not the absence of one.

    WHAT `has_key` IS FOR, NOW THAT THERE IS ONE VENDOR
    --------------------------------------------------
    It no longer decides whether to offer a choice — there is only one. It
    answers the question that replaced it: the deployment supplies the token, so
    if `OPENAI_API_KEY` is unset, EVERY Agent step in every flow is dead, and the
    author should learn that while building rather than from a viewer's blank
    answer. One flag, stated where the model is chosen.
    """
    out: list[dict] = [{
        "provider": INHERIT,
        "label": "Theo cấu hình của link",
        "models": [],
        "has_key": True,
        "note": "Dùng model đã cấu hình cho link. Token do máy chủ cung cấp.",
    }]
    labels = {"openai": "OpenAI"}
    for prov, models in MODELS.items():
        has_key = _deployment_has_key(prov)
        out.append({
            "provider": prov,
            "label": labels.get(prov, prov),
            "models": list(models),
            "has_key": has_key,
            "note": "Token lấy từ cấu hình máy chủ — không cần nhập ở đây."
            if has_key else (
                "Máy chủ CHƯA có OPENAI_API_KEY — mọi bước AI sẽ lỗi cho tới khi "
                "khoá được đặt trong .env của máy chủ."
            ),
        })
    return out
