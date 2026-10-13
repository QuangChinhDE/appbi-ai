"""The MCP's own persistent state: one SQLite file on the MCP's own volume.

Nothing here is AppBI data. It holds OAuth clients, grants (with the user's
delegated AppBI PAT, Fernet-encrypted with MCP_STATE_KEY), hashed tokens,
plans, approvals, operations and the audit trail.

Single writer by design: the service runs one process (see Dockerfile). Every
statement goes through one connection guarded by a lock, so a check-then-write
sequence inside `transaction()` is atomic.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS clients (
    client_id   TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,              -- dcr | cimd
    info_json   TEXT NOT NULL,
    created_at  REAL NOT NULL,
    fetched_at  REAL
);

CREATE TABLE IF NOT EXISTS auth_txns (
    id            TEXT PRIMARY KEY,
    mode          TEXT NOT NULL,            -- connect | verify
    client_id     TEXT,
    params_json   TEXT NOT NULL,
    binding_hash  TEXT NOT NULL,
    status        TEXT NOT NULL,            -- pending | completed | denied
    created_at    REAL NOT NULL,
    expires_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    client_id       TEXT NOT NULL,
    scopes          TEXT NOT NULL,          -- space separated MCP scopes
    appbi_scopes    TEXT NOT NULL,          -- JSON of the PAT's module caps as requested
    pat_enc         BLOB NOT NULL,
    pat_expires_at  REAL,
    created_at      REAL NOT NULL,
    expires_at      REAL NOT NULL,
    revoked_at      REAL,
    revoke_reason   TEXT
);
CREATE INDEX IF NOT EXISTS ix_grants_user ON grants(user_id);

CREATE TABLE IF NOT EXISTS auth_codes (
    code_hash       TEXT PRIMARY KEY,
    grant_id        TEXT NOT NULL,
    client_id       TEXT NOT NULL,
    scopes          TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    redirect_explicit INTEGER NOT NULL,
    resource        TEXT NOT NULL,
    expires_at      REAL NOT NULL,
    used_at         REAL
);

CREATE TABLE IF NOT EXISTS tokens (
    token_hash  TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,              -- access | refresh
    grant_id    TEXT NOT NULL,
    family_id   TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    scopes      TEXT NOT NULL,
    resource    TEXT NOT NULL,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL,
    used_at     REAL,                       -- refresh tokens: set when rotated
    revoked_at  REAL
);
CREATE INDEX IF NOT EXISTS ix_tokens_family ON tokens(family_id);
CREATE INDEX IF NOT EXISTS ix_tokens_grant ON tokens(grant_id);

CREATE TABLE IF NOT EXISTS browser_sessions (
    id_hash     TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    grant_id         TEXT NOT NULL,
    kind             TEXT NOT NULL,         -- dataset | dashboard | dataset_publish | dashboard_publish
    plan_json        TEXT NOT NULL,
    plan_hash        TEXT NOT NULL,
    summary_json     TEXT NOT NULL,
    fingerprint_json TEXT NOT NULL,
    created_at       REAL NOT NULL,
    expires_at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_plans_user ON plans(user_id);

CREATE TABLE IF NOT EXISTS approvals (
    plan_id      TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    plan_hash    TEXT NOT NULL,
    approved_at  REAL NOT NULL,
    expires_at   REAL NOT NULL,
    consumed_at  REAL
);

CREATE TABLE IF NOT EXISTS operations (
    plan_id      TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    status       TEXT NOT NULL,
    result_json  TEXT NOT NULL,
    runner       TEXT,
    runner_until REAL,
    started_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_steps (
    plan_id      TEXT NOT NULL,
    step_key     TEXT NOT NULL,
    status       TEXT NOT NULL,             -- sent | done | failed
    sent_at      REAL,
    done_at      REAL,
    result_json  TEXT,
    error_json   TEXT,
    PRIMARY KEY (plan_id, step_key)
);

CREATE TABLE IF NOT EXISTS audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            REAL NOT NULL,
    request_id    TEXT,
    user_id       TEXT,
    client_id     TEXT,
    grant_id      TEXT,
    event         TEXT NOT NULL,
    args_sha256   TEXT,
    outcome       TEXT NOT NULL,
    appbi_status  INTEGER,
    resource_ids  TEXT,
    duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit(ts);
"""


def sha256_hex(value: str | bytes) -> str:
    data = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def new_secret(prefix: str = "", nbytes: int = 32) -> str:
    """At least 256 bits of entropy; codes and tokens are never stored in clear."""
    return prefix + secrets.token_urlsafe(nbytes)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


class StateStore:
    def __init__(self, state_dir: str, key: bytes, *, filename: str = "appbi_mcp.sqlite3"):
        os.makedirs(state_dir, exist_ok=True)
        self.path = os.path.join(state_dir, filename)
        self._fernet = Fernet(key)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        # executescript cannot run inside an explicit transaction.
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
            )

    # ── plumbing ─────────────────────────────────────────────────────────────

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                yield cur
            except BaseException:
                cur.execute("ROLLBACK")
                raise
            else:
                cur.execute("COMMIT")
            finally:
                cur.close()

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._conn.execute(sql, params).fetchall())

    def query_one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        with self._lock:
            return self._conn.execute(sql, params).rowcount

    def healthy(self) -> bool:
        try:
            with self.transaction() as cur:
                cur.execute("UPDATE meta SET value = value WHERE key = 'schema_version'")
            return True
        except sqlite3.Error:
            return False

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ── secrets at rest ──────────────────────────────────────────────────────

    def encrypt(self, plaintext: str) -> bytes:
        return self._fernet.encrypt(plaintext.encode())

    def decrypt(self, token: bytes) -> str | None:
        try:
            return self._fernet.decrypt(token).decode()
        except InvalidToken:
            return None

    # ── housekeeping ─────────────────────────────────────────────────────────

    def purge_expired(self, now: float | None = None) -> None:
        now = now or time.time()
        day = 86400
        with self.transaction() as cur:
            cur.execute("DELETE FROM auth_txns WHERE expires_at < ?", (now - day,))
            cur.execute("DELETE FROM auth_codes WHERE expires_at < ?", (now - day,))
            cur.execute("DELETE FROM tokens WHERE expires_at < ?", (now - day,))
            cur.execute("DELETE FROM browser_sessions WHERE expires_at < ?", (now,))
            cur.execute("DELETE FROM audit WHERE ts < ?", (now - 180 * day,))
