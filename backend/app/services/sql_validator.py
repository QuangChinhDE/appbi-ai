"""
SQL query validation utilities — the read-only gate in front of every source.

HOW IT READS SQL
----------------
The old validator stripped ``--`` comments with a regex BEFORE it stripped string
literals, so ``SELECT '--', 1; DROP TABLE x`` lost everything after the quote and
passed. This one tokenizes left to right with a small lexer, so a quote, a comment
marker and a dollar tag are each recognised only where the database would
recognise them. The lexer produces a *skeleton*: the statement with every literal
and comment blanked and every quoted identifier replaced by a placeholder. All
checks run on that skeleton.

Lexing differs by dialect (backslash escapes, ``#`` comments, dollar quoting), and
a lexer that hides MORE than the database does is a bypass. So the skeleton is
built per dialect; an unknown dialect is checked under every mode and must pass
all of them. Ambiguity only ever produces a refusal.

WHAT IT REFUSES
---------------
* more than one statement (one trailing ``;`` is fine);
* anything that does not start with SELECT / WITH (or a parenthesised SELECT);
* DML/DDL/transaction/session keywords anywhere (a data-modifying CTE included);
* ``INTO`` (SELECT INTO, INTO OUTFILE / DUMPFILE, INTO @var);
* server-side functions that read files, open connections, change settings or
  stall the server (dblink, pg_read_file, lo_*, set_config, pg_sleep, DuckDB
  read_csv, ...), also when spelled as a quoted identifier;
* a string literal used as a table (DuckDB ``FROM '/etc/passwd'``);
* MySQL executable comments (``/*! ... */``) and unterminated literals/comments.
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

from app.core.logging import get_logger

logger = get_logger(__name__)


_FORBIDDEN_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE", "MERGE",
    "EXEC", "EXECUTE", "CALL", "GRANT", "REVOKE", "INTO", "COMMIT", "ROLLBACK",
    "SAVEPOINT", "BEGIN", "COPY", "VACUUM", "PREPARE", "DEALLOCATE", "LISTEN",
    "NOTIFY", "ATTACH", "PRAGMA",
)
# `SET` is a statement (refused) but also part of `CHARACTER SET` in MySQL casts.
_SET_RE = re.compile(r"(?<!CHARACTER )\bSET\b")
# `REPLACE` is a string function / BigQuery `SELECT * REPLACE(...)`; only the
# statement forms are refused.
_REPLACE_STMT_RE = re.compile(r"\bREPLACE\s+(?:INTO|LOW_PRIORITY|DELAYED|IGNORE)\b")
# DuckDB (manual / Sheets sources) reads a FILE when a string literal is a table.
_LITERAL_TABLE_RE = re.compile(r"\b(?:FROM|JOIN)\s*\(?\s*''")

_DANGEROUS_FUNCTIONS = re.compile(
    r"^(?:"
    r"DBLINK\w*|SET_CONFIG|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_\w+|PG_STAT_FILE|"
    r"LO_(?:IMPORT|EXPORT|GET|PUT|OPEN|CREAT|CREATE|UNLINK|FROM_BYTEARRAY|TRUNCATE\w*|"
    r"WRITE|READ|LSEEK\w*|TELL\w*|CLOSE)|"
    r"PG_SLEEP\w*|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|"
    r"PG_ROTATE_LOGFILE|PG_ADVISORY\w*|PG_TRY_ADVISORY\w*|PG_LOGICAL\w*|"
    r"PG_REPLICATION\w*|PG_CREATE_\w+|PG_DROP_\w+|PG_PROMOTE|PG_SWITCH_WAL|"
    r"PG_FILE_\w+|QUERY_TO_XML\w*|TABLE_TO_XML\w*|SETVAL|NEXTVAL|"
    r"SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK|RELEASE_LOCK|SYS_EXEC|SYS_EVAL|"
    r"READ_TEXT|READ_BLOB|READ_CSV\w*|READ_PARQUET|READ_JSON\w*|READ_NDJSON\w*|"
    r"PARQUET_SCAN|GLOB|EXTERNAL_QUERY"
    r")$"
)

_FUNC_CALL_RE = re.compile(r"\b([A-Z_][A-Z0-9_$]*)\s*\(")


class _Lexed:
    __slots__ = ("skeleton", "quoted_calls", "error")

    def __init__(self, skeleton: str, quoted_calls: List[str], error: Optional[str]):
        self.skeleton = skeleton
        self.quoted_calls = quoted_calls
        self.error = error


def _is_ident_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def _lex(sql: str, mode: str) -> _Lexed:
    """Blank literals/comments; return the skeleton + names of quoted-ident calls.

    mode: 'postgres' — '' with '' escape (standard_conforming_strings), E'' with
                       backslash escape, $tag$..$tag$, "ident", -- and /* */.
          'mysql'    — '' and "" strings with backslash escape, `ident`,
                       -- , # and /* */ comments; /*! */ is refused.
          'bigquery' — single, double and triple-quoted strings with backslash escape, `ident`,
                       -- , # and /* */ comments.
    Comments are never treated as nested: the unnested reading hides LESS.
    """
    out: List[str] = []
    quoted_calls: List[str] = []
    i, n = 0, len(sql)
    backslash = mode in ("mysql", "bigquery")
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        # ── comments
        if (c == "-" and nxt == "-") or (c == "#" and mode in ("mysql", "bigquery")):
            j = sql.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
            continue
        if c == "/" and nxt == "*":
            if mode == "mysql" and sql[i + 2:i + 3] in ("!", "+"):
                return _Lexed("", [], "MySQL executable comments are not allowed")
            j = sql.find("*/", i + 2)
            if j < 0:
                return _Lexed("", [], "unterminated comment")
            i = j + 2
            out.append(" ")
            continue
        # ── postgres dollar quoting
        if c == "$" and mode == "postgres" and not (i > 0 and (_is_ident_char(sql[i - 1]) or sql[i - 1] == "$")):
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                if j < 0:
                    return _Lexed("", [], "unterminated dollar-quoted string")
                i = j + len(tag)
                out.append(" '' ")
                continue
        # ── string literals
        if c == "'" or (c == '"' and mode in ("mysql", "bigquery")):
            if mode == "bigquery" and sql[i:i + 3] in ("'''", '"""'):
                q3 = sql[i:i + 3]
                j = i + 3
                while True:
                    if j >= n:
                        return _Lexed("", [], "unterminated string literal")
                    if sql[j] == "\\":
                        j += 2
                        continue
                    if sql[j:j + 3] == q3:
                        i = j + 3
                        break
                    j += 1
                out.append(" '' ")
                continue
            esc = backslash or (
                mode == "postgres" and i > 0 and sql[i - 1] in "eE"
                and not (i > 1 and _is_ident_char(sql[i - 2]))
            )
            j = i + 1
            while True:
                if j >= n:
                    return _Lexed("", [], "unterminated string literal")
                ch = sql[j]
                if esc and ch == "\\":
                    j += 2
                    continue
                if ch == c:
                    if j + 1 < n and sql[j + 1] == c:  # doubled-quote escape
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            out.append(" '' ")
            continue
        # ── quoted identifiers
        if (c == '"' and mode == "postgres") or (c == "`" and mode in ("mysql", "bigquery")):
            start = i
            j = i + 1
            buf: List[str] = []
            while True:
                if j >= n:
                    return _Lexed("", [], "unterminated quoted identifier")
                ch = sql[j]
                if ch == c:
                    if j + 1 < n and sql[j + 1] == c:
                        buf.append(c)
                        j += 2
                        continue
                    break
                buf.append(ch)
                j += 1
            inner = "".join(buf)
            i = j + 1
            # A quoted identifier used as a function name must not hide a
            # dangerous function: "pg_read_file"(...), pg_catalog."lo_import"(...)
            if sql[i:].lstrip().startswith("("):
                if sql[max(0, start - 2):start].upper() == "U&":
                    return _Lexed("", [], "unicode-escaped identifiers are not allowed as function names")
                quoted_calls.append(inner.strip().upper())
            out.append(" _qid_ ")
            continue
        out.append(c)
        i += 1
    return _Lexed("".join(out), quoted_calls, None)


