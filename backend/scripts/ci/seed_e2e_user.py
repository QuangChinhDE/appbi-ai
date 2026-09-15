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

WHAT IT GRANTS, AND WHY IT HAS TO. A brand-new account holds nothing, so once the
Agent Flows router was mounted the suite stopped getting 404s and started getting

    {"detail":"Requires 'edit' permission on module 'agent_flows'"}

on every write — a red suite that says nothing about the product, for the second
time in a row. This version creates the account as an ADMINISTRATOR
(`settings: full`, which `_normalize_permissions` back-fills into every module
key), because that is what the developer account these specs were written against
actually is. CI matching the machine the tests were written on is the point.

It still never widens an account that already exists: the grant is applied only
on the row it creates, so running this against a real database cannot promote a
real user. And it does not weaken what the suite proves — `security-forged.spec.ts`
asserts refusals for the UNAUTHENTICATED caller, which no grant here can affect.
Permission-shaped scenarios still create their own narrow accounts.
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

            # ADMINISTRATOR. `settings: full` is the one key the permission layer
            # back-fills from — `_normalize_permissions` reads it and grants every
            # other module implicitly — so this is the whole grant, not a list that
            # goes stale the next time a module is added.
            if hasattr(user, "permissions"):
                user.permissions = {"settings": "full"}
            for flag in ("is_superuser", "is_admin"):
                if hasattr(user, flag):
                    try:
                        setattr(user, flag, True)
                    except Exception:  # noqa: BLE001
                        pass

        db.commit()
        print("%s E2E user %s" % ("created" if created else "refreshed", EMAIL))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
