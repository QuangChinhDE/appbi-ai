"""Make the test suite collectable, wherever it is run from.

THE PROBLEM THIS SOLVES
-----------------------
`app.core.database` builds the SQLAlchemy engine at IMPORT time, so a test module
that imports anything from `app` needs `DATABASE_URL` to be parseable before it is
imported. Every test file therefore opened with its own
`os.environ.setdefault("DATABASE_URL", "sqlite:///...")`.

`setdefault` is the wrong verb. An environment can define the variable as an EMPTY
STRING — the application image does exactly that, and compose supplies the real
value at run time — and an empty value is still a present key, so `setdefault`
leaves it empty and SQLAlchemy raises

    Could not parse SQLAlchemy URL from string ''

during collection. Measured in this deployment: running `pytest tests` inside the
backend container produced 67 collection errors and zero tests, all of them this.
A suite that cannot be collected is a suite nobody is running, and it had been
sitting behind a message that says nothing about tests.

`conftest.py` is imported before any test module, so setting it here fixes every
file at once and new files inherit it without repeating the incantation.

WHAT IT DOES NOT DO
-------------------
It never overrides a value that is already set. A test run against a real database
— locally, or in CI with a service container — keeps that database; this only
supplies something parseable when nothing else has.
"""
from __future__ import annotations

import os
import pathlib

_HERE = pathlib.Path(__file__).resolve().parent

# SET WHEN FALSY, not `setdefault`. That distinction is the entire point.
if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = f"sqlite:///{_HERE / '.pytest-fallback.db'}"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = str(_HERE / ".testdata")
