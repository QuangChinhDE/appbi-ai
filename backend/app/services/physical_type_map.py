"""ONE canonical vocabulary for a column's PHYSICAL type.

Why this module exists
----------------------
Two consumers must agree about every type token, or the system breaks in a way
neither of them can see on its own:

* the snapshot **LOADER** (``DataSourceConnectionService.extract_generic_for_snapshot``)
  decides the BigQuery column type of a materialized snapshot table;
* the semantic **ENGINE gates** (``_measure_value_is_string_typed``,
  ``_joinkey_family``, ``_filter_type_family``) decide whether to SAFE_CAST a
  SUM/AVG argument, a join key, or a filter literal.

Both read the SAME recorded token — ``columns_cache[*].source_type`` (the
physical warehouse type) falling back to the value-sampled ``type``. When the
two sides disagreed about a single token, charts died: a CSV/manual column
recorded ``number`` was LOADED as STRING (the loader did not know that token)
while the gates kept treating it as numeric (no cast) → BigQuery 400
*"No matching signature for aggregate function SUM: STRING"*. Postgres
``NUMERIC`` had the same fate through the token ``unknown``.

So the vocabulary lives here exactly once. The invariant every consumer relies
on is:

    ``bq_load_type(...) == "STRING"``  ⟺  the engine must SAFE_CAST that column

which is exposed directly as :func:`loads_as_text` — the gates call that
instead of keeping their own token sets.

``LOADER_VERSION`` is part of the snapshot fingerprint (see
``snapshot_service._fingerprint``): bump it whenever a mapping below changes so
snapshots built by an older map are rebuilt instead of silently serving
mistyped columns.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

# Bump on ANY mapping change below — snapshots built by an older map become
# stale (fingerprint mismatch) and are rebuilt on the next sync/publish.
LOADER_VERSION = "ptm-2"

# ── Canonical families ───────────────────────────────────────────────────────
# Tokens are lowercased, parameter-stripped (``numeric(10,2)`` → ``numeric``)
# and array-suffix-stripped (``int4[]`` → ``int4``) before lookup.

_INT = {
    "int", "int2", "int4", "int8", "int16", "int32", "int64", "integer",
    "bigint", "smallint", "tinyint", "mediumint", "smallserial", "serial",
    "bigserial", "long", "short", "byteint",
}
_FLOAT = {
    "float", "float4", "float8", "float32", "float64", "double",
    "double precision", "real",
}
# Exact decimals — must NOT become FLOAT64 (money loses cents).
_DECIMAL = {"numeric", "decimal", "dec", "fixed", "money", "smallmoney"}
_BIGDECIMAL = {"bignumeric", "bigdecimal"}
# A GENERIC numeric label with no width: what CSV/manual inference emits
# (``_infer_type`` in api/datasources.py) and what some drivers report.
_GENERIC_NUMBER = {"number", "num", "numeric_unknown"}
_STRING = {
    "string", "str", "text", "varchar", "character varying", "char",
    "character", "bpchar", "nchar", "nvarchar", "ntext", "longtext",
    "mediumtext", "tinytext", "clob", "utf8", "enum", "set", "uuid", "name",
    "citext", "xml", "inet", "cidr", "macaddr",
}
_BOOL = {"bool", "boolean"}
_DATE = {"date"}
_TIME = {"time", "timetz", "time without time zone", "time with time zone"}
_TIMESTAMP = {
    "timestamp", "timestamptz", "datetime", "datetime2", "smalldatetime",
    "timestamp with time zone", "timestamp without time zone",
}
# Structured / opaque values. ``_json_safe`` serialises these to a JSON string
# before the LOAD, so STRING is the faithful physical type.
_JSON = {"json", "jsonb", "record", "struct", "array", "object", "variant", "geography"}
_BYTES = {"bytes", "bytea", "blob", "binary", "varbinary", "longblob", "image"}

_FAMILY_BY_TOKEN: dict[str, str] = {}
for _tokens, _fam in (
    (_INT, "int"),
    (_FLOAT, "float"),
    (_DECIMAL, "decimal"),
    (_BIGDECIMAL, "bigdecimal"),
    (_GENERIC_NUMBER, "number"),
    (_STRING, "string"),
    (_BOOL, "bool"),
    (_DATE, "date"),
    (_TIME, "time"),
    (_TIMESTAMP, "timestamp"),
    (_JSON, "json"),
    (_BYTES, "bytes"),
):
    for _t in _tokens:
        _FAMILY_BY_TOKEN[_t] = _fam

# Families whose values are numbers (any width) — used by the join-key and
# filter-literal gates to decide "compare as number".
NUMERIC_FAMILIES = frozenset({"int", "float", "decimal", "bigdecimal", "number"})
# Families whose materialized column holds TEXT — the gates SAFE_CAST these.
TEXT_FAMILIES = frozenset({"string", "json", "bytes"})

_BQ_BY_FAMILY = {
    "int": "INT64",
    "float": "FLOAT64",
    "decimal": "NUMERIC",
    "bigdecimal": "BIGNUMERIC",
    "bool": "BOOL",
    "date": "DATE",
    "time": "TIME",
    "timestamp": "TIMESTAMP",
    "string": "STRING",
    "json": "STRING",
    "bytes": "STRING",
}

# BigQuery column type → the canonical token to RECORD back on a column, so a
# snapshot can tell the model what it actually stored (snapshot_service stamps
# `source_type` with this when the loader had to downgrade a column).
TOKEN_BY_BQ_TYPE = {
    "INT64": "int64",
    "FLOAT64": "float64",
    "NUMERIC": "numeric",
    "BIGNUMERIC": "bignumeric",
    "BOOL": "bool",
    "DATE": "date",
    "TIME": "time",
    "TIMESTAMP": "timestamp",
    "STRING": "string",
}


def _norm(token: Any) -> str:
    """Lowercase, trim, drop type parameters and array suffixes."""
    t = str(token or "").strip().lower()
    if not t:
        return ""
    if t.endswith("[]"):
        t = t[:-2].strip()
    if "(" in t:
        t = t.split("(", 1)[0].strip()
    # Postgres reports arrays as `_int4`; BigQuery as `ARRAY<INT64>`.
    if t.startswith("_"):
        t = t[1:]
    if t.startswith("array<"):
        return "array"
    return t


def family(token: Any) -> Optional[str]:
    """Canonical family of a type token, or ``None`` when unrecognised.

    ``None`` is meaningful: it means "we do not know what this column is"
    (a driver token nobody mapped, or the literal ``unknown`` Postgres used to
    report for OID 1700). Callers must then fall back to another signal rather
    than assume text.
    """
    t = _norm(token)
    if not t or t == "unknown":
        return None
    return _FAMILY_BY_TOKEN.get(t)


def bq_load_type(source_type: Any, sampled_type: Any = None) -> str:
    """The BigQuery column type a snapshot LOAD must use for this column.

    ``source_type`` is the PHYSICAL warehouse type (authoritative when known);
    ``sampled_type`` is the value-sampled semantic type from ``columns_cache``
    and is only consulted when the physical one is missing or width-less.

    Deliberate choices:

    * a GENERIC ``number`` (CSV/manual) → ``FLOAT64``. The manual connector
      materialises such a column as ``float64`` in DuckDB
      (``_build_arrow_table_from_sheet``), so FLOAT64 keeps snapshot ≡ live.
      It is refined to NUMERIC only when the sampled type says exact-decimal,
      so money never becomes a float.
    * an UNKNOWN physical token falls through to the sampled type — this is
      what makes a Postgres ``NUMERIC`` (OID 1700 → ``unknown`` on legacy
      caches) land as exact NUMERIC instead of STRING.
    * ``json``/``bytes``/unresolvable → ``STRING``: those values are
      JSON-serialised / base64'd before the load, so STRING is faithful, and
      :func:`loads_as_text` then tells the engine to SAFE_CAST them.
    """
    fam = family(source_type)
    if fam == "number":
        sam = family(sampled_type)
        if sam in ("decimal", "bigdecimal"):
            return _BQ_BY_FAMILY[sam]
        return "FLOAT64"
    if fam is None:
        fam = family(sampled_type)
        if fam == "number":
            return "FLOAT64"
    if fam is None:
        return "STRING"
    return _BQ_BY_FAMILY.get(fam, "STRING")


def bq_extract_load_type(source_type: Any, sampled_type: Any = None) -> str:
    """The BigQuery type to LOAD a federated (non-BigQuery) column with.

    Same as :func:`bq_load_type`, with one deliberate promotion: a column whose
    physical storage is TEXT but whose MODEL type is a date/time family is
    materialized as DATE / TIMESTAMP / TIME.

    Why only here, and why only dates: for a schema-less source (an uploaded CSV,
    a Google Sheet) every cell is text, so "physical type" is a fiction and the
    model's detected type is the only real declaration — the DA sees the field
    labelled DATE in the builder. A text NUMBER column still works downstream
    (the engine SAFE_CASTs before SUM/filters), but a text DATE column breaks the
    entire date layer: ``TIMESTAMP_TRUNC(STRING, MONTH)`` is rejected outright,
    date filters compare text to dates, and the axis sorts lexicographically. The
    caller VERIFIES the promotion against the extracted values
    (:func:`verified_bq_type`), so a column whose values are not ISO falls back
    to STRING instead of failing the load.

    Not applied to the engine's cast gates (:func:`loads_as_text`): those describe
    what a column IS, and a BigQuery-hosted text column stays text no matter what
    the model calls it — the engine casts it at query time instead."""
    promoted = family(sampled_type)
    if promoted in ("date", "timestamp", "time") and family(source_type) in TEXT_FAMILIES:
        return _BQ_BY_FAMILY[promoted]
    return bq_load_type(source_type, sampled_type)


def loads_as_text(source_type: Any, sampled_type: Any = None) -> bool:
    """True when this column is (or would be) materialized as TEXT.

    THE gate the semantic engine uses before emitting ``SUM``/``AVG`` over a
    bare column, and the reason this module exists: it is defined as the exact
    complement of :func:`bq_load_type`, so "the loader wrote STRING" and "the
    engine casts" can never drift apart again.
    """
    return bq_load_type(source_type, sampled_type) == "STRING"


def is_string_physical(token: Any) -> bool:
    """True when a single token denotes text storage."""
    return family(token) in TEXT_FAMILIES


def is_number_physical(token: Any) -> bool:
    """True when a single token denotes numeric storage (any width)."""
    return family(token) in NUMERIC_FAMILIES


def compare_family(source_type: Any, sampled_type: Any = None) -> Optional[str]:
    """``'number'`` | ``'string'`` | ``None`` for join-key / literal coercion.

    Resolves through the same map as the loader, so a key that was
    materialized as STRING is treated as text even when the model labelled it
    ``number`` — the mismatch that produced ``STRING = INT64`` join 400s.
    """
    bq = bq_load_type(source_type, sampled_type)
    if bq == "STRING":
        return "string"
    if bq in ("INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC"):
        return "number"
    return None


def token_for_bq_type(bq_type: Any) -> str:
    """Canonical token to record for a BigQuery column type (round-trip safe)."""
    return TOKEN_BY_BQ_TYPE.get(str(bq_type or "").strip().upper(), "string")


# ── Value-level verification (loader safety net) ─────────────────────────────

_TRUTHY = {"true", "t", "yes", "y", "1"}
_FALSY = {"false", "f", "no", "n", "0"}


def value_fits_bq_type(bq_type: str, value: Any) -> bool:
    """Can ``value`` be stored in ``bq_type`` without loss or a load error?

    Used by the loader to VERIFY a declared type against the data actually
    extracted, before betting a whole snapshot build on it. Conservative on
    purpose:

    * a numeric-looking string that is FORMAT-SENSITIVE (``"007"``, ``"+7"``,
      ``"1,234"``, ``" 7 "``) does NOT fit a numeric column — those are codes
      or locale-formatted text, and silently turning ``"007"`` into ``7``
      corrupts an identifier;
    * a DATE/TIME/TIMESTAMP column only accepts ISO-shaped text (what
      BigQuery's JSON loader accepts) — anything else would fail the whole
      LOAD job, so the column is better off as STRING;
    * ``None`` always fits (NULL).
    """
    if value is None:
        return True
    if bq_type == "STRING":
        return True
    if bq_type in ("INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC"):
        if isinstance(value, bool):
            return False
        if isinstance(value, int):
            return True
        if isinstance(value, float):
            # NaN / ±Infinity cannot be stored in an INT64 or NUMERIC column and
            # would fail the LOAD job, taking the whole snapshot with it.
            if value != value or value in (float("inf"), float("-inf")):
                return False
            return bq_type != "INT64" or value == int(value)
        if not isinstance(value, str):
            return False
        text = value.strip()
        if not text:
            return True  # empty → NULL
        if text != value:
            return False  # padded text — not a clean number
        if text[0] == "+":
            return False  # "+7" is formatted text, not a stored number
        body = text[1:] if text[0] == "-" else text
        if len(body) > 1 and body[0] == "0" and body[1] != ".":
            return False  # "007" — a leading-zero identifier, never a number
        try:
            parsed = float(text)
            if bq_type == "INT64":
                return parsed == int(parsed)
        except (ValueError, OverflowError):
            # unparseable, or NaN/Infinity (int(nan) raises) — not a stored number
            return False
        return True
    if bq_type == "BOOL":
        if isinstance(value, bool):
            return True
        return isinstance(value, str) and value.strip().lower() in (_TRUTHY | _FALSY)
    if bq_type in ("DATE", "TIME", "TIMESTAMP"):
        if not isinstance(value, str):
            return False
        text = value.strip()
        if not text:
            return True
        if bq_type == "DATE":
            return _is_iso_date(text)
        if bq_type == "TIME":
            return _is_iso_time(text)
        # TIMESTAMP / DATETIME: ISO date, optionally followed by a time part.
        head = text.replace("T", " ").split(" ", 1)
        if not _is_iso_date(head[0]):
            return False
        return len(head) == 1 or _is_iso_time(head[1].rstrip("Z").split("+", 1)[0].strip())
    return True


def _is_iso_date(text: str) -> bool:
    parts = text.split("-")
    if len(parts) != 3 or len(parts[0]) != 4:
        return False
    return all(p.isdigit() for p in parts) and 1 <= len(parts[1]) <= 2 and 1 <= len(parts[2]) <= 2


def _is_iso_time(text: str) -> bool:
    if not text:
        return False
    body = text.split(".", 1)[0]
    parts = body.split(":")
    if not 2 <= len(parts) <= 3:
        return False
    return all(p.isdigit() and len(p) <= 2 for p in parts)


def verified_bq_type(bq_type: str, values: Iterable[Any]) -> str:
    """``bq_type`` if every value fits it, else ``"STRING"``.

    A declared type that the DATA does not honour is not a reason to fail a
    snapshot build (a BigQuery JSON load rejects a bad DATE outright) nor to
    silently NULL rows: the column falls back to STRING, and the caller records
    that so the engine's gates SAFE_CAST it — the same, already-proven
    behaviour Google-Sheets columns have always had.
    """
    if bq_type == "STRING":
        return "STRING"
    for v in values:
        if not value_fits_bq_type(bq_type, v):
            return "STRING"
    return bq_type

# ── Rebuild decision for snapshots built by the OLD (buggy) map ──────────────
# This exists for ONE purpose: deciding whether an EXISTING snapshot may hold
# mistyped columns and therefore has to be rebuilt. Without it the only safe
# answer would be "rebuild every federated snapshot", which churns reports that
# are in use and were never affected.


def legacy_bq_load_type(source_type: Any, sampled_type: Any = None) -> str:
    """The mapping snapshots were built with BEFORE this module existed.

    Frozen on purpose — it is history, not a policy. Reproduced from
    ``datasource_service._bq_type`` as of commit 162f7fa: a substring table that
    silently typed anything it did not recognise (notably ``number`` from CSV /
    manual inference and ``unknown`` from the Postgres OID gap) as STRING."""
    t = str(source_type or sampled_type or "").strip().lower()
    if any(k in t for k in ("timestamp", "datetime")):
        return "TIMESTAMP"
    if t == "date":
        return "DATE"
    if t == "time":
        return "TIME"
    if "bool" in t:
        return "BOOL"
    if any(k in t for k in ("numeric", "decimal")):
        return "NUMERIC"
    if any(k in t for k in ("float", "double", "real")):
        return "FLOAT64"
    if "int" in t:
        return "INT64"
    return "STRING"


def mapping_changed_for(columns: Iterable[Any]) -> bool:
    """True when THIS table's columns would be typed differently now than they
    were when its snapshot was built — i.e. the snapshot is suspect and must be
    rebuilt. False ⇒ its physical columns are exactly what the current map would
    produce, so the snapshot stays valid and no report is disturbed."""
    for col in columns or []:
        if not isinstance(col, dict):
            continue
        src, sam = col.get("source_type"), col.get("type")
        if bq_extract_load_type(src, sam) != legacy_bq_load_type(src, sam):
            return True
    return False