_MODES_BY_DIALECT = {
    "postgresql": ("postgres",),
    "postgres": ("postgres",),
    "manual": ("postgres",),          # DuckDB lexes like Postgres
    "google_sheets": ("postgres",),
    "duckdb": ("postgres",),
    "mysql": ("mysql",),
    "bigquery": ("bigquery",),
}


def _modes(dialect: Optional[str]) -> Tuple[str, ...]:
    if dialect:
        key = str(getattr(dialect, "value", dialect)).strip().lower()
        if key in _MODES_BY_DIALECT:
            return _MODES_BY_DIALECT[key]
    return ("postgres", "mysql", "bigquery")


def _check_skeleton(lexed: _Lexed) -> None:
    if lexed.error:
        raise ValueError(f"Only single SELECT queries are allowed: {lexed.error}.")
    body = lexed.skeleton.upper().rstrip()
    while body.endswith(";"):
        body = body[:-1].rstrip()
    if ";" in body:
        raise ValueError("Only single SELECT queries are allowed. Multiple statements detected.")

    head = body.lstrip().lstrip("(").lstrip()
    if not (re.match(r"SELECT\b", head) or re.match(r"WITH\b", head)):
        raise ValueError("Query must start with SELECT. Only SELECT queries are allowed.")

    for keyword in _FORBIDDEN_KEYWORDS:
        if re.search(r"\b" + keyword + r"\b", body):
            raise ValueError(
                f"Only SELECT queries are allowed. Query contains forbidden keyword: {keyword}"
            )
    if _SET_RE.search(body):
        raise ValueError("Only SELECT queries are allowed. Query contains forbidden keyword: SET")
    if _REPLACE_STMT_RE.search(body):
        raise ValueError("Only SELECT queries are allowed. Query contains forbidden keyword: REPLACE")
    if _LITERAL_TABLE_RE.search(body):
        raise ValueError("Only SELECT queries are allowed. A string literal cannot be used as a table.")

    for name in list(_FUNC_CALL_RE.findall(body)) + list(lexed.quoted_calls):
        bare = name.rsplit(".", 1)[-1]
        if _DANGEROUS_FUNCTIONS.match(bare):
            raise ValueError(f"Only SELECT queries are allowed. Function not allowed: {bare.lower()}")


def validate_select_only(sql_query: str, dialect: Optional[str] = None) -> None:
    """Raise ValueError unless *sql_query* is one read-only SELECT statement.

    ``dialect`` is the source type (postgresql / mysql / bigquery / manual /
    google_sheets). Unknown or None = checked under every lexing mode.
    """
    if not sql_query or not sql_query.strip():
        raise ValueError("SQL query cannot be empty")
    if "\x00" in sql_query:
        raise ValueError("SQL query contains a NUL byte")
    for mode in _modes(dialect):
        _check_skeleton(_lex(sql_query, mode))
    logger.debug("SQL validation passed (%d chars)", len(sql_query))
