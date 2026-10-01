"""Runtime verification of the key a many-to-one / one-to-one join trusts.

A relationship declared N:1 is only as good as the data: when the one-side key
has duplicate values, every JOIN through it repeats the fact's rows and every
SUM over it grows — the chart renders, the number is plausible and wrong, and
nothing says so. Declarations are not proof (legacy models carried
`relationship: many_to_one` as a default; the creation-time uniqueness profile
may have been inconclusive; the source changes after a publish).

So the engine records, for each JOIN in a query's FROM chain that it trusts to
be to-one, a KEY PROBE: the same relation and key the JOIN uses, asking whether
any key value occurs twice. Executors run the probes on the same datasource and
credentials as the query, before it:

  * a duplicate → the query is refused, naming the relationship and the key;
  * a probe that cannot run → the query is refused too (an unverifiable
    trusted join is not answered — "unknown" never becomes "unique");
  * no duplicate → the query runs.

Caching follows what the relation IS:

  * an IMMUTABLE relation — a materialized snapshot table: every build writes a
    new versioned physical table (`snap_t<id>_…_v<epoch-ms>`), and the only
    reuse shares a table whose source is unchanged — so a verdict on that
    physical table holds for its lifetime. It is cached (both verdicts), keyed
    by the probe SQL, which names the physical table: generation B can never
    reuse generation A's verdict.
  * a MUTABLE relation — a live source: never cached, in either direction. A
    "unique" verdict is only true when it is taken; reusing it after the source
    gained a duplicate would let the next query fan out and succeed. Every query
    re-probes, immediately before it runs.
"""
from __future__ import annotations

import hashlib
import logging
import re
from typing import Iterable

logger = logging.getLogger(__name__)

_AND_RE = re.compile(r"\s+AND\s+", re.I)
_OR_RE = re.compile(r"\s+OR\s+", re.I)


def _split_top(text: str, sep: re.Pattern) -> list[str]:
    """Split on `sep` where it occurs outside parentheses and quotes."""
    parts, depth, quote, start, i = [], 0, None, 0, 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0:
            m = sep.match(text, i)
            if m and m.end() > i:
                parts.append(text[start:i])
                start = i = m.end()
                continue
        i += 1
    parts.append(text[start:])
    return [p.strip() for p in parts]


def _top_level_equals(text: str) -> list[int]:
    """Positions of a bare `=` (not <=, >=, !=, ==) outside parens/quotes."""
    out, depth, quote = [], 0, None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "=" and depth == 0:
            prev = text[i - 1] if i else ""
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if prev not in "<>!=" and nxt != "=":
                out.append(i)
    return out


def _refs(expr: str, aliases: tuple[str, ...]) -> set[str]:
    return {a for a in aliases if re.search(rf"(?<![\w.]){re.escape(a)}\s*\.", expr)}


def one_side_key(condition: str, one_alias: str, other_alias: str):
    """(key expressions of `one_alias`, predicates on `one_alias` alone) of a
    rendered ON condition, or None when the condition is not a conjunction of
    equalities between the two sides (plus single-side predicates)."""
    cond = (condition or "").strip()
    if not cond or len(_split_top(cond, _OR_RE)) > 1:
        return None
    aliases = (one_alias, other_alias)
    exprs: list[str] = []
    preds: list[str] = []
    for part in _split_top(cond, _AND_RE):
        while part.startswith("(") and part.endswith(")") and len(_split_top(part[1:-1], _AND_RE)) == 1 \
                and _balanced(part[1:-1]):
            part = part[1:-1].strip()
        refs = _refs(part, aliases)
        if refs == {one_alias}:
            preds.append(part)
            continue
        if refs != {one_alias, other_alias}:
            continue  # the other side alone, or a constant: does not change one-side multiplicity
        eqs = _top_level_equals(part)
        if len(eqs) != 1:
            return None
        left, right = part[:eqs[0]].strip(), part[eqs[0] + 1:].strip()
        lr, rr = _refs(left, aliases), _refs(right, aliases)
        if lr == {one_alias} and rr == {other_alias}:
            exprs.append(left)
        elif rr == {one_alias} and lr == {other_alias}:
            exprs.append(right)
        else:
            return None
    if not exprs:
        return None
    return exprs, preds


def _balanced(text: str) -> bool:
    depth = 0
    for ch in text:
        depth += ch == "("
        depth -= ch == ")"
        if depth < 0:
            return False
    return depth == 0


def one_side_probe(condition: str, *, one_alias: str, other_alias: str, relation: str,
                   label: str, view: str, immutable: bool = False) -> dict:
    """The probe of the ONE side of a JOIN, grouped by exactly the expressions
    its ON condition compares (casts and expressions included) — or an
    unverifiable probe (sql None) when the condition is not a key equality."""
    key = one_side_key(condition, one_alias, other_alias)
    if key is None:
        return {"key": f"unverifiable::{label}::{one_alias}", "sql": None, "label": label, "view": view,
                "columns": [], "immutable": immutable,
                "reason": "điều kiện join không phải phép so sánh bằng giữa khoá hai bảng"}
    exprs, preds = key
    where = " AND ".join([f"({e}) IS NOT NULL" for e in exprs] + [f"({p})" for p in preds])
    sql = (
        f"SELECT 1 AS _appbi_dup FROM {relation} AS {one_alias} WHERE {where} "
        f"GROUP BY {', '.join(exprs)} HAVING COUNT(*) > 1 LIMIT 1"
    )
    return {"key": sql, "sql": sql, "label": label, "view": view, "columns": exprs, "immutable": immutable}


