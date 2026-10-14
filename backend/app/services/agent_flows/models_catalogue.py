"""Which models an Agent step may run on — and what is actually known about each.

WHY A CATALOGUE AND NOT A FREE TEXT BOX
---------------------------------------
A model name typed by hand is a silent failure: the provider returns 404 on the
first real question and the viewer sees a dead chat. So the models are listed,
and a step may only name one of these.

A MODEL IN THIS LIST IS A CLAIM, SO EACH ENTRY SAYS HOW FAR THE CLAIM GOES
------------------------------------------------------------------------
"Listed" used to mean "a vendor sells it". A key could be valid, the name could
be right, and the step still died: GPT-6 calls tools only through the Responses
API while the adapter spoke Chat Completions; Claude 5.5 thinks on every turn and
the adapter dropped the thinking blocks its tool loop must send back. So every
entry now records, separately:

* `lifecycle` — the VENDOR's word: active, legacy (still served, superseded),
  deprecated (retirement date set), retired (requests fail). With the
  vendor's earliest retirement date and its recommended replacement.
* `endpoint` — the protocol AppBI uses for it (`responses`, `chat_completions`,
  `messages`, `openai_compat`). A model is offered only when its adapter exists.
* `tools` / `reasoning` — the capabilities the step relies on.
* `certification` — what AppBI ITSELF ran against the real vendor: `certified`
  (text, streaming, tool calls and multi-round tool loops passed live — see
  `evidence`), `legacy_verified` (the model the existing evaluations ran on),
  or `unverified` (protocol implemented and mock-tested; no live run, with the
  reason). The picker shows it; nothing is called "ready" on a model-list probe.
* `price` — USD per 1M tokens with its SOURCE and the date it was read. Unknown
  is left unknown.

WHAT A STEP CHOOSES, AND WHERE ITS KEY COMES FROM
-------------------------------------------------
A step chooses a PROVIDER and one of that provider's MODELS. Its key is a stored
credential the step references by id (`services/agent_flows/credentials.py`).
What runs is exactly what the author chose: there is no fallback to another
model, another tier or another vendor.

STORED FLOWS DO NOT MOVE
------------------------
A model leaving the vendor's lineup is marked, never deleted from here: a stored
or published flow naming it must still parse, and its author is shown the
warning and the replacement. And the model an EMPTY field means is pinned
(`_EMPTY_MEANS`), so re-ordering this list for the picker can never change what
an old step runs on.
"""
from __future__ import annotations

from typing import Any, Literal

Provider = Literal["openai", "anthropic", "gemini"]

PROVIDERS: tuple[str, ...] = ("openai", "anthropic", "gemini")

_OPENAI_SRC = "https://developers.openai.com/api/docs/models"
_OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing"
_ANTHROPIC_SRC = "https://platform.claude.com/docs/en/models/overview"
_ANTHROPIC_LIFE = "https://platform.claude.com/docs/en/about-claude/model-deprecations"
_GEMINI_SRC = "https://ai.google.dev/gemini-api/docs/models"
_GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing"
_READ_ON = "2026-10-12"


def _price(inp: float | None, out: float | None, source: str, note: str = "") -> dict:
    return {"input_per_mtok": inp, "output_per_mtok": out, "currency": "USD",
            "source": source, "as_of": _READ_ON, **({"note": note} if note else {})}


def _cert(status: str, *, evidence: str = "", reason: str = "") -> dict:
    return {"status": status, "as_of": _READ_ON,
            **({"evidence": evidence} if evidence else {}), **({"reason": reason} if reason else {})}


_LIVE = "docs/features/ai-model-compatibility/evidence/live_certification.json"
_NO_ANTHROPIC_KEY = "Chưa có Anthropic API key hợp lệ để chạy kiểm chứng thật."
_NO_GEMINI_KEY = "Gemini API key của môi trường kiểm thử bị Google từ chối (API_KEY_INVALID)."
_STD = "Bậc Standard, đầu vào ≤272K token; Batch/Flex/Fast có giá khác."

