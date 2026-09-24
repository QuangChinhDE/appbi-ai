#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V3 capabilities eval — Skills, capability discovery and compute provenance, LIVE.

Not a CI gate: it calls a real model through the running stack. The deterministic
invariants are pinned by pytest; this measures what only a real model can show —
does it pick the right capability from a large grant, recover through discovery,
use a Skill, keep its numbers governed — and what it costs.

WHAT IT BUILDS (idempotently, as the eval user):

  v3_so_sanh_ky    a SKILL: compares a measure between periods (compare_periods,
                   total_measure, compute), plus a web tool it will never be able
                   to use on a no-web link — the escalation probe.
  v3_phan_tich     a BUSINESS-ANALYST flow: one answering Agent granted every
                   non-web tool (31) + the Skill, so capability discovery must
                   shortlist.

WHAT IT MEASURES, per question:
  capability selection  expected capability among those invoked
  discovery             find_capability used, and whether what it found ran
  exposure              schemas shown per round vs granted
  skill                 child runs, their version, their budget share
  provenance            compute calls referenced vs unreferenced; figures notice
  escalation            any web / raw-row tool that RAN inside the Skill (must be 0)
  cost                  model calls, tool calls, tokens

    python scripts/agent_flow_v3_eval.py [--link 39] [--out .artifacts/v3_eval.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request as U

sys.path.insert(0, os.path.dirname(__file__))
from agent_flow_eval import API, login  # noqa: E402  — one way to reach the API

SKILL_KEY = "v3_so_sanh_ky"
PARENT_KEY = "v3_phan_tich"
WEB_TOOLS = {"research_web", "browse_ai_answer", "web_search", "fetch_url", "benchmark_compare"}

SKILL_BODY = {
    "answer_node": "so_sanh",
    "skill": {
        "inputs": [{"name": "question", "type": "text", "required": True,
                    "description": "câu hỏi so sánh giữa hai kỳ"}],
        "output": "Mức thay đổi giữa hai kỳ, có số liệu và tỷ lệ phần trăm",
        "when_to_use": "Khi câu hỏi so sánh một chỉ số giữa hai kỳ (tháng này với tháng trước, năm nay với năm trước)",
    },
    "nodes": [{
        "key": "so_sanh", "name": "So sánh hai kỳ", "type": "agent",
        "prompt": ("Trả lời: {{input.question}}. Tìm biểu đồ phù hợp, dùng compare_periods "
                   "hoặc total_measure để lấy số của hai kỳ. Nếu cần tỷ lệ phần trăm thì dùng "
                   "compute với biến tham chiếu {ref, path} tới kết quả đã có — không tự gõ số."),
        "max_tool_calls": 6,
        "tools": [{"tool": t} for t in ("search_business_assets", "resolve_chart_candidates",
                                        "compare_periods", "total_measure", "compute", "research_web")],
    }],
}

QUESTIONS = [
    {"id": "period_compare", "q": "Doanh thu tháng gần nhất so với tháng trước thay đổi bao nhiêu phần trăm?",
     "expect_any": {"skill__v3_so_sanh_ky", "compare_periods"}},
    {"id": "ranking", "q": "Danh mục sản phẩm nào có doanh thu cao nhất?", "expect_any": {"rank_values"}},
    {"id": "share", "q": "Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?", "expect_any": {"share_of"}},
    {"id": "trend", "q": "Xu hướng doanh thu theo tháng thế nào?", "expect_any": {"analyze_trend", "detect_seasonality"}},
    {"id": "anomaly", "q": "Có tháng nào doanh thu bất thường không?", "expect_any": {"detect_anomaly"}},
    {"id": "external", "q": "GDP của Brazil năm 2023 là bao nhiêu?", "expect_any": set(),
     "must_not_run": WEB_TOOLS},
]


def _req(token: str, method: str, path: str, body: dict | None = None, timeout: int = 300):
    req = U.Request(f"{API}/api/v1/agent-flows{path}",
                    data=json.dumps(body).encode("utf-8") if body is not None else None,
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                    method=method)
    try:
        with U.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as exc:  # noqa: BLE001
        return getattr(exc, "code", 0), getattr(exc, "read", lambda: b"")().decode("utf-8", "replace")


def _publish(token: str, key: str, name: str, body: dict, flow_type: str) -> int:
    st, saved = _req(token, "PUT", "/brains", {"brain_key": key, "name": name, "body": body,
                                                "flow_type": flow_type})
    assert st == 200, (key, st, saved)
    if flow_type == "skill":
        st, out = _req(token, "PUT", f"/brains/{key}/type", {"flow_type": "skill"})
        assert st == 200, (key, "type", st, out)
    st, pub = _req(token, "POST", f"/brains/{key}/{saved['version']}/publish?acknowledge_problems=true")
    assert st == 200, (key, "publish", st, pub)
    return int(saved["version"])


def _parent_body(tools: list[str], *, visible: int | None = None) -> dict:
    grants = [{"tool": t} for t in tools if t not in WEB_TOOLS] + [{"tool": f"skill:{SKILL_KEY}"}]
    extra = {"visible_capabilities": visible} if visible else {}
    return {"answer_node": "phan_tich", "nodes": [{
        **extra,
        "key": "phan_tich", "name": "Chuyên viên phân tích", "type": "agent",
        "prompt": ("Bạn là chuyên viên phân tích BI. Trả lời câu hỏi của người xem bằng dữ liệu "
                   "của báo cáo. Chọn khả năng phù hợp; nếu chưa thấy khả năng cần, dùng "
                   "find_capability. Không có dữ liệu thì nói rõ."),
        "max_tool_calls": 8,
        "tools": grants,
    }]}


def _run_detail(token: str, key: str, run_id: int | None) -> dict:
    if not run_id:
        return {}
    st, detail = _req(token, "GET", f"/brains/{key}/runs/{run_id}")
    return detail if isinstance(detail, dict) else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--link", type=int, default=39)
    ap.add_argument("--out", default=".artifacts/v3_eval.json")
    args = ap.parse_args()

    token = login()
    st, health = 0, {}
    with U.urlopen(f"{API}/api/v1/health", timeout=20) as r:
        health = json.loads(r.read().decode("utf-8"))
    st, packs = _req(token, "GET", "/tools?web_enabled=true")
    all_tools = [t["name"] for p in packs["packs"] for t in p["tools"]]

    skill_version = _publish(token, SKILL_KEY, "V3 · So sánh hai kỳ", SKILL_BODY, "skill")
    variants = {"shortlist": None, "all_shown": 40}
    rows = []
    parent_version = 0
    for variant, visible in variants.items():
      parent_version = _publish(token, PARENT_KEY, "V3 · Chuyên viên phân tích",
                                _parent_body(all_tools, visible=visible), "bot")
      for case in QUESTIONS:
        t0 = time.time()
        st, resp = _req(token, "POST", f"/brains/{PARENT_KEY}/test",
                        {"question": case["q"], "link_id": args.link})
        elapsed = round(time.time() - t0, 1)
        resp = resp if isinstance(resp, dict) else {}
        env = resp.get("envelope") or {}
        detail = _run_detail(token, PARENT_KEY, resp.get("run_row_id"))
        steps = detail.get("steps") or []
        step = steps[-1] if steps else {}
        cap = step.get("capabilities") or {}
        calls = step.get("tool_calls") or []
        ran = {c for c in calls if "(" not in c}
        children = detail.get("children") or []
        child_calls = []
        for ch in children:
            _, cd = _req(token, "GET", f"/brains/{ch['brain_key']}/runs/{ch['id']}")
            for s in (cd or {}).get("steps") or []:
                child_calls += s.get("tool_calls") or []
        invoked = set(cap.get("invoked") or []) | {c.split("@")[0].replace("skill:", "skill__") for c in calls}
        answer = "".join(b.get("markdown") or "" for b in ((env.get("answer") or {}).get("blocks") or []))
        rows.append({
            "variant": variant,
            "id": case["id"],
            "question": case["q"],
            "http": st,
            "status": env.get("status"),
            "seconds": elapsed,
            "answer": answer[:400],
            "expected_capability_used": (not case["expect_any"]) or bool(invoked & case["expect_any"]),
            "invoked": sorted(invoked),
            "refused": [c for c in calls if "(" in c],
            "shortlisted": cap.get("shortlisted"),
            "granted": len(cap.get("granted") or []),
            "shown_per_round": [len(r) for r in (cap.get("visible_per_round") or [])],
            "discovered": cap.get("discovered") or [],
            "skill_runs": [{"version": c["version"], "status": c["status"], "invoked_as": c["invoked_as"],
                            "llm_calls": c["llm_calls"], "tool_calls": c["tool_calls"]} for c in children],
            "escalation_ran": sorted({c for c in child_calls if "(" not in c} & WEB_TOOLS)
                              + sorted(ran & case.get("must_not_run", set())),
            "unreferenced_compute": any(n.get("code") == "figures_unverified" for n in (env.get("notices") or [])),
            "model_calls": (detail.get("usage") or {}).get("llm_calls"),
            "tool_calls": (detail.get("usage") or {}).get("tool_calls"),
            "tokens": ((detail.get("usage") or {}).get("prompt_tokens") or 0)
                      + ((detail.get("usage") or {}).get("completion_tokens") or 0),
        })
        print(json.dumps(rows[-1], ensure_ascii=False))

    def agg(rs: list[dict]) -> dict:
        return {
            "cases": len(rs),
            "answered_ok": sum(r["status"] in ("ok", "partial") and bool(r["answer"]) for r in rs),
            "expected_capability_used": sum(r["expected_capability_used"] for r in rs),
            "escalations": sum(len(r["escalation_ran"]) for r in rs),
            "skill_invocations": sum(len(r["skill_runs"]) for r in rs),
            "skill_ok": sum(1 for r in rs for c in r["skill_runs"] if c["status"] in ("ok", "partial")),
            "discovery_used": sum(bool(r["discovered"]) for r in rs),
            "avg_shown_per_round": round(
                sum(sum(r["shown_per_round"]) for r in rs) / max(1, sum(len(r["shown_per_round"]) for r in rs)), 2),
            "granted": rs[0]["granted"] if rs else 0,
            "avg_model_calls": round(sum(r["model_calls"] or 0 for r in rs) / max(1, len(rs)), 2),
            "avg_tool_calls": round(sum(r["tool_calls"] or 0 for r in rs) / max(1, len(rs)), 2),
            "avg_tokens": round(sum(r["tokens"] or 0 for r in rs) / max(1, len(rs))),
        }

    summary = {
        "deployment_sha": health.get("git_sha"),
        "skill_version": skill_version, "parent_version": parent_version,
        **{v: agg([r for r in rows if r["variant"] == v]) for v in variants},
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "rows": rows}, f, ensure_ascii=False, indent=2)
    print("SUMMARY", json.dumps(summary, ensure_ascii=False))
    return 0 if all(summary[v]["escalations"] == 0 for v in variants) else 1


if __name__ == "__main__":
    raise SystemExit(main())
