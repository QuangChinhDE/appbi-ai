#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V3 live eval — capability ROUTING against full visibility, graded on the ANSWER.

Not a CI gate: it calls a real model through the running stack. The deterministic
half is pinned by pytest (`tests/test_capability_routing_eval.py`: recall on
labelled intents, flat context as the catalogue grows). This measures what only a
real model can show: with the same grant, does routing keep the answers right —
and does the model actually DISCOVER a capability it was not shown?

ARMS, one flow each, identical except for visibility
----------------------------------------------------
    full     every eligible capability shown in full (visible_capabilities=40)
    routed   the deployment default: schema budget, question-ranked, catalogue
             inside find_capability
    stress   visible_capabilities=4 — only the core is loaded, so every analytic
             capability MUST be discovered; the arm that proves discovery works

GRADING — the answer, not "an answer came back"
-----------------------------------------------
Every case has a ground truth read from the report by ToolNodes (no model), on
link 39 (Olist, 13 charts). A grader checks the figure/label a correct answer must
contain (numbers matched in vi/en formats, ±1%), and what it must NOT contain (a
category presented as a month, a revenue share for a state the report has no
revenue for, a GDP figure with web off). PASS / FAIL per case, one per case.

Also per case: capabilities invoked, whether the expected one ran, discoveries and
whether what was discovered then ran, refusals, schema characters per round,
model/tool calls, tokens, latency, and any capability that ran outside the grant
(must be 0).

    python scripts/agent_flow_v3_eval.py [--link 39] [--reps 2] [--arms full,routed,stress]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request as U

sys.path.insert(0, os.path.dirname(__file__))
from agent_flow_eval import API, login  # noqa: E402  — one way to reach the API

SKILL_KEY = "v3_so_sanh_ky"
PARENT_KEY = "v3_phan_tich"
WEB_TOOLS = {"research_web", "browse_ai_answer", "web_search", "fetch_url", "benchmark_compare"}
PROMPT = ("Bạn là chuyên viên phân tích BI. Trả lời câu hỏi của người xem bằng dữ liệu của báo cáo. "
          "Không có dữ liệu thì nói rõ.")

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
        "prompt": ("Trả lời: {{input.question}}. Tìm biểu đồ theo thời gian phù hợp, dùng compare_periods "
                   "để lấy số của hai kỳ. Nếu cần tỷ lệ phần trăm thì dùng compute với biến tham chiếu "
                   "{ref, path} tới kết quả đã có — không tự gõ số."),
        "max_tool_calls": 6,
        "tools": [{"tool": t} for t in ("search_business_assets", "list_charts", "resolve_chart_candidates",
                                        "compare_periods", "total_measure", "compute", "research_web")],
    }],
}


# ── grading ─────────────────────────────────────────────────────────────────
_NUM = re.compile(r"(?<![\w])(-?\d[\d.,]*)\s*(triệu|tr\b|million|m\b|tỷ|billion|nghìn|k\b)?", re.I)
_MULT = {"triệu": 1e6, "tr": 1e6, "million": 1e6, "m": 1e6, "tỷ": 1e9, "billion": 1e9, "nghìn": 1e3, "k": 1e3}


def _readings(token: str) -> set[float]:
    """Every value a number token can mean in vi or en formatting."""
    t = token.strip(".,")
    out: set[float] = set()
    for dec, thou in ((".", ","), (",", ".")):
        s = t
        if thou in s and dec in s and s.rfind(dec) < s.rfind(thou):
            continue
        s = s.replace(thou, "").replace(dec, ".")
        try:
            out.add(float(s))
        except ValueError:
            pass
    return out


def numbers(text: str) -> set[float]:
    vals: set[float] = set()
    for m in _NUM.finditer(text or ""):
        mult = _MULT.get((m.group(2) or "").lower().strip(), 1.0)
        vals |= {v * mult for v in _readings(m.group(1))}
    return vals


def has(text: str, target: float, tol: float = 0.01) -> bool:
    return any(abs(abs(v) - abs(target)) <= abs(target) * tol for v in numbers(text))


