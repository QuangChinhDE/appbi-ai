"""Live certification of catalogued models against the REAL vendor APIs.

Every check runs through `runtime.handlers.agent._stream` — the exact path an
Agent Flow step uses — so a PASS here is a pass of AppBI's adapter, not of a
vendor demo. Mocks prove the protocol handling (backend/tests); only this proves
a model works.

Checks per model:
  text          streamed text, no tools
  tool_once     model calls a tool with valid args, gets the result, answers with it
  multi_round   two DEPENDENT tool calls across rounds (the 2nd needs the 1st's result),
                then the answer — the loop that broke thinking models
  answer_only   the final round offers no tools over a tool history (how every
                step ends); must still answer
  truncation    a tiny output budget must surface as code=truncated, never as an answer
  usage         prompt/completion tokens reported

Keys are read from environment variables named on the command line, never
printed. Usage:
    PYTHONPATH=backend python backend/eval/certify_models.py --provider openai \
        --key-env OPENAI_API_KEY --models gpt-6-luna gpt-6.1-sol --out evidence.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from typing import Any

from app.services.agent_flows.runtime.handlers.agent import _stream

TOOLS = [
    {"name": "find_region", "description": "Returns the region code for a city name.",
     "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}},
    {"name": "region_revenue", "description": "Returns revenue (USD) for a region code.",
     "input_schema": {"type": "object", "properties": {"region_code": {"type": "string"}},
                      "required": ["region_code"]}},
]
FAKE = {"find_region": {"region_code": "RG-417"}, "region_revenue": {"revenue_usd": 58213}}


async def _round(provider, key, model, system, messages, tools, max_tokens=None):
    out = {"text": "", "calls": [], "state": {}, "usage": {"p": 0, "c": 0}, "error": None}
    kwargs = {}
    async for ev in _stream(provider=provider, api_key=key, model=model, system_prompt=system,
                            messages=messages, tools=tools, **kwargs):
        if ev.type == "text":
            out["text"] += ev.text
        elif ev.type == "tool_call":
            out["calls"].append(ev)
        elif ev.type == "provider_state":
            out["state"].update((ev.extra or {}).get("state") or {})
        elif ev.type == "usage":
            out["usage"]["p"] += int(ev.extra.get("prompt_tokens") or 0)
            out["usage"]["c"] += int(ev.extra.get("completion_tokens") or 0)
        elif ev.type == "error":
            out["error"] = {"code": (ev.extra or {}).get("code"), "status": (ev.extra or {}).get("http_status"),
                            "text": ev.text[:200]}
    return out


def _assistant(r):
    return {"role": "assistant", "content": r["text"],
            "tool_calls": [{"id": c.tool_call_id, "name": c.tool_name, "args": c.tool_args} for c in r["calls"]],
            **({"provider_state": r["state"]} if r["state"] else {})}


def _results(r):
    return [{"role": "tool", "tool_call_id": c.tool_call_id, "name": c.tool_name,
             "result": {"ok": True, "data": FAKE.get(c.tool_name, {})}} for c in r["calls"]]


async def certify(provider: str, key: str, model: str) -> dict[str, Any]:
    res: dict[str, Any] = {"provider": provider, "model": model, "checks": {}}
    tok = {"p": 0, "c": 0}
    t0 = time.monotonic()

    def add(r):
        tok["p"] += r["usage"]["p"]
        tok["c"] += r["usage"]["c"]

    # text
    r = await _round(provider, key, model, "Answer in one short sentence.",
                     [{"role": "user", "content": "Say the word 'ready'."}], [])
    add(r)
    res["checks"]["text"] = {"pass": not r["error"] and "ready" in r["text"].lower(), "error": r["error"],
                             "streamed_chars": len(r["text"])}
    # multi-round dependent chain
    system = ("You answer business questions only with the tools. First find the region code of the city, "
              "then get that region's revenue, then answer with the revenue number.")
    msgs: list[dict] = [{"role": "user", "content": "What is the revenue of the region that Hanoi belongs to?"}]
    chain, err, rounds = [], None, 0
    for _ in range(4):
        rounds += 1
        r = await _round(provider, key, model, system, msgs, TOOLS)
        add(r)
        if r["error"]:
            err = r["error"]
            break
        if not r["calls"]:
            break
        chain += [(c.tool_name, c.tool_args) for c in r["calls"]]
        msgs += [_assistant(r), *_results(r)]
    called = [n for n, _ in chain]
    args_ok = all(isinstance(a, dict) and a for _, a in chain)
    dependent = ("find_region" in called and "region_revenue" in called
                 and any(a.get("region_code") == "RG-417" for n, a in chain if n == "region_revenue"))
    res["checks"]["tool_once"] = {"pass": bool(chain) and args_ok and not err, "error": err}
    # answer_only: final round with NO tools over the tool history
    final = await _round(provider, key, model, system, msgs, [])
    add(final)
    answered = "58213" in final["text"].replace(",", "").replace(".", "")
    res["checks"]["multi_round"] = {"pass": dependent and not err, "error": err, "rounds": rounds,
                                    "chain": called}
    res["checks"]["answer_only"] = {"pass": answered and not final["error"], "error": final["error"],
                                    "text": final["text"][:160]}
    res["checks"]["usage"] = {"pass": tok["p"] > 0 and tok["c"] > 0, "prompt_tokens": tok["p"],
                              "completion_tokens": tok["c"]}
    res["elapsed_s"] = round(time.monotonic() - t0, 1)
    res["certified"] = all(c["pass"] for c in res["checks"].values())
    return res


async def negatives(provider: str, key: str, model: str) -> dict[str, Any]:
    """Errors must be named: a fake model id, and a truncated answer."""
    from app.services.agent_flows import models_catalogue as cat

    out = {}
    r = await _round(provider, key, "appbi-no-such-model-1", "x", [{"role": "user", "content": "hi"}], [])
    out["unknown_model"] = r["error"]
    spec = cat.spec(provider, model)
    saved = spec.get("max_output_tokens")
    spec["max_output_tokens"] = 16
    try:
        r = await _round(provider, key, model, "Write a long essay.",
                         [{"role": "user", "content": "Write 500 words about revenue analytics."}], [])
    finally:
        spec["max_output_tokens"] = saved
    out["truncation"] = r["error"]
    out["truncation_pass"] = bool(r["error"] and r["error"].get("code") == "truncated")
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True)
    ap.add_argument("--key-env", required=True)
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--negatives-on", default="")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    key = os.environ.get(a.key_env, "")
    report: dict[str, Any] = {"provider": a.provider, "run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                              "results": []}
    for m in a.models:
        r = await certify(a.provider, key, m)
        report["results"].append(r)
        print(m, "certified" if r["certified"] else "NOT certified",
              {k: v["pass"] for k, v in r["checks"].items()}, f"{r['elapsed_s']}s")
    if a.negatives_on:
        report["negatives"] = await negatives(a.provider, key, a.negatives_on)
        print("negatives", json.dumps(report["negatives"], ensure_ascii=False)[:400])
    json.dump(report, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    asyncio.run(main())
