"""The Public Read MCP's own state file: OAuth tables (shared schema) + viewer sessions.

A viewer session is one browser tab showing one public link. It holds the AppBI grant
for that tab (Fernet-encrypted), the tab's bridge secret and pairing code (hashed),
the last view state the tab reported, and the queue of view commands Claude sent it.
"""

from __future__ import annotations

from ..state import StateStore

_PUBLIC_SCHEMA = """
CREATE TABLE IF NOT EXISTS view_sessions (
    id                 TEXT PRIMARY KEY,
    grant_enc          BLOB NOT NULL,          -- AppBI link-bound grant (Fernet)
    browser_hash       TEXT NOT NULL,          -- sha256 of the tab's bridge secret
    pair_hash          TEXT,                   -- sha256 of the pairing code; NULL once used
    pair_expires_at    REAL,
    report_json        TEXT NOT NULL,          -- {kind, name}
    state_json         TEXT,                   -- last view state the tab reported
    state_seq          INTEGER NOT NULL DEFAULT 0,
    created_at         REAL NOT NULL,
    expires_at         REAL NOT NULL,
    last_seen_at       REAL,
    claimed_at         REAL,                   -- when a Claude paired with it
    ended_at           REAL,
    end_reason         TEXT
);
CREATE INDEX IF NOT EXISTS ix_view_sessions_pair ON view_sessions(pair_hash);

CREATE TABLE IF NOT EXISTS view_commands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES view_sessions(id),
    cmd_json    TEXT NOT NULL,
    status      TEXT NOT NULL,                 -- pending | applied | failed | expired
    result_json TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_view_commands_session ON view_commands(session_id, id);
"""


class PublicStore(StateStore):
    def __init__(self, state_dir: str, key: bytes):
        super().__init__(state_dir, key, filename="appbi_public_mcp.sqlite3")
        with self._lock:
            self._conn.executescript(_PUBLIC_SCHEMA)

    def purge_expired(self, now: float | None = None) -> None:
        import time

        super().purge_expired(now)
        now = now or time.time()
        with self.transaction() as cur:
            cur.execute("DELETE FROM view_commands WHERE created_at < ?", (now - 86400,))
            cur.execute("DELETE FROM view_sessions WHERE expires_at < ?", (now - 86400,))
