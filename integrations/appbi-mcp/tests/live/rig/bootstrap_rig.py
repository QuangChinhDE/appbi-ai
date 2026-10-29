"""Create the rig's test users, permissions and Postgres source through AppBI's HTTP API.

Inputs come from the environment (never from a .env file):
  APPBI_RIG_API          AppBI API base (default http://127.0.0.1:18181/api/v1)
  APPBI_RIG_ADMIN_EMAIL  / APPBI_RIG_ADMIN_PASSWORD   the rig's bootstrap admin
  APPBI_RIG_DB_USER      / APPBI_RIG_DB_PASSWORD      credentials of the rig Postgres
                                                     (the source database `shopsrc`)
Writes APPBI_RIG_STATE (state.json) with the users it created and their random
passwords. Keep that file outside the repository.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx2

API = os.environ.get("APPBI_RIG_API", "http://127.0.0.1:18181/api/v1")
STATE = Path(os.environ["APPBI_RIG_STATE"])

AUTHOR = {"data_sources": "view", "datasets": "edit", "explore_charts": "edit", "dashboards": "edit"}
READER = {"data_sources": "view", "datasets": "view", "explore_charts": "view", "dashboards": "view"}
PEOPLE = {
    "author_a": ("author.a@mcprig.example.com", "Author A", AUTHOR),
    "author_b": ("author.b@mcprig.example.com", "Author B", AUTHOR),
    "reader": ("reader@mcprig.example.com", "Reader R", READER),
}


def main() -> None:
    state = json.loads(STATE.read_text()) if STATE.exists() else {"users": {}}
    admin_email, admin_password = os.environ["APPBI_RIG_ADMIN_EMAIL"], os.environ["APPBI_RIG_ADMIN_PASSWORD"]
    tok = httpx2.post(f"{API}/auth/login", json={"email": admin_email, "password": admin_password}, timeout=30).raise_for_status().json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    admin_id = httpx2.get(f"{API}/auth/me", headers=h).raise_for_status().json()["id"]
    state["users"]["admin"] = {"id": admin_id, "email": admin_email, "password": admin_password}
    existing = {u["email"]: u for u in httpx2.get(f"{API}/users/", headers=h).json()}
    for key, (email, name, perms) in PEOPLE.items():
        if email in existing:
            uid, password = existing[email]["id"], state["users"].get(key, {}).get("password")
        else:
            password = "Rig!" + secrets.token_hex(6) + "Aa9"
            uid = httpx2.post(f"{API}/users/", headers=h, json={"email": email, "full_name": name, "password": password,
                                                                   "auth_provider": "password"}).raise_for_status().json()["id"]
        httpx2.put(f"{API}/permissions/{uid}", headers=h, json={"permissions": perms}).raise_for_status()
        state["users"][key] = {"id": uid, "email": email, "password": password}
    if not state.get("datasource_id"):
        cfg = {"host": os.environ.get("APPBI_RIG_DB_HOST", "appbi-db"), "port": int(os.environ.get("APPBI_RIG_DB_PORT", "5432")),
               "database": "shopsrc", "schema": "shop",
               "username": os.environ["APPBI_RIG_DB_USER"], "password": os.environ["APPBI_RIG_DB_PASSWORD"]}
        state["datasource_id"] = httpx2.post(f"{API}/datasources/", headers=h, json={"name": "Shop (rig)", "type": "postgresql", "config": cfg}).raise_for_status().json()["id"]
    for key in ("author_a", "author_b", "reader"):
        httpx2.post(f"{API}/shares/datasource/{state['datasource_id']}", headers=h, json={"email": state["users"][key]["email"], "permission": "view"})
    STATE.write_text(json.dumps(state, indent=2))
    print("rig ready: users", sorted(state["users"]), "datasource", state["datasource_id"])


if __name__ == "__main__":
    main()