def mentions(text: str, *words: str) -> bool:
    low = (text or "").lower()
    return any(w.lower() in low for w in words)


NO_DATA = ("không có", "chưa có", "không tìm thấy", "không đủ", "không cung cấp", "not available",
           "no data", "không chứa", "không thể", "chỉ có")

CASES = [
    {"id": "rank_top", "q": "Danh mục sản phẩm nào có doanh thu cao nhất?",
     "expect": {"rank_values", "share_of", "get_chart_data", "aggregate_chart_data"},
     "grade": lambda a: mentions(a, "health_beauty", "health & beauty", "health and beauty")},
    {"id": "rank_bottom", "q": "Danh mục nào bán kém nhất theo doanh thu?",
     "expect": {"rank_values", "get_chart_data"},
     "grade": lambda a: mentions(a, "security_and_services", "security and services")},
    {"id": "share_category", "q": "Health & beauty chiếm bao nhiêu phần trăm tổng doanh thu?",
     "expect": {"share_of", "rank_values", "compute"},
     "grade": lambda a: has(a, 9.26, 0.02)},
    {"id": "state_revenue_share", "q": "Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?",
     "expect": {"share_of", "resolve_chart_candidates", "search_business_assets", "list_charts"},
     # The report has ORDERS by state, not revenue: a revenue share is invented.
     "grade": lambda a: not re.search(r"\d[\d.,]*\s*%", a) and (mentions(a, *NO_DATA) or has(a, 41746))},
    {"id": "mom", "q": "GMV tháng gần nhất so với tháng trước thay đổi bao nhiêu phần trăm?",
     "expect": {"compare_periods", "skill__" + SKILL_KEY, "compute"},
     "grade": lambda a: has(a, 5.23, 0.02) or has(a, 5.2345, 0.02)},
    {"id": "trend", "q": "Xu hướng GMV theo tháng thế nào?",
     "expect": {"analyze_trend", "get_chart_summary"},
     "grade": lambda a: mentions(a, "tăng", "đi lên", "upward", "increas")},
    {"id": "anomaly", "q": "Có tháng nào GMV bất thường không?",
     "expect": {"detect_anomaly"},
     # 0 real anomalies; the four edge months are incomplete periods. Listing
     # CATEGORIES as anomalous months is the failure seen in the V3 baseline.
     "grade": lambda a: not mentions(a, "health_beauty", "watches_gifts", "bed_bath")
                        and mentions(a, "không", "no ", "chưa", "2016", "2018-09", "thiếu")},
    {"id": "seasonality", "q": "GMV có tính chu kỳ lặp lại không?",
     "expect": {"detect_seasonality"},
     "grade": lambda a: mentions(a, "có", "yes", "chu kỳ", "lặp") and (has(a, 4) or mentions(a, "4 kỳ", "4 tháng", "bốn"))},
    {"id": "forecast", "q": "Dự báo GMV tháng tới khoảng bao nhiêu?",
     "expect": {"forecast_measure"},
     "grade": lambda a: has(a, 1310831.47, 0.02)},
    {"id": "coverage", "q": "Dữ liệu của báo cáo chạy từ khi nào đến khi nào?",
     "expect": {"describe_time_coverage"},
     "grade": lambda a: mentions(a, "2016") and mentions(a, "2018")},
    {"id": "total", "q": "Tổng doanh thu sản phẩm là bao nhiêu?",
     "expect": {"total_measure", "get_chart_data", "get_chart_summary"},
     "grade": lambda a: has(a, 13591643.7, 0.005)},
    {"id": "on_time", "q": "Tỷ lệ giao hàng đúng hẹn là bao nhiêu?",
     "expect": {"total_measure", "get_chart_data", "get_chart_summary"},
     "grade": lambda a: has(a, 91.89, 0.005)},
    {"id": "concentration", "q": "Doanh thu có tập trung vào vài danh mục không?",
     "expect": {"describe_distribution", "rank_values", "share_of"},
     "grade": lambda a: mentions(a, "health_beauty", "gini", "tập trung", "top", "9.26", "9,26")},
    {"id": "external", "q": "GDP của Brazil năm 2023 là bao nhiêu?", "expect": set(),
     "grade": lambda a: not re.search(r"\d[\d.,]*\s*(nghìn tỷ|tỷ|trillion|billion|usd|\$)", a, re.I)
                        and mentions(a, *NO_DATA, "không", "ngoài")},
]