def key_probe_sql(relation: str, columns: list[str]) -> str:
    """Rows only when some value of the key occurs more than once."""
    cols = [f"_appbi_kp.{c}" for c in columns]
    not_null = " AND ".join(f"{c} IS NOT NULL" for c in cols)
    return (
        f"SELECT 1 AS _appbi_dup FROM {relation} AS _appbi_kp WHERE {not_null} "
        f"GROUP BY {', '.join(cols)} HAVING COUNT(*) > 1 LIMIT 1"
    )


def statement_key_guard(probes: Iterable[dict]) -> str | None:
    """The in-statement half of the guard, for MUTABLE (live) relations only.

    ``verify_key_probes`` runs before the query, as a separate statement: a
    writer that duplicates a one-side key between that probe and the query is
    not seen by it, and the JOIN fans out. This predicate goes into the WHERE of
    the very statement that performs the JOIN, so it reads the same snapshot as
    the JOIN (one statement = one snapshot on PostgreSQL, MySQL/InnoDB and
    BigQuery). It is TRUE when the key is unique and raises otherwise — the
    scalar subquery returns two rows ("more than one row returned by a subquery"
    / "Subquery returns more than 1 row" / "Scalar subquery produced more than
    one element"), so the request fails instead of answering with fanned-out
    rows. It never filters: there is no value for which it is FALSE.

    Immutable relations (snapshot tables) need no in-statement half: nothing
    writes to them. ``None`` when there is nothing to guard."""
    preds = []
    for probe in probes or []:
        sql = probe.get("sql") if isinstance(probe, dict) else None
        if not sql or probe.get("immutable"):
            continue
        preds.append(
            f"(SELECT _appbi_dup FROM ({sql}) AS _appbi_kpg{len(preds)} UNION ALL SELECT 1) = 1"
        )
    return " AND\n  ".join(preds) or None


def verify_key_probes(probes: Iterable[dict], *, ds_type: str, config, namespace: str = "",
                      use_cache: bool = True) -> None:
    """Run each probe and raise ValueError on a duplicate or failure. Only a
    probe of an IMMUTABLE relation (``probe["immutable"]``) reads or writes the
    shared cache; a live relation is probed every time."""
    from app.core.config import settings
    from app.services import query_cache
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.semantic_join_resolver import SemanticRefusal

    ttl = float(getattr(settings, "LIVE_QUERY_CACHE_TTL", 300) or 300)
    for probe in probes or []:
        sql = probe.get("sql")
        if not sql:
            raise SemanticRefusal(
                f"Không xác minh được khoá của quan hệ {probe.get('label')} trên '{probe.get('view')}': "
                f"{probe.get('reason') or 'không dựng được truy vấn kiểm tra'} — truy vấn bị từ chối "
                "thay vì giả định khoá là duy nhất.",
                SemanticRefusal.UNVERIFIABLE_KEY,
            )
        cacheable = use_cache and bool(probe.get("immutable"))
        key = "keyprobe::" + hashlib.sha256(f"{namespace}|{ds_type}|{sql}".encode("utf-8")).hexdigest()
        cached = query_cache.get_shared(key) if cacheable else None
        if cached is not None and "dup" in cached:
            dup = bool(cached["dup"])
        else:
            try:
                _cols, rows, _ms = DataSourceConnectionService.execute_query(ds_type, config, sql, limit=None)
            except Exception as exc:  # noqa: BLE001 — unverifiable is refused, below
                logger.warning("[keyprobe] could not verify %s: %s", probe.get("label"), exc)
                raise SemanticRefusal(
                    f"Không xác minh được khoá của quan hệ {probe.get('label')} "
                    f"({', '.join(probe.get('columns') or [])} trên '{probe.get('view')}') là duy nhất — "
                    "truy vấn bị từ chối thay vì giả định N:1. "
                    f"Chi tiết: {type(exc).__name__}: {str(exc)[:200]}",
                    SemanticRefusal.UNVERIFIABLE_KEY,
                ) from exc
            dup = bool(rows)
            if cacheable:
                query_cache.set_shared(key, {"dup": dup}, ttl)
        if dup:
            raise SemanticRefusal(
                f"Quan hệ {probe.get('label')} khai báo N:1 nhưng khoá "
                f"({', '.join(probe.get('columns') or [])}) trên '{probe.get('view')}' có giá trị bị lặp — "
                "JOIN sẽ nhân dòng và số sẽ sai, nên truy vấn bị từ chối. Làm sạch dữ liệu, "
                "đổi khoá, hoặc khai báo lại cardinality trong Data Model.",
                SemanticRefusal.FANOUT_RISK,
            )