#: Display order = the order the picker shows: recommended first.
MODELS: dict[str, list[dict[str, Any]]] = {
    "openai": [
        {"model": "gpt-6-luna", "label": "GPT-6 Luna", "tier_hint": "fast",
         "purpose": "Nhanh, chi phí thấp — hỏi đáp số liệu thường ngày, khối lượng lớn.",
         "lifecycle": "active", "endpoint": "responses", "tools": True, "streaming": True,
         "reasoning": "effort", "reasoning_effort": "low", "max_output_tokens": 16000,
         "context_tokens": 1_050_000, "recommended": True,
         "price": _price(0.10, 0.50, _OPENAI_PRICING, _STD),
         "certification": _cert("certified", evidence=_LIVE)},
        {"model": "gpt-6.1-sol", "label": "GPT-6.1 Sol", "tier_hint": "balanced",
         "purpose": "Cân bằng chất lượng và chi phí — phân tích nhiều bước.",
         "lifecycle": "active", "endpoint": "responses", "tools": True, "streaming": True,
         "reasoning": "effort", "reasoning_effort": "low", "max_output_tokens": 16000,
         "context_tokens": 1_050_000, "recommended": True,
         "price": _price(2.0, 10.0, _OPENAI_PRICING, _STD),
         "certification": _cert("certified", evidence=_LIVE)},
        {"model": "gpt-6-astra", "label": "GPT-6 Astra", "tier_hint": "deep",
         "purpose": "Mạnh nhất — suy luận phức tạp; chậm và đắt nhất.",
         "lifecycle": "active", "endpoint": "responses", "tools": True, "streaming": True,
         "reasoning": "effort", "reasoning_effort": "low", "max_output_tokens": 16000,
         "context_tokens": 1_050_000,
         "price": _price(10.0, 50.0, _OPENAI_PRICING, _STD),
         "certification": _cert("certified", evidence=_LIVE)},
        {"model": "gpt-4o-mini", "label": "GPT-4o mini", "tier_hint": "fast",
         "purpose": "Thế hệ trước — model mà các Flow hiện có đã được đánh giá trên đó.",
         "lifecycle": "legacy", "replacement": "gpt-6-luna",
         "endpoint": "chat_completions", "tools": True, "streaming": True, "reasoning": "none",
         "max_output_tokens": 4096, "context_tokens": 128_000,
         "price": _price(0.15, 0.60, _OPENAI_PRICING, _STD),
         "certification": _cert("certified", evidence=_LIVE)},
        {"model": "gpt-4o", "label": "GPT-4o", "tier_hint": "balanced",
         "purpose": "Thế hệ trước.", "lifecycle": "legacy", "replacement": "gpt-6.1-sol",
         "endpoint": "chat_completions", "tools": True, "streaming": True, "reasoning": "none",
         "max_output_tokens": 4096, "context_tokens": 128_000,
         "price": _price(2.5, 10.0, _OPENAI_PRICING, _STD),
         "certification": _cert("unverified", reason="Không chạy lại trong đợt chứng nhận này.")},
        {"model": "gpt-4.1", "label": "GPT-4.1", "tier_hint": "balanced",
         "purpose": "Thế hệ trước.", "lifecycle": "legacy", "replacement": "gpt-6.1-sol",
         "endpoint": "chat_completions", "tools": True, "streaming": True, "reasoning": "none",
         "max_output_tokens": 4096, "context_tokens": 1_000_000,
         "price": _price(2.0, 8.0, _OPENAI_PRICING, _STD),
         "certification": _cert("unverified", reason="Không chạy lại trong đợt chứng nhận này.")},
        {"model": "gpt-5", "label": "GPT-5", "tier_hint": "deep",
         "purpose": "Thế hệ trước.", "lifecycle": "legacy", "replacement": "gpt-6-astra",
         "endpoint": "chat_completions", "tools": True, "streaming": True, "reasoning": "hidden",
         "max_output_tokens": 16000, "context_tokens": 400_000,
         "price": _price(1.25, 10.0, _OPENAI_PRICING, _STD),
         "certification": _cert("unverified", reason="Không chạy lại trong đợt chứng nhận này.")},
    ],
    "anthropic": [
        {"model": "claude-haiku-5-5", "label": "Claude Haiku 5.5", "tier_hint": "fast",
         "purpose": "Nhanh nhất của Claude — phân loại, trích xuất, hỏi đáp ngắn.",
         "lifecycle": "active", "retire_after": "2027-10-07", "endpoint": "messages",
         "tools": True, "streaming": True, "reasoning": "adaptive", "max_output_tokens": 16000,
         "context_tokens": 1_000_000,
         "price": _price(0.10, 0.50, _ANTHROPIC_SRC, "Giá 'từ' (from) theo trang chính thức."),
         "certification": _cert("unverified", reason=_NO_ANTHROPIC_KEY)},
        {"model": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "tier_hint": "balanced",
         "purpose": "Cân bằng tốc độ và chất lượng.",
         "lifecycle": "active", "retire_after": "2027-09-28", "endpoint": "messages",
         "tools": True, "streaming": True, "reasoning": "adaptive", "max_output_tokens": 16000,
         "context_tokens": 1_000_000, "price": _price(2.0, 10.0, _ANTHROPIC_SRC),
         "certification": _cert("unverified", reason=_NO_ANTHROPIC_KEY)},
        {"model": "claude-opus-5-5", "label": "Claude Opus 5.5", "tier_hint": "deep",
         "purpose": "Công việc tri thức và agent dài hơi.",
         "lifecycle": "active", "retire_after": "2027-09-22", "endpoint": "messages",
         "tools": True, "streaming": True, "reasoning": "adaptive", "max_output_tokens": 16000,
         "context_tokens": 1_000_000, "price": _price(4.0, 20.0, _ANTHROPIC_SRC),
         "certification": _cert("unverified", reason=_NO_ANTHROPIC_KEY)},
        {"model": "claude-fable-5-1", "label": "Claude Fable 5.1", "tier_hint": "deep",
         "purpose": "Suy luận khó nhất; chậm nhất.",
         "lifecycle": "active", "retire_after": "2027-09-01", "endpoint": "messages",
         "tools": True, "streaming": True, "reasoning": "adaptive", "max_output_tokens": 16000,
         "context_tokens": 1_000_000, "price": _price(10.0, 50.0, _ANTHROPIC_SRC),
         "certification": _cert("unverified", reason=_NO_ANTHROPIC_KEY)},
        {"model": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "tier_hint": "fast",
         "purpose": "Thế hệ trước.", "lifecycle": "legacy", "retire_after": "2026-10-15",
         "replacement": "claude-haiku-5-5", "endpoint": "messages", "tools": True,
         "streaming": True, "reasoning": "none", "max_output_tokens": 4096,
         "context_tokens": 200_000,
         "price": _price(1.0, 5.0, "https://platform.claude.com/docs/en/about-claude/pricing"),
         "certification": _cert("unverified", reason=_NO_ANTHROPIC_KEY),
         "lifecycle_source": _ANTHROPIC_LIFE},
    ],
    "gemini": [
        {"model": "gemini-3.8-flash", "label": "Gemini 3.8 Flash", "tier_hint": "balanced",
         "purpose": "Flash mạnh nhất, hướng tới agent tự hành.",
         "lifecycle": "active", "endpoint": "openai_compat", "tools": True, "streaming": True,
         "reasoning": "thinking_level", "max_output_tokens": 16000, "context_tokens": None,
         "price": _price(0.75, 3.75, _GEMINI_PRICING,
                         "Giá đến 2026-12-31; từ 2027-01-01 là 1.50 / 7.50."),
         "certification": _cert("unverified", reason=_NO_GEMINI_KEY)},
        {"model": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite", "tier_hint": "fast",
         "purpose": "Nhanh, rẻ cho khối lượng lớn.",
         "lifecycle": "active", "endpoint": "openai_compat", "tools": True, "streaming": True,
         "reasoning": "thinking_level", "max_output_tokens": 16000, "context_tokens": None,
         "price": _price(0.30, 2.50, _GEMINI_PRICING),
         "certification": _cert("unverified", reason=_NO_GEMINI_KEY)},
        {"model": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "tier_hint": "fast",
         "purpose": "Thế hệ trước — chỉ tài khoản đã từng dùng mới truy cập được.",
         "lifecycle": "legacy", "replacement": "gemini-3.8-flash", "endpoint": "openai_compat",
         "tools": True, "streaming": True, "reasoning": "thinking_budget",
         "max_output_tokens": 8192, "context_tokens": 1_048_576,
         "price": _price(0.30, 2.50, _GEMINI_PRICING),
         "certification": _cert("unverified", reason=_NO_GEMINI_KEY)},
        {"model": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "tier_hint": "deep",
         "purpose": "Thế hệ trước — chỉ tài khoản đã từng dùng mới truy cập được.",
         "lifecycle": "legacy", "replacement": "gemini-3.8-flash", "endpoint": "openai_compat",
         "tools": True, "streaming": True, "reasoning": "thinking_budget",
         "max_output_tokens": 8192, "context_tokens": 1_048_576,
         "price": _price(1.25, 10.0, _GEMINI_PRICING, "Prompt >200K: 2.50 / 15.00."),
         "certification": _cert("unverified", reason=_NO_GEMINI_KEY)},
    ],
}

