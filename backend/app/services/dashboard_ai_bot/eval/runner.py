"""Eval runner — score a gold suite and aggregate by intent tier.

Two ways to supply answers:
  - inject any ``answer_fn(question)->str`` (unit tests, offline replay).
  - ``make_http_answer_fn(...)`` drives the real public SSE chat endpoint.

Aggregates per-tier + overall pass-rate so a weak category can't hide behind a
good average (Abeysinghe 2024). Deterministic Tier-1 only; no LLM judge here.
"""
from __future__ import annotations

import json
from typing import Callable

from app.services.dashboard_ai_bot.eval.graders import grade_case
from app.services.dashboard_ai_bot.eval.schema import GoldSuite

AnswerFn = Callable[[str], str]


def run_suite(suite: GoldSuite, answer_fn: AnswerFn, *, allowed_chart_ids=None) -> dict:
    results = []
    for case in suite.cases:
        try:
            answer = answer_fn(case.question)
        except Exception as exc:  # noqa: BLE001
            results.append({
                "id": case.id, "tier": case.tier, "passed": False,
                "checks": {"answer_fn": False}, "detail": {"error": f"{type(exc).__name__}: {exc}"},
                "answer": "",
            })
            continue
        r = grade_case(case, answer, allowed_chart_ids=allowed_chart_ids)
        results.append({
            "id": r.id, "tier": r.tier, "passed": r.passed,
            "checks": r.checks, "detail": r.detail,
            "answer": (answer or "")[:400],
        })

    # Aggregate by tier + overall.
    tiers: dict[str, dict] = {}
    for r in results:
        t = tiers.setdefault(r["tier"], {"pass": 0, "total": 0})
        t["total"] += 1
        t["pass"] += 1 if r["passed"] else 0
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    return {
        "suite": suite.name,
        "dashboard_token": suite.dashboard_token,
        "overall": {"pass": passed, "total": total,
                     "pass_rate": round(passed / total, 4) if total else 0.0},
        "by_tier": {
            t: {**v, "pass_rate": round(v["pass"] / v["total"], 4) if v["total"] else 0.0}
            for t, v in sorted(tiers.items())
        },
        "cases": results,
    }


def format_report(report: dict) -> str:
    lines = [
        f"=== EVAL {report['suite']} ===",
        f"OVERALL: {report['overall']['pass']}/{report['overall']['total']} "
        f"= {report['overall']['pass_rate']*100:.1f}%",
        "by tier:",
    ]
    for t, v in report["by_tier"].items():
        lines.append(f"  {t:<12} {v['pass']}/{v['total']} = {v['pass_rate']*100:.0f}%")
    lines.append("cases:")
    for c in report["cases"]:
        mark = "PASS" if c["passed"] else "FAIL"
        extra = "" if c["passed"] else f"  <-- {c['checks']} {c['detail']}"
        lines.append(f"  [{mark}] {c['id']} ({c['tier']}){extra}")
    return "\n".join(lines)


def make_http_answer_fn(
    *, base_url: str, token: str, mode: str = "auto", api_key: str | None = None,
    provider: str | None = None, model: str | None = None, timeout: float = 180.0,
) -> AnswerFn:
    """Drive the real public SSE chat endpoint; collect streamed text into the
    final answer string. Credentials resolve server-side from the link config
    unless overridden via headers."""
    import httpx

    url = f"{base_url.rstrip('/')}/api/v1/public/dashboards/{token}/ai/agent/chat"

    def _answer(question: str) -> str:
        headers = {"Content-Type": "application/json"}
        if mode:
            headers["X-User-Ai-Mode"] = mode
        if api_key:
            headers["X-User-Ai-Key"] = api_key
        if provider:
            headers["X-User-Ai-Provider"] = provider
        if model:
            headers["X-User-Ai-Model"] = model
        body = {"messages": [{"role": "user", "content": question}]}
        parts: list[str] = []
        with httpx.stream("POST", url, headers=headers, json=body, timeout=timeout) as resp:
            for line in resp.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "text" and ev.get("text"):
                    parts.append(ev["text"])
        return "".join(parts)

    return _answer


if __name__ == "__main__":
    # Live baseline against the seed suite. Run inside the backend container:
    #   python -m app.services.dashboard_ai_bot.eval.runner
    import os
    from app.services.dashboard_ai_bot.eval.gold_olist import OLIST_SUITE

    base = os.environ.get("EVAL_BASE_URL", "http://127.0.0.1:8000")
    fn = make_http_answer_fn(base_url=base, token=OLIST_SUITE.dashboard_token, mode="auto")
    rep = run_suite(OLIST_SUITE, fn)
    print(format_report(rep))
