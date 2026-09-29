"""Read-only deploy check: which stored public links behave differently under V3.

    DATABASE_URL=... python backend/scripts/audit_public_links.py [--json]

Lists, per active link (multi-link rows, workboard-managed rows and the legacy
``dashboards.public_filters_config``), the findings of
``app.services.public_link_audit.audit_link``:

  refused_malformed       every public request is refused (409) until fixed
  empty_against_boundary  a page / the report now returns no rows on this link
  narrowed_by_boundary    the report's own filter now also applies (fewer rows)

Embed claims are passed per request and are not stored, so they cannot be
audited here: an embed claim is judged by the same rules at request time (a
malformed claim is a 400).
Exit code 1 when any link would be refused — run it before deploying.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.database import SessionLocal  # noqa: E402
from app.models.models import Dashboard, DashboardPublicLink  # noqa: E402
from app.services.public_link_audit import REFUSED, audit_link  # noqa: E402


def main() -> int:
    as_json = "--json" in sys.argv
    rows = []
    db = SessionLocal()
    try:
        dashboards = {d.id: d for d in db.query(Dashboard).all()}
        for link in db.query(DashboardPublicLink).filter(DashboardPublicLink.is_active.is_(True)).all():
            dash = dashboards.get(link.dashboard_id)
            if dash is None:
                continue
            for f in audit_link(link.filters_config, filters_config=dash.filters_config, pages_config=dash.pages_config):
                rows.append({"dashboard_id": dash.id, "dashboard": dash.name, "link_id": link.id,
                             "link": link.name, "source": getattr(link, "source", None), **f})
        for dash in dashboards.values():
            if getattr(dash, "share_token", None) and dash.public_filters_config:
                for f in audit_link(dash.public_filters_config, filters_config=dash.filters_config,
                                    pages_config=dash.pages_config):
                    rows.append({"dashboard_id": dash.id, "dashboard": dash.name, "link_id": None,
                                 "link": "(legacy share link)", "source": "legacy", **f})
    finally:
        db.close()
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        for r in rows:
            print(f"[{r['kind']}] dashboard {r['dashboard_id']} '{r['dashboard']}' · link {r['link_id']} '{r['link']}'"
                  f" · field {r['field']}{' · ' + r['where'] if r.get('where') else ''}\n    → {r['remedy']}")
        print(f"{len(rows)} finding(s); {sum(1 for r in rows if r['kind'] == REFUSED)} link entr(ies) refused.")
    return 1 if any(r["kind"] == REFUSED for r in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