LABELS: dict[str, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic (Claude)",
    "gemini": "Google Gemini",
}

#: What a new step, and a stored step written before steps chose their own model,
#: runs on. `gpt-4o-mini` is what every such step actually ran on.
DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-4o-mini"

#: WHAT AN EMPTY `model` MEANS, per provider — pinned. It used to be "the first
#: entry", which made the picker's display order part of the stored-flow
#: contract: putting GPT-6 first would have silently moved every step saved with
#: only a provider onto a different model. These are the models such steps ran on.
_EMPTY_MEANS: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-4-5",
    "gemini": "gemini-2.5-flash",
}

#: The intent pass's model per provider: a short classification on the step's own
#: key, so the provider's fast CURRENT model (a new Gemini key cannot use 2.5).
#: It is not the step's answer model, and its failure is not fatal (heuristics).
_INTENT_MODEL: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-5-5",
    "gemini": "gemini-3.5-flash-lite",
}

#: Protocols with an adapter. A model whose endpoint is not here is not offered.
SUPPORTED_ENDPOINTS = {
    "openai": {"chat_completions", "responses"},
    "anthropic": {"messages"},
    "gemini": {"openai_compat"},
}


def spec(provider: str, model: str) -> dict[str, Any] | None:
    for m in MODELS.get(provider, []):
        if m["model"] == model:
            return m
    return None