# ── the API ─────────────────────────────────────────────────────────────────
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


def _parent_body(tools: list[str], *, visible: int | None) -> dict:
    grants = [{"tool": t} for t in tools if t not in WEB_TOOLS] + [{"tool": f"skill:{SKILL_KEY}"}]
    extra = {"visible_capabilities": visible} if visible else {}
    return {"answer_node": "phan_tich", "nodes": [{
        **extra, "key": "phan_tich", "name": "Chuyên viên phân tích", "type": "agent",
        "prompt": PROMPT, "max_tool_calls": 8, "tools": grants,
    }]}


def _run_detail(token: str, key: str, run_id: int | None) -> dict:
    if not run_id:
        return {}
    st, detail = _req(token, "GET", f"/brains/{key}/runs/{run_id}")
    return detail if isinstance(detail, dict) else {}


def _ask(token: str, link: int, case: dict, granted: set[str]) -> dict:
    t0 = time.time()
    st, resp = _req(token, "POST", f"/brains/{PARENT_KEY}/test", {"question": case["q"], "link_id": link})
    elapsed = round(time.time() - t0, 1)
    resp = resp if isinstance(resp, dict) else {}
    env = resp.get("envelope") or {}
    detail = _run_detail(token, PARENT_KEY, resp.get("run_row_id"))
    steps = detail.get("steps") or []
    step = steps[-1] if steps else {}
    cap = step.get("capabilities") or {}
    calls = step.get("tool_calls") or []
    ran = [c for c in calls if "(" not in c]
    ran_names = {c.split("@")[0].replace("skill:", "skill__") for c in ran}
    children = detail.get("children") or []
    child_calls: list[str] = []
    for ch in children:
        _, cd = _req(token, "GET", f"/brains/{ch['brain_key']}/runs/{ch['id']}")
        for s in (cd or {}).get("steps") or []:
            child_calls += s.get("tool_calls") or []
    answer = "".join(b.get("markdown") or b.get("text") or "" for b in ((env.get("answer") or {}).get("blocks") or []))
    answer_body = answer.split("[FOLLOWUP]")[0]
    discovered = [d for disc in (cap.get("discoveries") or []) for d in disc.get("loaded") or []]
    usage = detail.get("usage") or {}
    outside = sorted((ran_names - granted - {"find_capability"})
                     | ({c for c in child_calls if "(" not in c} & WEB_TOOLS))
    return {
        "id": case["id"], "question": case["q"], "http": st, "status": env.get("status"),
        "seconds": elapsed, "answer": answer_body[:600],
        "correct": bool(answer_body) and bool(case["grade"](answer_body)),
        "expected_capability_used": (not case["expect"]) or bool(ran_names & case["expect"]),
        "invoked": sorted(ran_names), "refused": [c for c in calls if "(" in c],
        "shortlisted": cap.get("shortlisted"), "granted": len(cap.get("granted") or []),
        "limit": cap.get("limit"), "schema_budget": cap.get("schema_budget"),
        "initially_visible": len(cap.get("initially_visible") or []),
        "schema_chars_per_round": cap.get("schema_chars_per_round") or [],
        "discoveries": cap.get("discoveries") or [],
        "discovered_then_ran": sorted(set(discovered) & ran_names),
        "auto_loaded": cap.get("auto_loaded") or [],
        "final_rounds": cap.get("final_rounds") or 0,
        "skill_runs": [{"version": c["version"], "status": c["status"], "llm_calls": c["llm_calls"],
                        "tool_calls": c["tool_calls"]} for c in children],
        "skill_tool_calls": child_calls,
        "outside_authority": outside,
        "model_calls": usage.get("llm_calls"), "tool_calls": usage.get("tool_calls"),
        "tokens": (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0),
        "prompt_tokens": usage.get("prompt_tokens") or 0,
    }


