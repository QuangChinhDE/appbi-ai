#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Create the account the E2E suite signs in with. CI only.

WHY IT EXISTS. The Playwright project logs in through the real login form against
the real API, which means the database has to contain a user. On a developer's
machine that user already exists; on a fresh CI database nothing does, and without
this the whole suite fails at `auth.setup.ts` with a message about a password.

WHY IT IS SAFE TO RUN TWICE. It upserts: an existing account keeps its id and its
permissions, and only the password hash is refreshed. So a local run against a real
database does not create a second admin, and a CI run against an empty one does not
fail on the second attempt.

WHAT IT DOES NOT DO. It does not grant anything beyond what the role system gives a
new account, and it does not touch any other row. Permission-shaped E2E scenarios
create their own narrow accounts rather than widening this one.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from app.api.auth import hash_password  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
PASSWORD = os.environ.get("E2E_PASSWORD", "123456")
NAME = "E2E Admin"


def main() -> int:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if user is None:
            user = User(email=EMAIL, full_name=NAME)
            db.add(user)
            created = True
        else:
            created = False

        user.password_hash = hash_password(PASSWORD)
        # Only set what a fresh row needs; never widen an account that exists.
        if created:
            for field, value in (("auth_provider", "password"),
                                 ("status", "active"),
                                 ("preferred_language", "vi")):
                if hasattr(user, field):
                    try:
                        setattr(user, field, value)
                    except Exception:  # noqa: BLE001 — an Enum that wants its own member
                        pass

        db.commit()
        print("%s E2E user %s" % ("created" if created else "refreshed", EMAIL))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
