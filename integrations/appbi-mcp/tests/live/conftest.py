"""Live suite guard: a skipped journey is never reported as a pass.

Only journeys listed in APPBI_LIVE_ALLOWED_SKIPS (comma-separated test names) may
skip — in public CI that is the BigQuery publish, which needs an operator-owned
credential. Any other skip fails the session.
"""

from __future__ import annotations

import os

import pytest


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is None:
        return
    allowed = {s.strip() for s in os.environ.get("APPBI_LIVE_ALLOWED_SKIPS", "").split(",") if s.strip()}
    skipped = [r.nodeid for r in reporter.stats.get("skipped", []) if getattr(r, "nodeid", None)]
    unexpected = [n for n in skipped if n.split("::")[-1] not in allowed]
    if unexpected:
        reporter.write_line(f"UNEXPECTED SKIPS (not coverage): {unexpected}", red=True)
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
    if skipped and not unexpected:
        reporter.write_line(f"Allowed skips, reported as NOT VERIFIED: {skipped}", yellow=True)
