#!/usr/bin/env python3
"""
AppBI — get a ROTATING embed link for a report, using your PAT.

Uses the SAME Personal Access Token (PAT) your MCP already uses. Given a
dashboard the token's owner can EDIT, it returns a short-lived, rotating
~256-char embed URL (`/embed/emb_...`) valid ~1h. After it expires, call again
to get a NEW url. This link is DIFFERENT from a public-share link created in the
Public Link modal — it rotates and self-expires.

    Authorization: Bearer appbi_pat_....       ← the ONE token, nothing else

Standard library only.

------------------------------------------------------------------------------
Usage:

    export APPBI_BASE_URL="https://report-demo.base-datateam.com"
    export APPBI_TOKEN="appbi_pat_xxx.yyy"     # a PAT with the `dashboards: edit` scope
    export APPBI_DASHBOARD_ID=63               # a dashboard the token's owner can EDIT
    python docs/embed_quickstart.py

Optional:
    APPBI_PUBLIC_URL   host that serves the /embed page for the browser
                       (default = APPBI_BASE_URL; same host in production)

Edit SCOPE_FILTERS below to lock the report to a per-viewer slice, or leave it
empty and set FULL_REPORT=True to embed the whole report.

NOTE: only a PAT can mint (a browser session is refused), the PAT needs the
`dashboards: edit` scope, and its owner must be able to EDIT the dashboard
(else HTTP 403). Contract: docs/embed-integration-api.md.
------------------------------------------------------------------------------
"""
import json
import os
import urllib.error
import urllib.request

API_URL = os.environ.get("APPBI_BASE_URL", "https://report-demo.base-datateam.com").rstrip("/")
PUBLIC_URL = os.environ.get("APPBI_PUBLIC_URL", API_URL).rstrip("/")
TOKEN = os.environ["APPBI_TOKEN"]
DASHBOARD_ID = int(os.environ.get("APPBI_DASHBOARD_ID", "63"))

RESOLVE_PATH = "/api/v1/integrations/embed/resolve"

# Lock the report to this per-viewer slice (RLS-style: the viewer sees only this
# and cannot change it — enforced server-side). Use the qualified `semanticField`
# + `datasetId` of YOUR dashboard's fields. Leave empty + FULL_REPORT=True for the
# whole report.
#
# The example below is the VERIFIED shape for demo dashboard 63 (field "Team"):
# resolving with value ["Santiago"] scopes every chart to that team; a value the
# data doesn't contain returns an empty (but valid) report — proof the lock holds.
SCOPE_FILTERS = [
    # {
    #     "field": "Team",
    #     "semanticField": "dataset_table_382.Team",
    #     "datasetId": 67,
    #     "operator": "in",
    #     "value": ["Santiago"],
    # },
]
FULL_REPORT = True  # set False once you uncomment a SCOPE_FILTERS entry above


def resolve():
    body = {"dashboard_id": DASHBOARD_ID, "filters": SCOPE_FILTERS}
    if FULL_REPORT:
        body["full_report"] = True
    req = urllib.request.Request(
        API_URL + RESOLVE_PATH,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        if e.code == 403:
            raise SystemExit(f"[resolve] HTTP 403 — {detail}. The PAT needs the `dashboards: edit` "
                             f"scope and its owner must be able to edit dashboard {DASHBOARD_ID}.")
        if e.code == 404 and "not deployed" not in detail:
            raise SystemExit(f"[resolve] HTTP 404 — dashboard {DASHBOARD_ID} not found "
                             f"(or the embed endpoint isn't deployed on this server yet).")
        raise SystemExit(f"[resolve] failed HTTP {e.code}: {detail}")


def main():
    print(f"Resolving rotating embed link for dashboard {DASHBOARD_ID} "
          f"({'full report' if FULL_REPORT and not SCOPE_FILTERS else str(len(SCOPE_FILTERS)) + ' locked filter(s)'})...")
    r = resolve()
    browser_url = PUBLIC_URL + r["embed_path"]
    print("\nEmbed link (rotating, ~1h):")
    print(f"  expires_at : {r['expires_at']}")
    print(f"  filter_hash: {r['filter_hash']}")
    print(f"\nOPEN IN BROWSER:\n{browser_url}")
    print("\nIFRAME:")
    print(f'<iframe src="{browser_url}" style="width:100%;height:800px;border:0"></iframe>')
    print("\nAfter expires_at the link stops working - call this again to mint a fresh one.")


if __name__ == "__main__":
    main()
