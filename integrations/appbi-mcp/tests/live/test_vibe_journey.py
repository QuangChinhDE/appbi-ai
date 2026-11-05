"""Live AI Vibe / Report-as-Code journey: real MCP client (SDK + OAuth), real browser,
real AppBI backend and Postgres.

Proves, on the real renderer, that a proposed change is SHOWN before it is SAVED:
the proposal renders in Report Studio while the report still has no new revision;
only the browser approval saves it; a rejected or stale plan saves nothing; publish
is a separate approval; another user and a read-only user cannot act on the report.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import httpx2
import pytest

from .harness import API_URL, RIG_URL, Person, appbi_session_token, browser, mcp_session, rig_state, tool_json
from .test_acceptance import build_dataset, person, tables

pytestmark = pytest.mark.live

MARK = "MCP-PROPOSAL-MARK"
EVIDENCE = Path(os.environ.get("APPBI_LIVE_EVIDENCE", ".artifacts/live-evidence"))


async def _report(token: str, rid: int) -> dict:
    async with httpx2.AsyncClient(timeout=30) as c:
        r = await c.get(f"{API_URL}/report-artifacts/{rid}", headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        return r.json()


async def _frame_text(page, timeout_ms: int = 30_000, want: str | None = None) -> str:
    """Text the REAL report document renders (the isolated-origin frame); with `want`,
    wait until it shows that text (the frame renders asynchronously)."""
    deadline = time.time() + timeout_ms / 1000
    last = ""
    while time.time() < deadline:
        for f in page.frames:
            if "report-docs" in f.url:
                try:
                    body = await f.inner_text("body")
                    if body.strip():
                        last = body
                        if want is None or want in body:
                            return body
                except Exception:  # noqa: BLE001 - frame still loading
                    pass
        await page.wait_for_timeout(500)
    return last


async def _open(page, p: Person, url: str) -> None:
    """Navigate like a user: if AppBI asks to sign in again, do it and come back."""
    await page.goto(url)
    await page.wait_for_load_state("domcontentloaded")
    for _ in range(2):
        if "/login" not in page.url:
            return
        # AppBI rate-limits sign-in/refresh per IP (5-10/min); every rig browser shares
        # the edge's IP, so wait the window out once, as a user would retry.
        await page.wait_for_timeout(62_000)
        await page.goto(url)
        await page.wait_for_load_state("domcontentloaded")
        if "/login" in page.url:
            await p.login(page)
            await page.wait_for_url(lambda u: "/login" not in u, timeout=30_000)
            await page.goto(url)
            await page.wait_for_load_state("domcontentloaded")


async def _shot(page, name: str) -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    await page.screenshot(path=str(EVIDENCE / f"{name}.png"), full_page=True)


async def test_vibe_preview_before_save_approval_publish_and_permissions():
    stamp = int(time.time())
    a = rig_state()["users"]["author_a"]
    async with browser() as b:
        p = await person("author_a", b)
        async with mcp_session(p) as client:
            names = {t.name for t in (await client.list_tools()).tools}
            assert {"plan_vibe_report", "plan_vibe_source_edit", "plan_vibe_ai_edit", "plan_vibe_restore",
                    "compare_vibe_revisions", "get_vibe_report"} <= names

            ds = await build_dataset(client, p, {"name": f"Vibe base {stamp}", "tables": tables(0, "orders"),
                                                 "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount"}]})
            assert ds["status"] == "draft_ready", ds

            # 1. Create (blank, no AI): plan -> not approved -> browser approval -> execute.
            pl = tool_json(await client.call_tool("plan_vibe_report", {"dataset_id": ds["dataset_id"], "name": f"Vibe {stamp}", "mode": "blank"}))
            assert pl["status"] == "awaiting_approval", pl
            assert tool_json(await client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}))["status"] == "awaiting_approval"
            assert await p.approve(pl["approval_url"]) == "Approved"
            made = tool_json(await client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}))
            assert made["status"] == "draft_ready" and made["draft_number"] == 1, made
            rid = made["report_id"]
            token = await appbi_session_token(a["email"], a["password"])

            # 2. A code change is a PROPOSAL: rendered by the real Studio before anything is saved.
            rev1 = tool_json(await client.call_tool("get_vibe_revision", {"report_id": rid, "number": 1}))
            new_html = rev1["html"] + f'\n<section data-rac-region="mcp"><h2>{MARK}</h2></section>'
            edit = tool_json(await client.call_tool("plan_vibe_source_edit", {"report_id": rid, "html": new_html, "css": rev1["css"], "js": rev1["js"]}))
            assert edit["status"] == "awaiting_approval" and "?proposal=" in edit["preview_url"], edit
            page = await p.browser_context.new_page()
            console: list[str] = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"[:300]))
            await _open(page, p, edit["preview_url"])
            await page.get_by_test_id("studio-preview-proposal").wait_for(timeout=30_000)
            text = await _frame_text(page, want=MARK)
            await _shot(page, "vibe-1-proposal-preview-before-save")
            if MARK not in text:
                (EVIDENCE / "vibe-preview-console.txt").write_text(chr(10).join(console), encoding="utf-8")
            assert MARK in text, ("the proposal is what the real renderer shows", [f.url for f in page.frames])
            assert (await _report(token, rid))["draft_number"] == 1, "previewing saved nothing"

            # The approval page shows the real diff and the same preview link.
            ap = await p.browser_context.new_page()
            await ap.goto(edit["approval_url"])
            body = await ap.inner_text("body")
            assert MARK in body and "Preview BEFORE anything is saved" in body
            await _shot(ap, "vibe-2-approval-page")
            await ap.get_by_role("button", name="Approve").click()
            await ap.wait_for_load_state("domcontentloaded")
            assert await ap.locator("h1").first.inner_text() == "Approved"
            await ap.close()
            saved = tool_json(await client.call_tool("execute_plan", {"plan_id": edit["plan_id"]}))
            assert saved["status"] == "draft_ready" and saved["draft_number"] == 2, saved
            again = tool_json(await client.call_tool("execute_plan", {"plan_id": edit["plan_id"]}))
            assert again.get("already_done") and (await _report(token, rid))["draft_number"] == 2, "no duplicate save"

            # The revision link opens the real Studio on that revision.
            await _open(page, p, f"{RIG_URL}/dashboards/code/{rid}?revision=1")
            await page.get_by_test_id("studio-preview-old").wait_for(timeout=30_000)
            assert MARK not in await _frame_text(page, timeout_ms=8_000, want=MARK)
            await _open(page, p, f"{RIG_URL}/dashboards/code/{rid}?revision=2")
            rev2 = await _frame_text(page, want=MARK)
            await _shot(page, "vibe-3-saved-revision-2")
            assert MARK in rev2, [f.url for f in page.frames]

            # 3. Rejected in the browser -> nothing saved, plan can never run.
            rej = tool_json(await client.call_tool("plan_vibe_source_edit", {"report_id": rid, "html": new_html + "<p>rejected</p>", "css": "", "js": ""}))
            assert await p.approve(rej["approval_url"], decision="Reject") == "Rejected"
            assert tool_json(await client.call_tool("execute_plan", {"plan_id": rej["plan_id"]}))["status"] == "rejected"
            assert (await _report(token, rid))["draft_number"] == 2

            # 4. A save in Studio after approval -> stale_plan, the other save survives.
            stale = tool_json(await client.call_tool("plan_vibe_source_edit", {"report_id": rid, "html": new_html + "<p>mcp late</p>", "css": "", "js": ""}))
            assert await p.approve(stale["approval_url"]) == "Approved"
            d = await _report(token, rid)
            async with httpx2.AsyncClient(timeout=30) as c:
                r = await c.put(f"{API_URL}/report-artifacts/{rid}/source", headers={"Authorization": f"Bearer {token}"},
                                json={"html": d["draft"]["html"] + "<p>studio save</p>", "css": d["draft"]["css"], "js": d["draft"]["js"],
                                      "base_number": d["draft_number"]})
                r.raise_for_status()
            res = tool_json(await client.call_tool("execute_plan", {"plan_id": stale["plan_id"]}))
            assert res["status"] == "stale_plan", res
            after = await _report(token, rid)
            assert "studio save" in after["draft"]["html"] and "mcp late" not in after["draft"]["html"]

            # 5. Restore = new revision; compare.
            cmp = tool_json(await client.call_tool("compare_vibe_revisions", {"report_id": rid, "from_number": 1, "to_number": 2}))
            assert "html" in cmp["diff"]["changed"]
            rs = tool_json(await client.call_tool("plan_vibe_restore", {"report_id": rid, "number": 2}))
            assert await p.approve(rs["approval_url"]) == "Approved"
            restored = tool_json(await client.call_tool("execute_plan", {"plan_id": rs["plan_id"]}))
            assert restored["status"] == "draft_ready" and restored["draft_number"] == after["draft_number"] + 1

            # 6. The author has the dashboards module at EDIT: AppBI lets only FULL publish a
            #    Vibe report (the Studio hides Publish too) and the MCP says so, with no plan.
            denied = tool_json(await client.call_tool("request_publish", {"resource_type": "vibe_report", "resource_id": rid}))
            assert denied["status"] == "forbidden", denied
            await page.close()

        # Publish by an account with FULL (admin): its own approval; nothing live before it.
        adm = await person("admin", b)
        async with mcp_session(adm) as aclient:
            req = tool_json(await aclient.call_tool("request_publish", {"resource_type": "vibe_report", "resource_id": rid}))
            assert req["status"] == "awaiting_approval", req
            assert tool_json(await aclient.call_tool("publish", {"plan_id": req["plan_id"]}))["status"] == "awaiting_approval"
            assert (await _report(token, rid))["published_number"] is None
            ap = await adm.browser_context.new_page()
            await ap.goto(req["approval_url"])
            await _shot(ap, "vibe-4-publish-approval")
            await ap.close()
            assert await adm.approve(req["approval_url"]) == "Approved"
            pub = tool_json(await aclient.call_tool("publish", {"plan_id": req["plan_id"]}))
            assert pub["status"] == "published" and (await _report(token, rid))["published_number"] == restored["draft_number"], pub

        # 7. Another author and a read-only user cannot touch it.
        for key in ("author_b", "reader"):
            q = await person(key, b)
            async with mcp_session(q) as other:
                got = tool_json(await other.call_tool("get_vibe_report", {"report_id": rid}))
                assert got["status"] in ("not_found", "forbidden"), (key, got)
                tried = tool_json(await other.call_tool("plan_vibe_source_edit", {"report_id": rid, "html": "<p>x</p>"}))
                assert tried["status"] in ("not_found", "forbidden", "insufficient_scope"), (key, tried)
                pubs = tool_json(await other.call_tool("request_publish", {"resource_type": "vibe_report", "resource_id": rid}))
                assert pubs["status"] != "awaiting_approval", (key, pubs)
        assert (await _report(token, rid))["draft_number"] == restored["draft_number"]
