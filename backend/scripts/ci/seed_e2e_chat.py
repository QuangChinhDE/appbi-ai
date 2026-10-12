"""Seed the Playwright CHAT suite: principals at every access level + chat flows.

Writes a JSON fixture (path: $E2E_CHAT_FIXTURE, default ../e2e/.auth/chat.json)
that e2e/tests/chat/*.spec.ts read. Every token is minted by the PRODUCT's own
`create_access_token`; nothing is forged.

WHY THE FLOWS HAVE NO MODEL STEP. A browser gate must be deterministic, and the
deployment's AI provider is not something CI has (or should spend). Both flows
answer through the REAL engine — real SSE, real run recording, real transcript —
with nodes that need no key:

  fast   one `stop` node that emits a fixed answer.
  slow   a `delay` node, then the same `stop`. The delay is what makes a turn
         still be streaming when the test switches thread or presses Stop.

Live-model answer quality is a separate gate (see the PR report); nothing here
claims it.

Principals (fixed emails, so the reader-pilot cohort can name them BEFORE the
backend starts — `AGENT_FLOW_PILOT_USERS`):

  owner      chat:edit, in the pilot, both flows shared to them
  editor     chat:edit, in the pilot, flows shared — gets an EDIT share of a thread
  viewer     chat:view, in the pilot, flows shared — gets a VIEW share of a thread
  overseer   chat:full, in the pilot — oversight, reads every thread
  outsider   chat:edit, in the pilot, nothing shared
  unenrolled chat:edit, NOT in the pilot, flows shared — must be told up front

Idempotent: users are reused by email; flows and threads are made fresh per run
(unique suffix), so runs never interfere. Refuses to run unless ENVIRONMENT is
test/dev (it creates accounts).
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import uuid

BACKEND = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))

DOMAIN = "chat.e2e.test"
PILOT = ("owner", "editor", "viewer", "overseer", "outsider")
ANSWER = "Doanh thu tháng 9 là 8.043.020.000 ₫ (nguồn: bộ dữ liệu bán hàng)."


def pilot_emails() -> str:
    return ",".join(f"chat-{name}@{DOMAIN}" for name in PILOT)


def main() -> int:
    if (os.environ.get("ENVIRONMENT") or "").lower() not in ("test", "dev", "development"):
        print("refusing: seed_e2e_chat only runs with ENVIRONMENT=test/dev")
        return 2
    if "--pilot-users" in sys.argv:
        print(pilot_emails())
        return 0

    from app.api import auth as auth_api
    from app.core.database import SessionLocal
    from app.models.agent_brain import AgentBrainVersion
    from app.models.resource_share import ResourceShare, ResourceType, SharePermission
    from app.models.user import User, UserStatus

    run = uuid.uuid4().hex[:8]
    none = {k: "none" for k in ("data_sources", "datasets", "explore_charts", "dashboards", "workboards",
                                "govern", "agent_flows", "chat", "observability", "settings")}
    db = SessionLocal()
    try:
        def user(label: str, chat: str, **extra: str) -> User:
            email = f"chat-{label}@{DOMAIN}"
            u = db.query(User).filter(User.email == email).first()
            levels = {**none, "chat": chat, **extra}
            if u is None:
                u = User(id=uuid.uuid4(), email=email, full_name=f"chat {label}",
                         status=UserStatus.ACTIVE, permissions=levels, password_hash=None)
                db.add(u)
            else:
                u.permissions = levels
                u.status = UserStatus.ACTIVE
            db.flush()
            return u

        author = user("author", "edit", agent_flows="edit")
        owner = user("owner", "edit")
        editor = user("editor", "edit")
        viewer = user("viewer", "view")
        overseer = user("overseer", "full")
        outsider = user("outsider", "edit")
        unenrolled = user("unenrolled", "edit")

        def flow(key: str, name: str, nodes: list[dict], description: str) -> str:
            db.add(AgentBrainVersion(
                brain_key=key, version=1, name=name, description=description, status="published",
                owner_email=author.email, created_by=author.email, flow_type="chat",
                body={"name": name, "nodes": nodes},
            ))
            for who in (owner, editor, viewer, unenrolled):
                db.add(ResourceShare(resource_type=ResourceType.AGENT_BRAIN, resource_id=key,
                                     user_id=who.id, permission=SharePermission.VIEW, shared_by=author.id))
            return key

        stop = {"key": "answer", "type": "stop", "name": "Answer", "emit": True, "message": ANSWER}
        fast = flow(f"chat_fast_{run}", f"E2E Doanh thu {run}", [stop],
                    "Trả lời nhanh về doanh thu (trợ lý kiểm thử).")
        slow = flow(f"chat_slow_{run}", f"E2E Chậm {run}",
                    [{"key": "wait", "type": "delay", "name": "Wait", "seconds": 6}, stop],
                    "Trả lời sau vài giây (trợ lý kiểm thử).")
        db.commit()

        def tok(u: User) -> str:
            return auth_api.create_access_token(db.get(User, u.id))

        people = {"author": author, "owner": owner, "editor": editor, "viewer": viewer,
                  "overseer": overseer, "outsider": outsider, "unenrolled": unenrolled}
        out = {
            "run": run,
            "answer": ANSWER,
            "users": {n: {"id": str(u.id), "email": u.email, "access": tok(u)} for n, u in people.items()},
            "flows": {"fast": fast, "slow": slow},
        }
    finally:
        db.close()

    path = pathlib.Path(os.environ.get("E2E_CHAT_FIXTURE")
                        or (BACKEND.parent / "e2e" / ".auth" / "chat.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"chat fixture written: {path} (run {run})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