def known_model(provider: str, model: str) -> bool:
    return spec(provider, model) is not None


def selectable(provider: str, model: str) -> bool:
    """May a step be newly pointed at this model? Not retired, adapter exists."""
    s = spec(provider, model)
    return bool(s) and s.get("lifecycle") != "retired" \
        and s.get("endpoint") in SUPPORTED_ENDPOINTS.get(provider, set())


def default_model(provider: str) -> str:
    """What an empty `model` field means for this provider. Pinned — see `_EMPTY_MEANS`."""
    return _EMPTY_MEANS.get(provider, "")


def intent_model(provider: str) -> str:
    return _INTENT_MODEL.get(provider, "")


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


def lifecycle_warning(provider: str, model: str) -> str:
    """One sentence for an author whose step names a model the vendor is moving away from."""
    s = spec(provider, model)
    if not s:
        return ""
    life = s.get("lifecycle")
    repl = s.get("replacement")
    then = f" Đề xuất chuyển sang {repl}." if repl else ""
    if life == "retired":
        return f"{s['label']} đã bị nhà cung cấp ngừng hỗ trợ — bước này sẽ không chạy được.{then}"
    if life == "deprecated":
        when = f" (ngừng sau {s['retire_after']})" if s.get("retire_after") else ""
        return f"{s['label']} sắp bị ngừng hỗ trợ{when}.{then}"
    if life == "legacy":
        when = f" Nhà cung cấp có thể ngừng sau {s['retire_after']}." if s.get("retire_after") else ""
        return f"{s['label']} là thế hệ trước.{when}{then}"
    return ""


def catalogue() -> list[dict]:
    """For the builder: provider, then that provider's models with what is known
    about each. Models without an adapter are not offered."""
    out = []
    for prov, models in MODELS.items():
        offered = [{**m, "selectable": selectable(prov, m["model"]),
                    "lifecycle_warning": lifecycle_warning(prov, m["model"])}
                   for m in models if m.get("endpoint") in SUPPORTED_ENDPOINTS.get(prov, set())]
        out.append({"provider": prov, "label": LABELS.get(prov, prov), "models": offered})
    return out
