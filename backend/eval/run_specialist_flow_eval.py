# -*- coding: utf-8 -*-
"""Live evaluation: one general agent vs specialized multi-agent flows.

Same questions, same report (Olist dashboard 67), same model, same scoring, four
architectures:

  A  single   one custom agent holding every tool the questions need
  B  chain    Report Reader → Knowledge Reader → Metric Analyst → Diagnostic
              Analyst → Answer Writer, wired with explicit `reads_from`
  C  coord    a Coordinator picking among the specialists, Answer Writer after
  D  hybrid   deterministic Report Read + Knowledge steps, then an Answer Writer

Runs against a LIVE backend over HTTP with a real model — nothing here is mocked —
and stops itself before spending more than `--budget-usd`. Ground truth comes from
deterministic Tool steps on the same charts (no model), so a "correct" answer is
checked against the engine's own figures, not against another model's opinion.

    python backend/eval/run_specialist_flow_eval.py --api http://127.0.0.1:8137 \
        --token-file tok --credential 1 --dashboard 67 --out results.json

Prices are gpt-4o-mini list prices (USD per 1M tokens); change `PRICE` with the
model. Scoring is deliberately simple and printed per question so a reader can
disagree with it.
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request

PRICE = {"in": 0.15, "out": 0.60}
MODEL = "gpt-4o-mini"

DOCS = [
    {"source": "document", "ref": "26", "description": "Định nghĩa doanh thu, GMV và giá trị đơn của Olist"},
    {"source": "document", "ref": "30", "description": "Từ vựng và quy ước số liệu Olist"},
]

# ── questions + how each answer is judged ─────────────────────────────────────
def _num(text: str) -> list[float]:
    out = []
    for m in re.findall(r"\d[\d.,]*\d|\d", text or ""):
        s = m
        if s.count(",") and s.count("."):
            s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
        elif s.count(",") > 1 or (s.count(",") == 1 and len(s.split(",")[1]) == 3):
            s = s.replace(",", "")
        elif s.count(".") > 1 or (s.count(".") == 1 and len(s.split(".")[1]) == 3):
            s = s.replace(".", "")
        else:
            s = s.replace(",", ".")
        try:
            out.append(float(s))
        except ValueError:
            pass
    return out


def _has(text: str, target: float, rel: float = 0.01) -> bool:
    return any(abs(v - target) <= abs(target) * rel for v in _num(text)) or (
        target >= 1e6 and any(abs(v * 1e6 - target) <= target * rel for v in _num(text)))


#: The SaaS fixture report (`seed_saas_fixture.py` + `build_saas_report.py`).
#: Ground truth is the fixture's own rows — independent of any tool.
SAAS_DASHBOARD = 136


def _says_drop(a: str) -> bool:
    low = a.lower()
    return any(w in low for w in ("giảm", "sụt", "xấu đi", "thấp hơn", "decrease", "drop", "-91", "−91"))


SAAS_QUESTIONS = [
    # GOLDEN — zero tolerance for the known wrong figures in `wrong`.
    {"id": "S1_arr_aug", "dash": SAAS_DASHBOARD, "golden": True,
     "q": "ARR tháng 8 năm 2026 là bao nhiêu?",
     "checks": lambda a: {"value": _has(a, 72, 0.001)}, "wrong": [864, 5244]},
    {"id": "S2_arr_aug_vs_jul", "dash": SAAS_DASHBOARD, "golden": True,
     "q": "So sánh ARR tháng 8/2026 với tháng 7/2026.",
     "checks": lambda a: {"aug": _has(a, 72, 0.001), "jul": _has(a, 864, 0.001), "direction": _says_drop(a)},
     "wrong": [5244]},
    {"id": "S3_mrr_jun", "dash": SAAS_DASHBOARD, "golden": True,
     "q": "MRR tháng 6/2026 là bao nhiêu?",
     "checks": lambda a: {"value": _has(a, 70, 0.001)}, "wrong": [60, 72, 431]},
    {"id": "S4_churn_aug", "dash": SAAS_DASHBOARD, "golden": True,
     "q": "Có bao nhiêu khách hàng rời bỏ trong tháng 8/2026?",
     "checks": lambda a: {"value": _has(a, 40, 0.001)}, "wrong": [60, 3]},
    {"id": "S5_arr_enterprise", "dash": SAAS_DASHBOARD, "golden": True,
     "q": "ARR của phân khúc enterprise là bao nhiêu?",
     "checks": lambda a: {"value": _has(a, 5000, 0.001)}, "wrong": [72, 5244]},
    # HOLDOUT — not used while fixing.
    {"id": "H1_churn_total", "dash": SAAS_DASHBOARD, "golden": False,
     "q": "Tổng số khách hàng rời bỏ từ tháng 1 đến tháng 8 năm 2026 là bao nhiêu?",
     "checks": lambda a: {"value": _has(a, 60, 0.001)}, "wrong": [40]},
    {"id": "H2_latest_arr", "dash": SAAS_DASHBOARD, "golden": False,
     "q": "ARR ở tháng gần nhất có dữ liệu là bao nhiêu và đó là tháng nào?",
     "checks": lambda a: {"value": _has(a, 72, 0.001),
                          "month": ("2026-08" in a or "8/2026" in a or "tháng 8" in a.lower())},
     "wrong": [864, 5244]},
    {"id": "H3_second_category", "dash": 67, "golden": False,
     "q": "Danh mục có doanh thu cao thứ hai là gì?",
     "checks": lambda a: {"category": "watches" in a.lower()}, "wrong": []},
]

QUESTIONS = [
    {"id": "Q1_lookup", "q": "Tổng doanh thu sản phẩm toàn kỳ là bao nhiêu?",
     "checks": lambda a: {"value": _has(a, 13591643.70)}},
    {"id": "Q2_rank_share", "q": "Danh mục nào có doanh thu cao nhất và chiếm bao nhiêu % tổng doanh thu?",
     "checks": lambda a: {"category": "health" in a.lower() and "beauty" in a.lower(),
                          "share": _has(a, 9.26, 0.03)}},
    {"id": "Q3_definition_plus_number",
     "q": "Theo tài liệu, GMV khác doanh thu sản phẩm ở điểm nào, và trên báo cáo GMV toàn kỳ là bao nhiêu?",
     "checks": lambda a: {"definition": any(w in a.lower() for w in ("vận chuyển", "ship", "freight")),
                          "gmv": _has(a, 15843553.24)}},
    {"id": "Q4_diagnose", "q": "Tháng nào có GMV cao nhất và điều gì có thể giải thích điều đó?",
     "checks": lambda a: {"month": ("2017-11" in a) or ("11/2017" in a) or ("tháng 11" in a.lower() and "2017" in a),
                          "no_false_certainty": not re.search(r"nguyên nhân (chính )?là|chắc chắn là|do (chắc chắn)", a.lower())}},
]


# ── flows ─────────────────────────────────────────────────────────────────────
def _agent(key, name, prompt, *, cred, role="", tools=(), reads=None, knowledge=None, max_calls=6):
    n = {"key": key, "name": name, "type": "agent", "prompt": prompt, "role": role,
         "provider": "openai", "model": MODEL, "credential_id": cred,
         "tools": [{"tool": t} for t in tools], "max_tool_calls": max_calls}
    if reads:
        n["reads_from"] = reads
    if knowledge:
        n["knowledge"] = knowledge
    return n


def flows(cred: int) -> dict[str, dict]:
    """See module docstring. Tool lists include `period`-aware measuring tools."""
    rr_tools = ["search_business_assets", "resolve_chart_candidates", "list_charts", "inspect_filters",
                "describe_time_coverage", "get_chart_summary"]
    ma_tools = ["resolve_chart_candidates", "list_charts", "total_measure", "rank_values", "share_of", "aggregate_chart_data",
                "compare_periods", "get_chart_summary", "compute"]
    da_tools = ["resolve_chart_candidates", "list_charts", "explain_change", "detect_anomaly",
                "compare_periods", "get_chart_summary"]
    kr_tools = ["search_knowledge", "read_document"]
    single = sorted(set(rr_tools + ma_tools + da_tools + kr_tools))
    rr = _agent("doc_bao_cao", "Đọc báo cáo", "Xác định các biểu đồ liên quan đến câu hỏi; ghi chart_id, tên, đơn vị.",
                cred=cred, role="report_reader", tools=rr_tools, max_calls=4)
    kr = _agent("tra_cuu", "Tra cứu tri thức", "Tra tài liệu đính kèm để tìm định nghĩa liên quan; trích nguồn. Nếu câu hỏi không cần định nghĩa, trả lời 'không cần tra'.",
                cred=cred, role="knowledge_reader", tools=kr_tools, knowledge=DOCS, max_calls=3)
    ma = _agent("do_luong", "Phân tích chỉ số", "Đo các con số câu hỏi cần, dùng chart_id bước đọc báo cáo đã tìm.",
                cred=cred, role="metric_analyst", tools=ma_tools, reads=["doc_bao_cao"], max_calls=5)
    da = _agent("chan_doan", "Chẩn đoán", "Nếu câu hỏi hỏi vì sao/giải thích, phân tích yếu tố có thể giải thích; nếu không, trả lời 'không cần chẩn đoán'.",
                cred=cred, role="diagnostic_analyst", tools=da_tools, reads=["doc_bao_cao", "do_luong"], max_calls=4)
    aw = _agent("tra_loi", "Viết câu trả lời", "Trả lời câu hỏi ngắn gọn bằng tiếng Việt từ kết quả các bước trước.",
                cred=cred, role="answer_writer", reads=["tra_cuu", "do_luong", "chan_doan"])
    return {
        "A_single": {"answer_node": "mot_agent", "nodes": [
            _agent("mot_agent", "Một agent", "Trả lời câu hỏi về báo cáo bằng dữ liệu và tài liệu được cấp.",
                   cred=cred, tools=single, knowledge=DOCS, max_calls=10)]},
        "B_chain": {"answer_node": "tra_loi", "nodes": [rr, kr, ma, da, aw]},
        "C_coord": {"answer_node": "tra_loi_c", "nodes": [
            {"key": "dieu_phoi", "name": "Điều phối", "type": "coordinate", "provider": "openai",
             "model": MODEL, "credential_id": cred, "max_specialists": 2,
             "prompt": "Chọn chuyên gia cần cho câu hỏi.",
             "specialists": [
                 {"key": "cg_tri_thuc", "name": "Tri thức", "when": "Câu hỏi hỏi định nghĩa, quy ước, tài liệu",
                  "body": [dict(kr, key="kr_c")]},
                 {"key": "cg_chi_so", "name": "Chỉ số", "when": "Câu hỏi cần một con số, xếp hạng, tỷ trọng",
                  "body": [dict(ma, key="ma_c", reads_from=[], prompt="Tìm biểu đồ phù hợp và đo các con số câu hỏi cần.")]},
                 {"key": "cg_chan_doan", "name": "Chẩn đoán", "when": "Câu hỏi hỏi vì sao, biến động, giải thích",
                  "body": [dict(da, key="da_c", reads_from=[], prompt="Tìm biểu đồ phù hợp, phân tích yếu tố có thể giải thích.")]},
             ]},
            _agent("tra_loi_c", "Viết câu trả lời", "Trả lời câu hỏi ngắn gọn bằng tiếng Việt từ kết quả các chuyên gia.",
                   cred=cred, role="answer_writer"),
        ]},
        "D_hybrid": {"answer_node": "tra_loi_d", "nodes": [
            {"key": "doc", "type": "report_read", "name": "Đọc báo cáo", "match_question": True,
             "max_charts": 6, "output_var": "bao_cao", "run_policy": "every_turn"},
            {"key": "tri_thuc", "type": "knowledge", "name": "Tri thức", "knowledge": DOCS, "top_k": 4,
             "output_var": "tai_lieu"},
            _agent("tra_loi_d", "Viết câu trả lời", "Trả lời câu hỏi ngắn gọn bằng tiếng Việt từ dữ liệu báo cáo và tài liệu.",
                   cred=cred, role="answer_writer", reads=["doc", "tri_thuc"]),
        ]},
    }


# ── runner ────────────────────────────────────────────────────────────────────
class Api:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/") + "/api/v1/agent-flows", token

    def call(self, method: str, path: str, data=None, timeout=900):
        req = urllib.request.Request(
            self.base + path, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            return json.load(urllib.request.urlopen(req, timeout=timeout))
        except urllib.error.HTTPError as e:
            return {"_err": e.code, "detail": e.read().decode()[:1500]}


def summarise(env: dict) -> dict:
    steps = (env.get("trace") or {}).get("steps") or []
    usage = env.get("usage") or {}
    text = (env.get("answer") or {}).get("text") or ""
    codes = [n.get("code") for n in env.get("notices") or []]
    return {
        "status": env.get("status"),
        "answer": text,
        "llm_calls": usage.get("llm_calls", 0), "tool_calls": usage.get("tool_calls", 0),
        "prompt_tokens": usage.get("prompt_tokens", 0), "completion_tokens": usage.get("completion_tokens", 0),
        "ms": usage.get("ms", 0),
        "notices": codes,
        "unsupported_claims": "claims_unverified" in codes,
        "steps": [{"key": s.get("key"), "type": s.get("type"), "status": s.get("status"),
                   "tools": s.get("tool_calls") or [],
                   "handoff": (s.get("capabilities") or {}).get("handoff"),
                   "error": s.get("error") or ""} for s in steps],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--credential", type=int, required=True)
    ap.add_argument("--dashboard", type=int, default=67)
    ap.add_argument("--budget-usd", type=float, default=4.0)
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--only", default="")
    ap.add_argument("--suite", default="all", choices=["all", "olist", "saas"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    api = Api(args.api, open(args.token_file).read().strip())
    spent = 0.0
    results = []
    for name, body in flows(args.credential).items():
        if args.only and name not in args.only.split(","):
            continue
        key = f"eval_{name.lower()}"
        saved = api.call("PUT", "/brains", {"brain_key": key, "name": f"EVAL {name}", "body": body})
        if saved.get("_err"):
            print("SAVE FAILED", name, saved)
            results.append({"flow": name, "save_error": saved})
            continue
        for rep in range(args.repeats):
            for q in [*QUESTIONS, *SAAS_QUESTIONS] if args.suite == "all" else (
                    SAAS_QUESTIONS if args.suite == "saas" else QUESTIONS):
                if spent >= args.budget_usd:
                    print(f"BUDGET STOP at ${spent:.4f}")
                    break
                t0 = time.time()
                env = api.call("POST", f"/brains/{key}/test-on-report",
                               {"question": q["q"], "dashboard_id": q.get("dash", args.dashboard)})
                env = env.get("envelope") or env
                row = {"flow": name, "q": q["id"], "rep": rep, "wall_s": round(time.time() - t0, 1),
                       **summarise(env)}
                if env.get("_err"):
                    row["http_error"] = env
                row["checks"] = q["checks"](row.get("answer") or "")
                row["correct"] = all(row["checks"].values())
                # A KNOWN WRONG FIGURE PUBLISHED AS IF VERIFIED: present in the answer
                # with no warning notice beside it. The zero-tolerance gate.
                warned = bool({"claims_unverified", "qualifier_unverified", "figures_unverified",
                               "answer_incomplete"} & set(row.get("notices") or []))
                row["wrong_figure"] = any(_has(row.get("answer") or "", w, 0.001) for w in q.get("wrong", []))
                row["wrong_as_verified"] = row["wrong_figure"] and not warned and not row["correct"]
                row["golden"] = bool(q.get("golden"))
                cost = (row["prompt_tokens"] * PRICE["in"] + row["completion_tokens"] * PRICE["out"]) / 1e6
                row["cost_usd"] = round(cost, 5)
                spent += cost
                results.append(row)
                print(f"{name:9} {q['id']:26} {row['status']:8} correct={row['correct']} "
                      f"llm={row['llm_calls']} tools={row['tool_calls']} tok={row['prompt_tokens']}+"
                      f"{row['completion_tokens']} {row['wall_s']}s ${spent:.4f} {row['checks']}")
                json.dump({"spent_usd": spent, "results": results}, open(args.out, "w", encoding="utf-8"),
                          ensure_ascii=False, indent=1)
    print(f"TOTAL spent ${spent:.4f}")


if __name__ == "__main__":
    main()
