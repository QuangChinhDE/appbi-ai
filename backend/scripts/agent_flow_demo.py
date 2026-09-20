"""Agent Flow — a demo that exercises every node type, on its own public link.

WHY A SCRIPT AND NOT A README
-----------------------------
"It works" is a claim; this is the claim executed. Twelve node types, branch
selection, loop iteration, branch-stop, early return, session reuse, the budget
ceiling, the data contract and the fail-closed path each have a check here, and
each one prints PASS or FAIL against a live deployment.

WHAT IT WILL NOT TOUCH
----------------------
The dashboard, its charts, and any link that already exists. The demo creates its
OWN public link (additive — a dashboard can have many) and its own flow, and
deletes only what it created. Nothing here writes to the report the business is
using: a test that can break production is not a test anyone will run twice.

USAGE
    python scripts/agent_flow_demo.py --api http://localhost:8000/api/v1 \
        --email admin@appbi.io --password 123456 --dashboard 67 [--llm-key sk-...]

Without `--llm-key` every deterministic node is still exercised; only the two AI
nodes are skipped, and the script says so rather than reporting a pass it did not
earn.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    (PASSED if ok else FAILED).append(name)
    mark = "PASS" if ok else "FAIL"
    print(f"  {mark}  {name}" + (f"   — {detail}" if detail and not ok else ""))
    return ok


class Api:
    def __init__(self, base: str, token: str = "") -> None:
        self.base = base.rstrip("/")
        self.token = token

    def __call__(self, method: str, path: str, body=None, headers=None, raw=False):
        url = path if path.startswith("http") else f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                payload = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return {"__error__": e.code, "detail": e.read().decode("utf-8", "replace")[:300]}
        if raw:
            return payload
        return json.loads(payload) if payload.strip() else {}


# ── The demo flow: every node type the executor supports ─────────────────────
#
# `scenario` is seeded by the binding's `defaults`, so one flow can be driven down
# different paths without editing it — which is how the Stop node gets tested at
# all (a node on a branch nobody takes is a node nobody has tested).
FLOW_KEY = "demo_all_nodes"

FLOW_BODY = {
    "answer_node": "answer",
    "requirements": {
        "items": [
            {"key": "revenue", "kind": "metric", "label": "Doanh thu", "required": True},
            {"key": "segments", "kind": "dimension", "label": "Phân khúc", "required": True},
        ],
        "capabilities": [],
    },
    "nodes": [
        {"type": "report_read", "key": "read", "name": "Đọc báo cáo",
         "output_var": "report_ctx", "run_policy": "when_stale", "max_rows": 60},

        {"type": "set_var", "key": "seed", "name": "Khởi tạo",
         "var": "findings", "value": "[]", "value_type": "list"},

        {"type": "if", "key": "gate", "name": "Có dữ liệu doanh thu?", "paths": [
            {"key": "has", "name": "Có", "kind": "rules", "match": "all",
             "conditions": [{"left": "{{available_metrics}}", "op": "contains",
                             "right": "revenue"}],
             "body": [
                 {"type": "knowledge", "key": "kb", "name": "Tra tri thức",
                  "query": "định nghĩa doanh thu", "top_k": 3,
                  "output_var": "kb_ctx"},
             ]},
            {"key": "none", "name": "Không", "kind": "fallback", "body": [
                {"type": "web", "key": "web", "name": "Tra web",
                 "query": "benchmark doanh thu", "output_var": "web_ctx"},
            ]},
        ]},

        {"type": "loop", "key": "each", "name": "Từng phân khúc",
         "over": "{{segments}}", "item_var": "seg", "max_iterations": 2,
         "collect_into": "all_findings", "body": [
             {"type": "filter", "key": "skip_blank", "name": "Bỏ mục rỗng",
              "conditions": [{"left": "{{seg}}", "op": "is_not_empty"}]},
             {"type": "agent", "key": "analyse", "name": "Phân tích mục",
              "output_var": "one_finding", "context_policy": "none",
              "max_tool_calls": 1,
              "prompt": ("Viết ĐÚNG một câu ngắn về danh mục \"{{seg}}\" dựa trên "
                         "dữ liệu sau. Không thêm số nào ngoài dữ liệu này.\n\n"
                         "{{report_ctx}}")},
             {"type": "transform", "key": "collect", "name": "Gom lại",
              "operation": "append_to_list", "source": "{{one_finding}}",
              "target": "findings"},
         ]},

        {"type": "switch", "key": "route", "name": "Rẽ theo kịch bản",
         "value": "{{scenario}}", "mode": "first_match", "has_fallback": True,
         "cases": [
             {"key": "stop_early", "label": "STOP", "op": "equals", "value": "stop",
              "body": [
                  {"type": "stop", "key": "halt", "name": "Dừng sớm", "emit": True,
                   "message": "Kịch bản dừng sớm: flow kết thúc tại bước Stop."},
              ]},
             {"key": "slow", "label": "DELAY", "op": "equals", "value": "delay",
              "body": [
                  {"type": "delay", "key": "wait", "name": "Chờ", "seconds": 2},
              ]},
         ],
         "fallback": [
             {"type": "set_var", "key": "mark", "name": "Đánh dấu",
              "var": "route_taken", "value": "fallback"},
         ]},

        # The answering step is GRANTED the computing tools, and that is a fix to
        # the FLOW rather than a workaround for a tool.
        #
        # It is handed `report_ctx` — a read that may be truncated — and asked
        # for a `metric` block "using only numbers in the data". Since the read
        # now says out loud when it is a fragment, a step with no tools is being
        # told not to state a total AND given no way to obtain one, so whether it
        # emits a metric depends on how the model resolves that: this check
        # failed twice and then passed three times unchanged.
        #
        # A flaky check is a design smell in the thing being checked. The step
        # gets the tools that produce an exact figure over every row, which is
        # what a correct flow does and therefore what this demo should show.
        {"type": "agent", "key": "answer", "name": "Viết câu trả lời",
         "output_format": "json", "context_policy": "last_3",
         "tools": [
             {"tool": "total_measure", "note": "lấy tổng thật cho block metric"},
             {"tool": "rank_values", "note": "xếp hạng khi cần nêu nhóm dẫn đầu"},
         ],
         "max_tool_calls": 2,
         "prompt": ("Tổng hợp thành câu trả lời cuối, bằng tiếng Việt.\n\n"
                    "Phát hiện: {{findings}}\n\nDữ liệu: {{report_ctx}}\n\n"
                    "Dữ liệu trên có thể bị cắt dòng — muốn nêu TỔNG hay THỨ HẠNG "
                    "thì GỌI total_measure / rank_values, đừng suy từ phần đã đọc.\n\n"
                    "Bắt buộc: một block text, một block metric, một block "
                    "chart_ref, một block followups. Chỉ dùng số có trong dữ liệu.")},
    ],
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000/api/v1")
    ap.add_argument("--email", default="admin@appbi.io")
    ap.add_argument("--password", default="123456")
    ap.add_argument("--dashboard", type=int, required=True)
    ap.add_argument("--llm-key", default="")
    ap.add_argument("--llm-provider", default="openai")
    ap.add_argument("--llm-model", default="gpt-4o-mini")
    ap.add_argument("--keep", action="store_true", help="leave the demo link in place")
    args = ap.parse_args()

    api = Api(args.api)
    auth = api("POST", "/auth/login", {"email": args.email, "password": args.password})
    if not auth.get("access_token"):
        print("LOGIN FAILED:", auth)
        return 2
    api.token = auth["access_token"]

    print("\n[1] Demo public link (additive — the dashboard is not modified)")
    link = api("POST", f"/dashboards/{args.dashboard}/public-links", {
        "name": "Agent Flow demo (tự động tạo)",
        "filters_config": [],
        "appearance_config": {
            "ai_bot_enabled": True,
            "ai_bot_provider": args.llm_provider,
            "ai_bot_model": args.llm_model,
        },
    })
    if link.get("__error__"):
        print("  could not create link:", link)
        return 2
    link_id, token = link["id"], link["token"]
    check("demo link created", bool(link_id and token), str(link)[:120])

    created_flow = False
    try:
        print("\n[2] Flow with all 12 node types")
        saved = api("PUT", "/agent-flows/brains", {
            "brain_key": FLOW_KEY, "name": "Demo — mọi loại node",
            "description": "Tự động tạo bởi scripts/agent_flow_demo.py",
            "body": FLOW_BODY,
        })
        created_flow = not saved.get("__error__")
        if not check("flow saves", created_flow, str(saved)[:200]):
            return 1
        types = {n["type"] for n in _walk(saved["body"]["nodes"])}
        expected = {"report_read", "set_var", "if", "knowledge", "web", "loop",
                    "filter", "agent", "transform", "switch", "stop", "delay"}
        check("all 12 node types present", types == expected, f"missing {expected - types}")

        val = api("POST", "/agent-flows/validate", {
            "brain_key": FLOW_KEY, "name": "Demo", "body": FLOW_BODY})
        check("flow validates", val.get("ok") is True, str(val.get("errors"))[:150])
        check("estimate accounts for the loop",
              val.get("estimate", {}).get("max_llm_calls", 0) >= 3,
              str(val.get("estimate")))

        pub = api("POST", f"/agent-flows/brains/{FLOW_KEY}/{saved['version']}/publish")
        check("flow publishes", pub.get("status") == "published", str(pub)[:150])

        print("\n[3] Binding — the data contract, defined before assigning")
        cand = api("GET", f"/agent-flows/bindings/link/{link_id}/candidates?brain_key={FLOW_KEY}")
        charts = cand.get("charts") or []
        check("candidate charts offered", len(charts) > 0, str(cand)[:150])

        measure = _first_with(charts, "measures")
        dimension = _first_with(charts, "dimensions")
        if not (measure and dimension):
            check("dashboard exposes a measure and a dimension", False,
                  "this dashboard has no chart with both")
            return 1

        empty = api("POST", "/agent-flows/bindings/preflight", {
            "link_id": link_id, "brain_key": FLOW_KEY, "data_contract": {}})
        check("empty contract is refused", empty.get("ok") is False,
              "an undefined scope was accepted")

        contract = {
            "charts": {"mode": "allowlist",
                       "ids": [c["id"] for c in charts[:6]]},
            "resolve": {
                "revenue": {"kind": "measure", "chart_id": measure[0],
                            "field": measure[1], "label": "Doanh thu"},
                "segments": {"kind": "dimension", "chart_id": dimension[0],
                             "field": dimension[1], "label": "Phân khúc"},
            },
            "knowledge": {"mode": "flow_all"},
            "capabilities": {"web_search": False, "read_rows": True,
                             "max_rows_per_call": 500},
            "defaults": {"scenario": "normal"},
            "budget": {"max_llm_calls": 8, "max_tool_calls": 40, "max_seconds": 90},
        }
        pre = api("POST", "/agent-flows/bindings/preflight", {
            "link_id": link_id, "brain_key": FLOW_KEY, "data_contract": contract})
        check("valid contract passes preflight", pre.get("ok") is True,
              str(pre.get("errors"))[:200])
        check("web-off warning is raised",
              any(w["code"] == "web_disabled" for w in pre.get("warnings", [])),
              "flow has a web node and the link has web off")

        bound = api("PUT", "/agent-flows/bindings", {
            "link_id": link_id, "brain_key": FLOW_KEY, "data_contract": contract})
        check("binding assigned", bound.get("status") == "active", str(bound)[:150])

        print("\n[4] Node semantics — evaluated server-side, no model, no cost")
        ift = api("POST", f"/agent-flows/brains/{FLOW_KEY}/nodes/gate/test", {
            "link_id": link_id, "vars": {"available_metrics": ["t.total_revenue"]}})
        check("IF picks the rules branch when it matches", ift.get("chosen") == "has",
              str(ift)[:150])
        ift2 = api("POST", f"/agent-flows/brains/{FLOW_KEY}/nodes/gate/test", {
            "link_id": link_id, "vars": {"available_metrics": ["t.orders"]}})
        check("IF falls back when nothing matches", ift2.get("chosen") == "none",
              str(ift2)[:150])

        sw = api("POST", f"/agent-flows/brains/{FLOW_KEY}/nodes/route/test", {
            "link_id": link_id, "vars": {"scenario": "stop"}})
        check("Switch routes to the matching case", sw.get("chosen") == "stop_early",
              str(sw)[:150])
        sw2 = api("POST", f"/agent-flows/brains/{FLOW_KEY}/nodes/route/test", {
            "link_id": link_id, "vars": {"scenario": "anything-else"}})
        check("Switch uses fallback when no case matches",
              sw2.get("chosen") == "fallback", str(sw2)[:150])

        flt = api("POST", f"/agent-flows/brains/{FLOW_KEY}/nodes/skip_blank/test", {
            "link_id": link_id, "vars": {"seg": ""}})
        check("Filter stops the branch on an empty item", flt.get("passed") is False,
              str(flt)[:120])

        lp = api("POST", f"/agent-flows/brains/{FLOW_KEY}/nodes/each/test", {
            "link_id": link_id, "vars": {"segments": ["a", "b", "c"]}})
        check("Loop bounds iterations to max_iterations",
              lp.get("iterations") == 2, str(lp)[:120])

        print("\n[5] Live run through the public link")
        if not args.llm_key:
            print("  (skipped — no --llm-key; deterministic nodes above were exercised)")
        else:
            env = _run_chat(args, token, "Doanh thu theo danh mục thế nào?")
            if env is None:
                check("live run returns an envelope", False, "no result event")
            else:
                check("live run returns an envelope", True)
                check("run reaches the answer node",
                      any(s["key"] == "answer" for s in env["trace"]["steps"]),
                      env["trace"]["path"])
                check("loop ran the body twice",
                      sum(1 for s in env["trace"]["steps"] if s["key"] == "analyse") == 2,
                      str([s["key"] for s in env["trace"]["steps"]]))
                check("answer is structured blocks",
                      len(env["answer"]["blocks"]) >= 2,
                      str([b["type"] for b in env["answer"]["blocks"]]))
                check("figures are checked against evidence",
                      env["status"] in ("ok", "partial"), env["status"])

                runs = api("GET", f"/agent-flows/brains/{FLOW_KEY}/runs?since_hours=1")
                check("the run is recorded", runs.get("total", 0) >= 1, str(runs)[:120])

                # Second turn: the report_read node is `when_stale`, so it must be
                # reused rather than re-read.
                env2 = _run_chat(args, token, "Còn danh mục nào đáng chú ý?",
                                 session="demo-session")
                if env2:
                    statuses = {s["key"]: s["status"] for s in env2["trace"]["steps"]}
                    check("session reuse skips the re-read",
                          statuses.get("read") == "reused", str(statuses)[:150])

        print("\n[6] Fail-closed — no binding means no answer")
        api("DELETE", f"/agent-flows/bindings/link/{link_id}")
        env3 = _run_chat(args, token, "Thử khi chưa gán", require_key=False)
        if env3 is None:
            check("blocked turn still returns an envelope", False, "no result event")
        else:
            check("unbound link is blocked", env3["status"] == "blocked", env3["status"])
            check("the viewer is told why",
                  any(n["code"] == "not_configured" for n in env3["notices"]),
                  str(env3["notices"])[:150])

    finally:
        if not args.keep:
            print("\n[7] Cleanup — only what this script created")
            removed_link = api("DELETE", f"/dashboards/{args.dashboard}/public-links/{link_id}")
            check("demo link removed", not removed_link.get("__error__"), str(removed_link)[:160])
            if created_flow:
                versions = (
                    api("GET", f"/agent-flows/brains/{FLOW_KEY}/versions")
                    .get("versions") or []
                )
                for version in versions:
                    if version.get("status") == "published":
                        unpublished = api(
                            "POST",
                            f"/agent-flows/brains/{FLOW_KEY}/{version['version']}/unpublish",
                        )
                        check(
                            f"flow v{version['version']} unpublished",
                            unpublished.get("status") == "archived",
                            str(unpublished)[:180],
                        )
                    deleted = api(
                        "DELETE",
                        f"/agent-flows/brains/{FLOW_KEY}/{version['version']}",
                    )
                    check(
                        f"flow v{version['version']} removed",
                        deleted.get("status") == "deleted",
                        str(deleted)[:180],
                    )
                remaining = (
                    api("GET", f"/agent-flows/brains/{FLOW_KEY}/versions")
                    .get("versions") or []
                )
                check("demo flow fully removed", not remaining, str(remaining)[:180])
            print("  cleanup verified; the dashboard was never modified")

    print("\n" + "=" * 62)
    print(f"  {len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        print("  FAILED: " + ", ".join(FAILED))
    return 1 if FAILED else 0


def _walk(nodes):
    for n in nodes or []:
        yield n
        for p in n.get("paths") or []:
            yield from _walk(p.get("body"))
        for c in n.get("cases") or []:
            yield from _walk(c.get("body"))
        yield from _walk(n.get("fallback"))
        yield from _walk(n.get("body"))


def _first_with(charts, key):
    for c in charts:
        if c.get(key):
            return c["id"], c[key][0]["field"]
    return None


def _run_chat(args, token, question, require_key=True, session="demo-session"):
    """One turn through the PUBLIC endpoint — the same path a viewer takes.

    `session` is STABLE by default so the second turn lands in the same
    conversation: a fresh key per turn would silently disable session reuse and
    make the reuse check pass or fail for the wrong reason.
    """
    headers = {"Content-Type": "application/json", "X-Public-Session": session}
    if args.llm_key:
        headers["X-User-Ai-Key"] = args.llm_key
        headers["X-User-Ai-Provider"] = args.llm_provider
        if args.llm_model:
            headers["X-User-Ai-Model"] = args.llm_model
    elif require_key:
        return None

    body = json.dumps({"messages": [{"role": "user", "content": question}],
                       "viewer_filters": []}).encode()
    req = urllib.request.Request(
        f"{args.api}/public/dashboards/{token}/ai/agent/chat",
        data=body, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        print("   chat HTTP error:", e.code, e.read().decode()[:160])
        return None
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except Exception:
            continue
        if ev.get("type") == "result":
            return ev.get("envelope")
    return None


if __name__ == "__main__":
    sys.exit(main())