def _agg(rows: list[dict]) -> dict:
    n = max(1, len(rows))
    chars = [c for r in rows for c in r["schema_chars_per_round"]]
    return {
        "cases": len(rows),
        "correct": sum(r["correct"] for r in rows),
        "expected_capability_used": sum(r["expected_capability_used"] for r in rows),
        "discovery_calls": sum(len(r["discoveries"]) for r in rows),
        "cases_with_discovery": sum(bool(r["discoveries"]) for r in rows),
        "discovered_then_ran": sum(bool(r["discovered_then_ran"]) for r in rows),
        "auto_loaded": sum(len(r["auto_loaded"]) for r in rows),
        "outside_authority": sum(len(r["outside_authority"]) for r in rows),
        "avg_schema_chars_per_round": round(sum(chars) / max(1, len(chars))),
        "avg_model_calls": round(sum(r["model_calls"] or 0 for r in rows) / n, 2),
        "avg_tool_calls": round(sum(r["tool_calls"] or 0 for r in rows) / n, 2),
        "avg_tokens": round(sum(r["tokens"] for r in rows) / n),
        "avg_prompt_tokens": round(sum(r["prompt_tokens"] for r in rows) / n),
        "avg_seconds": round(sum(r["seconds"] for r in rows) / n, 1),
        "failed_runs": sum(r["status"] == "failed" for r in rows),
        # A row whose trace does not show its arm's visibility ran under another
        # arm's flow (two evals publishing the same parent): not evidence.
        "arm_mismatch": sum(not r.get("arm_ok", True) for r in rows),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--link", type=int, default=39)
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--arms", default="full,routed,stress")
    ap.add_argument("--only", default="", help="comma-separated case ids")
    ap.add_argument("--out", default=".artifacts/v3_routing_eval.json")
    args = ap.parse_args()

    token = login()
    with U.urlopen(f"{API}/api/v1/health", timeout=20) as r:
        health = json.loads(r.read().decode("utf-8"))
    _, packs = _req(token, "GET", "/tools?web_enabled=true")
    all_tools = [t["name"] for p in packs["packs"] for t in p["tools"]]
    granted = {t for t in all_tools if t not in WEB_TOOLS} | {f"skill__{SKILL_KEY}"}
    skill_version = _publish(token, SKILL_KEY, "V3 · So sánh hai kỳ", SKILL_BODY, "skill")
    arms = {"full": 40, "routed": None, "stress": 4}
    cases = [c for c in CASES if not args.only or c["id"] in args.only.split(",")]
    rows: list[dict] = []
    for arm in args.arms.split(","):
        version = _publish(token, PARENT_KEY, "V3 · Chuyên viên phân tích",
                           _parent_body(all_tools, visible=arms[arm]), "bot")
        for rep in range(args.reps):
            for case in cases:
                row = {"arm": arm, "rep": rep, "parent_version": version, **_ask(token, args.link, case, granted)}
                row["arm_ok"] = (row["shortlisted"] is False if arm == "full" else
                                 row["limit"] == 4 if arm == "stress" else
                                 bool(row["schema_budget"]))
                rows.append(row)
                print(json.dumps({k: row[k] for k in ("arm", "rep", "id", "status", "correct", "invoked",
                                                      "discoveries", "tokens", "seconds")},
                                 ensure_ascii=False, default=str), flush=True)
    summary = {"deployment_sha": health.get("git_sha"), "skill_version": skill_version, "reps": args.reps,
               **{arm: _agg([r for r in rows if r["arm"] == arm]) for arm in args.arms.split(",")}}
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "rows": rows}, f, ensure_ascii=False, indent=2, default=str)
    print("SUMMARY", json.dumps(summary, ensure_ascii=False))
    ok = all(summary[a]["outside_authority"] == 0 and summary[a]["arm_mismatch"] == 0
             for a in args.arms.split(","))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
